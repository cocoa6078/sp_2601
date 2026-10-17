// RUNWAVE route-core — 複数の信号を順番に通過する連続走行（DOM非依存、ブラウザ/Node 両対応の ES module）
// 1信号の core（runwave-core.js）の step をそのまま使い、信号を渡り終えたら「今の信号」と「横断地点の位置」だけを
// 次の信号に差し替える。時刻・位置・BPM・歩き方・集計は交差点ごとに初期化しない。契約は core/CONTRACT-route.md
import { CORE_VERSION, DT, DEFAULT_CONTROL, createRun, step, summarize, signalAt, speedOf, safeGreenWindows, validateConfig } from './runwave-core.js';

export const ROUTE_VERSION = '0.2.0';
export const EVENT_TYPES = ['arrive', 'waitStart', 'waitEnd', 'crossStart', 'crossEnd'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const round6 = (v) => Math.round(v * 1e6) / 1e6;
function need(cond, msg) {
  if (!cond) throw new RangeError(msg);
}

// i 番目の信号を判定に使う、1信号の core 用の config（横断地点 = atM、ゴール = 経路のゴール）
function legConfig(config, i) {
  const s = config.signals[Math.min(i, config.signals.length - 1)];
  return { runner: config.runner, control: config.control, signal: s.signal, route: { crossingX: s.atM, goalX: config.goalM } };
}

export function validateRouteConfig(config) {
  need(isObj(config), 'config がありません');
  need(isObj(config.runner) && (config.control === undefined || isObj(config.control)), 'config には runner（と control）が必要です');
  need(isPos(config.goalM), 'goalM（ゴールの位置）は正の数');
  need(Array.isArray(config.signals) && config.signals.length > 0, 'signals は1つ以上の配列');
  const ids = new Set();
  let prevEnd = 0;
  config.signals.forEach((s, i) => {
    need(isObj(s) && typeof s.id === 'string' && s.id.length > 0, `signals[${i}].id は文字列`);
    need(!ids.has(s.id), `signals の id が重複: ${s.id}`);
    ids.add(s.id);
    need(isPos(s.atM), `signals[${i}].atM（横断地点の位置）は正の数`);
    need(isObj(s.signal), `signals[${i}].signal がありません`);
    need(s.atM > prevEnd, `signals[${i}].atM は前の信号の横断の先（atM + crossingM より先）にする`);
    validateConfig(legConfig(config, i));   // 信号の形・横断長・ゴールの位置などは既存 core の検証を使う
    prevEnd = s.atM + s.signal.crossingM;
  });
  need(config.goalM > prevEnd, 'goalM は最後の信号の横断の先にする');
  return true;
}

export function createRouteRun(config) {
  validateRouteConfig(config);
  const s = createRun(legConfig(config, 0));
  return { ...s, signalIndex: 0, nextSignalId: config.signals[0].id, events: [] };
}

// ---------- 先読み（今の信号だけでなく、先の信号も見て今の信号に着く時間帯を選ぶ） ----------
// 信号に向かい始めたときに1回、着く時間帯の候補を作り（下の見積もり＋届く安全な青の時間帯）、実際に core で走らせて比べて選ぶ。
// 選んだ時間帯は route.arriveWindow として core の chooseTarget に渡し、その中で core がいつもどおり BPM を選ぶ
// （中で計画が立たなければ core は従来の選び方に戻る）。渡るまで固定する（毎秒選び直すと時間帯がずれて追いつけない）。
// 見積もり：速さの範囲と段階調整（stepIntervalS ごとに stepBpm）だけで、先の信号まで
// ①停止回数 ②余裕なしで通る回数 ③停止時間 が最も少なくなる到着時刻を探す（同じなら通常BPMで着く時刻に近いもの）
const SAMPLE_S = 0.5;
const better = (a, b) => {
  for (let k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) > 1e-9) return a[k] < b[k];
  return false;
};

function speedsOf(config) {
  const c = { ...DEFAULT_CONTROL, ...(config.control || {}) };
  const walk = { ...DEFAULT_CONTROL.walk, ...(c.walk || {}) };
  const { strideM, baseBpm } = config.runner;
  return {
    c, walk, strideM, baseBpm,
    vWalkFast: walk.maxKmh / 3.6,
    vBase: speedOf(strideM, baseBpm),
    vFast: speedOf(strideM, baseBpm + c.maxDeltaBpm),
    vRunSlow: speedOf(strideM, baseBpm - c.maxDeltaBpm),
    vWalkSlow: walk.minKmh / 3.6,
  };
}

// BPM b0 から目標 bT へ段階調整しながら距離 d を走る時間
function rampTime(sp, d, b0, bT) {
  let t = 0, x = 0, b = b0;
  const seg = sp.c.stepIntervalS;
  for (let k = 0; k < 10000; k++) {
    const v = speedOf(sp.strideM, b);
    if (x + v * seg >= d) return t + (d - x) / v;
    x += v * seg; t += seg;
    b += Math.max(-sp.c.stepBpm, Math.min(sp.c.stepBpm, bT - b));
  }
  return t;
}

// 時刻 [tLo, tHi] に位置 fromX を BPM b0 で出たとき、信号 sig で「止まらずに通れる」到着時刻の区間（走り・早歩き・余裕なし）
function passIntervals(sig, sp, fromX, tLo, tHi, b0 = sp.baseBpm) {
  const d = sig.atM - fromX;
  const aFast = tLo + rampTime(sp, d, b0, sp.baseBpm + sp.c.maxDeltaBpm);
  const aRunSlow = tHi + rampTime(sp, d, b0, sp.baseBpm - sp.c.maxDeltaBpm);
  const aSlow = sp.walk.enabled ? tHi + d / sp.vWalkSlow : aRunSlow;
  const len = sp.c.crossingModel === 'length' ? sig.signal.crossingM : 0;
  const m = { startMarginS: sp.c.startMarginS, endMarginS: sp.c.endMarginS };
  const clip = (ws, lo, hi, kind) => ws.map((w) => ({ lo: Math.max(w.startT, lo), hi: Math.min(w.endT, hi), kind })).filter((w) => w.hi > w.lo);
  const out = [
    ...clip(safeGreenWindows(sig.signal, aFast, aRunSlow, { ...m, crossTimeS: len / sp.vRunSlow }), aFast, aRunSlow, 'run'),
  ];
  if (sp.walk.enabled && aSlow > aRunSlow) {
    out.push(...clip(safeGreenWindows(sig.signal, aRunSlow, aSlow, { ...m, crossTimeS: sig.signal.crossingM / sp.vWalkSlow }), aRunSlow, aSlow, 'walk'));
  }
  // 余裕付きで通れないときだけ、余裕なし（青のうち）で通れる区間
  const noMargin = out.length ? [] : clip(safeGreenWindows(sig.signal, aFast, aRunSlow, { startMarginS: 0, endMarginS: 0, crossTimeS: len / sp.vRunSlow }), aFast, aRunSlow, 'noMargin');
  return { out: [...out, ...noMargin], aFast, aSlow };
}

// 信号 j 以降を、時刻 [tLo, tHi] に位置 fromX を出たとして、最善の [停止回数, 余裕なし回数, 停止時間] を見積もる
function futureCost(config, sp, j, fromX, tLo, tHi) {
  if (j >= config.signals.length) return [0, 0, 0];
  const sig = config.signals[j];
  const endX = sig.atM + sig.signal.crossingM;
  const { out, aFast, aSlow } = passIntervals(sig, sp, fromX, tLo, tHi);
  let best = null;
  for (const w of out) {
    const [vHi, vLo] = w.kind === 'walk' ? [sp.vWalkFast, sp.vWalkSlow] : [sp.vFast, sp.vRunSlow];
    const rest = futureCost(config, sp, j + 1, endX, w.lo + sig.signal.crossingM / vHi, w.hi + sig.signal.crossingM / vLo);
    const cost = [rest[0], rest[1] + (w.kind === 'noMargin' ? 1 : 0), rest[2]];
    if (!best || better(cost, best)) best = cost;
  }
  if (best) return best;
  // 止まる：最も遅く着いて、次の青の始まりで再開する
  const g = safeGreenWindows(sig.signal, aFast, aFast + 2 * sig.signal.cycleS, { startMarginS: 0, endMarginS: 0, crossTimeS: 0 })[0];
  const resumeT = g ? g.startT : aSlow;
  const rest = futureCost(config, sp, j + 1, endX, resumeT + sig.signal.crossingM / sp.vBase, resumeT + sig.signal.crossingM / sp.vBase);
  return [rest[0] + 1, rest[1], rest[2] + Math.max(0, resumeT - Math.min(aSlow, resumeT))];
}

// 今の信号 i に着く時間帯の見積もり（先の信号まで見る）。候補が無ければ null
function planArriveWindow(state, config) {
  const i = state.signalIndex;
  const sp = speedsOf(config);
  if (!sp.c.enabled || i >= config.signals.length - 1 || state.phase !== 'approach') return null;
  const sig = config.signals[i];
  const now = state.t;
  const { out } = passIntervals(sig, sp, state.x, now, now, state.gait === 'walk' ? sp.baseBpm - sp.c.maxDeltaBpm : state.bpm);
  const endX = sig.atM + sig.signal.crossingM;
  const baseArrive = now + (sig.atM - state.x) / sp.vBase;
  // 到着時刻を SAMPLE_S ごとに試し、それぞれの先の見積もりを出す
  const samples = [];
  for (const w of out) {
    // 走りで渡るときは、着いたときの BPM のまま渡る（速さの幅を持たせる）。早歩きは早歩きの速さで渡る
    const [vHi, vLo] = w.kind === 'walk' ? [sp.vWalkFast, sp.vWalkSlow] : [sp.vFast, sp.vRunSlow];
    for (let a = w.lo; a < w.hi; a += SAMPLE_S) {
      const rest = futureCost(config, sp, i + 1, endX, a + sig.signal.crossingM / vHi, a + sig.signal.crossingM / vLo);
      samples.push({ a, w, cost: [rest[0], rest[1] + (w.kind === 'noMargin' ? 1 : 0), rest[2]] });
    }
  }
  if (!samples.length) return null;
  let best = samples[0];
  for (const s of samples) {
    if (better(s.cost, best.cost) || (!better(best.cost, s.cost) && Math.abs(s.a - baseArrive) < Math.abs(best.a - baseArrive))) best = s;
  }
  // 最善と同じ見積もりになる区間（同じ時間帯の中で連続する範囲）を、着いてよい時間帯として渡す
  const same = samples.filter((s) => s.w === best.w && !better(best.cost, s.cost));
  let lo = best.a, hi = best.a;
  for (const s of same.sort((x, y) => x.a - y.a)) {
    if (s.a < best.a && s.a >= lo - SAMPLE_S - 1e-9) lo = s.a;
  }
  for (const s of same.sort((x, y) => y.a - x.a)) {
    if (s.a > best.a && s.a <= hi + SAMPLE_S + 1e-9) hi = s.a;
  }
  return { startT: round6(lo === best.w.lo ? best.w.lo : lo - SAMPLE_S / 2), endT: round6(Math.min(best.w.hi, hi + SAMPLE_S)), cost: best.cost };
}

// 時間帯 win を今の信号に固定し、その先は今の信号だけを見る選び方でゴールまで走らせた結果 [停止回数, 停止時間]
function tryWindow(state, config, win) {
  const i = state.signalIndex;
  let s = state;
  const maxTick = s.tick + 36000;
  while (!s.finished && s.tick < maxTick) s = advance(s, config, s.signalIndex === i ? win : null);
  const waiting = s.phase === 'waiting' ? s.t - s.stoppedAtT : 0;
  return [s.stops, s.stopTimeS + waiting];
}

// 信号 i に向かい始めたときに1回だけ、着く時間帯を決める（渡るまで固定）。
// 候補（絞らない／見積もりで最善の時間帯／届く安全な青の時間帯それぞれ）を、実際に core で走らせて比べ、
// 停止回数 → 停止時間 の順で最も良いものを選ぶ。同じなら絞らない（今の信号だけを見る選び方と同じ）
function chooseLegWindow(state, config) {
  const i = state.signalIndex;
  const sp = speedsOf(config);
  const sig = config.signals[i];
  const cands = [null];
  const est = planArriveWindow(state, config);
  if (est) cands.push({ startT: est.startT, endT: est.endT });
  const { out } = passIntervals(sig, sp, state.x, state.t, state.t, state.gait === 'walk' ? sp.baseBpm - sp.c.maxDeltaBpm : state.bpm);
  for (const w of out) if (w.kind !== 'noMargin') cands.push({ startT: round6(w.lo), endT: round6(w.hi) });
  let best = null;
  for (const win of cands) {
    const cost = tryWindow(state, config, win);
    if (!best || better(cost, best.cost)) best = { win, cost };
  }
  return best.win;
}

// 0.1秒進めた新しい状態を返す（入力の state は変更しない。ゴール後は同じ state）
export function stepRoute(state, config) {
  if (state.finished) return state;
  const i = state.signalIndex;
  const n = config.signals.length;
  // 先読み（既定で有効。config.lookahead: false で今の信号だけを見る）
  let plan = state.plan ?? null;
  if (config.lookahead !== false && i < n - 1 && state.phase === 'approach' && (!plan || plan.signalIndex !== i)) {
    plan = { signalIndex: i, window: chooseLegWindow(state, config) };
  }
  const win = plan && plan.signalIndex === i ? plan.window : null;
  const next = advance(plan ? { ...state, plan } : state, config, win);
  return next;
}

// 1ステップ進める（win：今の信号に着く時間帯の指定。null なら今の信号だけを見る）
function advance(state, config, win) {
  if (state.finished) return state;
  const i = state.signalIndex;
  const n = config.signals.length;
  let leg = legConfig(config, i);
  if (win) leg = { ...leg, route: { ...leg.route, arriveWindow: win } };
  const next = step(state, leg);
  if (i >= n) return next;   // 全部の信号を渡った後はゴールまで走るだけ

  const sig = config.signals[i];
  const events = [];
  // 着いたとき・入ったときの歩き方（止まった瞬間に core は gait を run に戻すので、動いていた歩き方を使う）
  const movingGait = next.gait === 'walk' || (next.phase === 'waiting' && state.gait === 'walk') ? 'walk' : 'run';
  const ev = (type, t, extra = {}) => events.push({
    signalId: sig.id, type, t: round6(t), atM: sig.atM, color: signalAt(sig.signal, t).color,
    gait: type === 'waitEnd' || (type === 'crossStart' && extra.afterWait) ? 'run' : movingGait,
    ...(type === 'arrive' ? { passed: extra.passed } : {}),
    ...(type === 'waitEnd' ? { waitS: round6(extra.waitS) } : {}),
  });

  // このステップで実際に進んだ速さ（走りなら選ばれた bpm、早歩きならその速さ。早歩き→走りの切り替えは
  // 横断の終わり＝ちょうど渡り終えた瞬間なので、そこまでは早歩きの速さ）
  const baseV = speedOf(config.runner.strideM, config.runner.baseBpm);
  const stepV = next.gait === 'walk' ? next.targetSpeedKmh / 3.6
    : state.gait === 'walk' ? state.targetSpeedKmh / 3.6
    : speedOf(config.runner.strideM, next.bpm);
  // このステップの中で、動き始めた時刻と位置（待機から再開したときは再開の瞬間・横断地点）
  let moveT = state.t, moveX = state.x, moveV = stepV;

  // 横断地点に着いた（止まった／止まらずに入った）
  if (state.phase === 'approach' && next.phase !== 'approach') {
    if (next.phase === 'waiting') {
      ev('arrive', next.stoppedAtT, { passed: false });
      ev('waitStart', next.stoppedAtT);
    } else if (next.stops > state.stops) {
      // 止まった同じステップの中で青になって再開した（再開後は通常BPMの走り）
      const resumeT = state.t + DT - (next.x - sig.atM) / baseV + 1e-6;
      const arriveT = resumeT - (next.stopTimeS - state.stopTimeS);
      ev('arrive', arriveT, { passed: false }); ev('waitStart', arriveT); ev('waitEnd', resumeT, { waitS: resumeT - arriveT }); ev('crossStart', resumeT, { afterWait: true });
      moveT = resumeT; moveX = sig.atM; moveV = baseV;
    } else {
      const arriveT = state.t + (sig.atM - state.x) / stepV;
      ev('arrive', arriveT, { passed: true }); ev('crossStart', arriveT);
    }
  }
  // 待っていて再開した（再開時刻 = 待ち始め + 増えた停止時間。再開後は通常BPMの走り）
  // core は青の始まりのごくわずか後（+1e-9）に再開する。丸めた時刻だと境界で「赤」と判定されるので、1e-6 だけ後ろにする
  if (state.phase === 'waiting' && next.phase !== 'waiting') {
    const resumeT = state.stoppedAtT + (next.stopTimeS - state.stopTimeS) + 1e-6;
    ev('waitEnd', resumeT, { waitS: resumeT - state.stoppedAtT }); ev('crossStart', resumeT, { afterWait: true });
    moveT = resumeT; moveX = sig.atM; moveV = baseV;
  }
  // 横断を渡り終えた（point モデルでも atM + crossingM の位置）
  const endX = sig.atM + sig.signal.crossingM;
  let out = next;
  if (state.x < endX && next.x >= endX - 1e-9 && next.phase !== 'waiting') {
    ev('crossEnd', Math.min(moveT + Math.max(0, endX - moveX) / moveV, state.t + DT));
    // 次の信号へ。判定に使う信号と横断地点だけを差し替え、時刻・位置・BPM・歩き方・集計は引き継ぐ
    const ni = i + 1;
    out = {
      ...next,
      signalIndex: ni,
      nextSignalId: ni < n ? config.signals[ni].id : null,
      ...(ni < n && !next.finished ? { phase: 'approach', signal: signalAt(config.signals[ni].signal, next.t) } : {}),
    };
  }
  return events.length ? { ...out, events: [...state.events, ...events] } : out;
}

export function simulateRoute(config, { maxTimeS = 3600 } = {}) {
  need(isPos(maxTimeS), 'maxTimeS は正の数');
  let s = createRouteRun(config);
  const maxTick = Math.ceil(maxTimeS / DT);
  while (!s.finished && s.tick < maxTick) s = stepRoute(s, config);
  return { state: s, summary: summarizeRoute(s, config) };
}

// 全体（既存の summary と同じ項目）と、信号ごとの集計
export function summarizeRoute(state, config) {
  const total = summarize(state, legConfig(config, config.signals.length - 1));
  const perSignal = config.signals.map((sig) => {
    const es = state.events.filter((e) => e.signalId === sig.id);
    const at = (type) => es.find((e) => e.type === type) ?? null;
    const ws = at('waitStart'), we = at('waitEnd'), cs = at('crossStart');
    return {
      signalId: sig.id, atM: sig.atM, meta: sig.meta ?? null,
      arriveT: at('arrive')?.t ?? null, crossStartT: cs?.t ?? null, crossEndT: at('crossEnd')?.t ?? null,
      waited: !!ws, waitS: ws ? round6((we?.t ?? state.t) - ws.t) : 0,
      colorAtArrive: at('arrive')?.color ?? null, colorAtCross: cs?.color ?? null,
      passed: at('arrive')?.passed ?? null, gaitAtCross: cs?.gait ?? null,
    };
  });
  return { ...total, coreVersion: CORE_VERSION, routeVersion: ROUTE_VERSION, signals: perSignal };
}

// 同じ経路で通常走行（制御OFF）と RUNWAVE（制御ON）を比べる。差は control.enabled だけ
export function compareRoute(config, opts) {
  const withEnabled = (enabled) => ({ ...config, control: { ...(config.control || {}), enabled } });
  const normal = simulateRoute(withEnabled(false), opts).summary, runwave = simulateRoute(withEnabled(true), opts).summary;
  // 既存の compare と同じ名前（normal / runwave）と、Web 側の名前（off / on）の両方で返す（中身は同じ）
  return { normal, runwave, off: normal, on: runwave };
}
