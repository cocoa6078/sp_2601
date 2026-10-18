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
  // lastLeg：最後の信号（その先に信号が無い）か。止まるのが避けられないとき早歩きで近づくのは最後の信号だけ（改善ループ c08b）
  return { runner: config.runner, control: config.control, signal: s.signal, route: { crossingX: s.atM, goalX: config.goalM, lastLeg: i >= config.signals.length - 1 } };
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
    // 1 tick で横断終了と次の信号をまたぐと、次の信号を判定できないため。
    const minGapM = speedsOf(config).vFast * DT;
    need(i === 0 || s.atM > prevEnd + minGapM, `signals[${i}].atM は前の横断終了から1 tick の最大移動距離（${minGapM}m）より離す`);
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
const EDGE_SLICE_S = 2;   // 青の時間帯の端に着く候補の幅（秒）
const LOOKAHEAD_SIGNALS = 2;   // 先読みの試走で見る、今の信号より先の信号の数
const ESTIMATE_SIGNALS = 4;    // 先読みの見積もりで見る、今の信号より先の信号の数（計算の上限）
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
// untilJ（含まない）より先の信号は見ない。上限が無いと、信号が多い経路で分岐が爆発的に増える（Codex サイクル2の指摘）。
// 試走（先の2信号）より広い ESTIMATE_SIGNALS 個までにして、5信号までの経路では従来と同じ結果にする（改善ループ c09m）
function futureCost(config, sp, j, fromX, tLo, tHi, untilJ = config.signals.length) {
  if (j >= config.signals.length || j >= untilJ) return [0, 0, 0];
  const sig = config.signals[j];
  const endX = sig.atM + sig.signal.crossingM;
  const { out, aFast, aSlow } = passIntervals(sig, sp, fromX, tLo, tHi);
  let best = null;
  for (const w of out) {
    const [vHi, vLo] = w.kind === 'walk' ? [sp.vWalkFast, sp.vWalkSlow] : [sp.vFast, sp.vRunSlow];
    const rest = futureCost(config, sp, j + 1, endX, w.lo + sig.signal.crossingM / vHi, w.hi + sig.signal.crossingM / vLo, untilJ);
    const cost = [rest[0], rest[1] + (w.kind === 'noMargin' ? 1 : 0), rest[2]];
    if (!best || better(cost, best)) best = cost;
  }
  if (best) return best;
  // 止まる：最も遅く着いて、次の青の始まりで再開する
  const g = safeGreenWindows(sig.signal, aFast, aFast + 2 * sig.signal.cycleS, { startMarginS: 0, endMarginS: 0, crossTimeS: 0 })[0];
  const resumeT = g ? g.startT : aSlow;
  const rest = futureCost(config, sp, j + 1, endX, resumeT + sig.signal.crossingM / sp.vBase, resumeT + sig.signal.crossingM / sp.vBase, untilJ);
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
      const rest = futureCost(config, sp, i + 1, endX, a + sig.signal.crossingM / vHi, a + sig.signal.crossingM / vLo, i + 1 + ESTIMATE_SIGNALS);
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
  for (const s of same.filter((s) => s.a < best.a).sort((x, y) => y.a - x.a)) {
    if (s.a < lo - SAMPLE_S - 1e-9) break;
    lo = s.a;
  }
  for (const s of same.filter((s) => s.a > best.a).sort((x, y) => x.a - y.a)) {
    if (s.a > hi + SAMPLE_S + 1e-9) break;
    hi = s.a;
  }
  const windowOf = (lo, hi) => ({ startT: round6(lo === best.w.lo ? best.w.lo : lo - SAMPLE_S / 2), endT: round6(Math.min(best.w.hi, hi + SAMPLE_S)) });
  // 早歩きは窓の中央を目指すので、広げると停止が増えることがある。最善点の近傍も試走の候補に残す。
  const sampleWindow = windowOf(Math.max(lo, best.a - SAMPLE_S), Math.min(hi, best.a + SAMPLE_S));
  return { ...windowOf(lo, hi), sampleWindow, cost: best.cost };
}

// 先読みの試走：時間帯 win を今の信号に固定し、先の LOOKAHEAD_SIGNALS 個の信号を渡り終えるまで走らせて比べる（ゴールまで走らせると候補が多いとき重い）。
// bound（それまでの最善の結果）があれば、途中の結果が最善より悪くなった時点で打ち切って null を返す。止まる回数・停止時間・
// 渡り終えが青でない回数・早歩きの時間は走るほど増える一方なので、途中で最善を上回った候補は最後まで走っても最善より良くならない
// （選ばれる候補は打ち切らない場合と同じ。計算を軽くする。改善ループ c18c）
const worseThan = (part, bound) => {
  for (let k = 0; k < part.length; k++) if (Math.abs(part[k] - bound[k]) > 1e-9) return part[k] > bound[k];
  return false;
};
// 試走の途中経過（origin から）：止まる回数・停止時間（待機中の分を含む）・渡り終えが青でない回数・早歩きの時間
const partOf = (s, origin, notGreen) => [s.stops, s.stopTimeS + (s.phase === 'waiting' ? s.t - s.stoppedAtT : 0), notGreen, (s.walkTimeS ?? 0) - (origin.walkTimeS ?? 0)];
const notGreenSince = (events, from) => events.slice(from).filter((e) => e.type === 'crossEnd' && e.color !== 'green').length;

// 試走は2段に分ける（改善ループ c18d：同じ候補の2通りの試走で①を共有し、計算を軽くする。結果は分けない場合と同じ）
// ① 時間帯 win を指定して、今の信号を渡り終えるまで（bound を上回ったら null）
function runCurrentLeg(origin, config, win, bound) {
  const i = origin.signalIndex;
  const maxTick = origin.tick + 36000;
  let s = origin;
  let notGreen = 0, seen = origin.events.length;
  while (!s.finished && s.tick < maxTick && s.signalIndex === i) {
    s = advance(s, config, win);
    if (bound) {
      for (; seen < s.events.length; seen++) if (s.events[seen].type === 'crossEnd' && s.events[seen].color !== 'green') notGreen++;
      if (worseThan(partOf(s, origin, notGreen), bound)) return null;
    }
  }
  return s;
}
// ② ①の後から、先の LOOKAHEAD_SIGNALS 個の信号を渡り終えるまで走らせた結果 [停止回数, 停止時間, 渡り終えが青でない回数, 早歩きの時間, 打ち切った時刻]
// 先の信号では、実際の走行と同じく先読みで時間帯を選ぶ（ただし試走はせず、見積もりの時間帯を使う。改善ループ c04b）。
// pure なら先の信号でも時間帯を指定しない（「今の信号だけを見る」選び方そのもの。改善ループ c18a）
function rolloutFrom(origin, from, config, win, pure, bound) {
  const i = origin.signalIndex;
  const lastIndex = i + LOOKAHEAD_SIGNALS;
  const maxTick = origin.tick + 36000;
  let s = from;
  let notGreen = notGreenSince(from.events, origin.events.length), seen = from.events.length;
  // 途中経過は増える一方なので、①の途中で最善を上回っていれば①の終わりでも上回っている
  if (bound && worseThan(partOf(s, origin, notGreen), bound)) return null;
  let legIdx = i, legWin = null;
  while (!s.finished && s.tick < maxTick && s.signalIndex <= lastIndex) {
    if (s.signalIndex !== legIdx) {
      legIdx = s.signalIndex;
      const est = !pure && s.phase === 'approach' ? planArriveWindow(s, config) : null;
      legWin = est ? { startT: est.startT, endT: est.endT } : null;
    }
    s = advance(s, config, s.signalIndex === i ? win : legWin);
    if (bound) {
      for (; seen < s.events.length; seen++) if (s.events[seen].type === 'crossEnd' && s.events[seen].color !== 'green') notGreen++;
      if (worseThan(partOf(s, origin, notGreen), bound)) return null;
    }
  }
  const waiting = s.phase === 'waiting' ? s.t - s.stoppedAtT : 0;
  // 同じなら早歩きの短いほう（改善ループ c04a：止まらないことと引き換えに早歩きが増えていたため）
  const walkS = (s.walkTimeS ?? 0) - (origin.walkTimeS ?? 0);
  return [s.stops, s.stopTimeS + waiting, notGreenSince(s.events, origin.events.length), walkS, s.t];
}
// ①の後の状態のうち、その先の走り方と試走の結果を決めるもの（同じなら②も同じ結果になる）
const legStateKey = (s, origin) => JSON.stringify([s.signalIndex, s.tick, s.t, s.x, s.bpm, s.targetBpm, s.mode, s.reason, s.phase, s.stops, s.stopTimeS, s.stoppedAtT,
  s.finished, s.gait, s.targetSpeedKmh, s.walkUntilX, s.walkTimeS, notGreenSince(s.events, origin.events.length)]);

// 信号 i に向かい始めたときに1回だけ、着く時間帯を決める（渡るまで固定）。
// 候補（絞らない／最善点の近傍／最善の連続した時間帯／届く安全な青の時間帯それぞれ）を、実際に core で走らせて比べ、
// 停止回数 → 停止時間 → 渡り終えが青でない回数 → 打ち切った時刻 の順で最も良いものを選ぶ。同じなら絞らない
function chooseLegWindow(state, config) {
  const i = state.signalIndex;
  const sp = speedsOf(config);
  const sig = config.signals[i];
  const cands = [null];
  const addWindow = (win) => {
    if (!cands.some((w) => w && w.startT === win.startT && w.endT === win.endT)) cands.push(win);
  };
  const est = planArriveWindow(state, config);
  if (est) {
    addWindow(est.sampleWindow);
    addWindow({ startT: est.startT, endT: est.endT });
  }
  const { out } = passIntervals(sig, sp, state.x, state.t, state.t, state.gait === 'walk' ? sp.baseBpm - sp.c.maxDeltaBpm : state.bpm);
  for (const w of out) {
    if (w.kind === 'noMargin') continue;
    addWindow({ startT: round6(w.lo), endT: round6(w.hi) });
    // 時間帯全体を指定すると core は通常BPMに近い所に着くので、次の信号に合う「端」の到着も試す（早い側・遅い側）
    if (w.hi - w.lo > 2 * EDGE_SLICE_S) {
      addWindow({ startT: round6(w.lo), endT: round6(w.lo + EDGE_SLICE_S) });
      addWindow({ startT: round6(w.hi - EDGE_SLICE_S), endT: round6(w.hi) });
    }
  }
  // 各候補を、先の信号を「見積もりの時間帯」で走らせる試走と「今の信号だけを見る」選び方で走らせる試走の両方で比べ、良いほうで評価する。
  // 見積もりの時間帯だけの試走は、先の信号の走り方を実際より悪く見積もることがあり、先読みの方が今の信号だけより多く止まる経路や、
  // 細かく探せば止まらずに済む経路を取りこぼしていた（課題 #18。改善ループ c18a：90経路で 75→62回）
  let best = null;
  const tried = new Set();
  for (const win of cands) {
    const after = runCurrentLeg(state, config, win, best?.cost);
    if (!after) continue;   // 今の信号を渡り終えるまでに最善を上回った（どちらの試走でも最善より良くならない）
    const key = legStateKey(after, state);
    if (tried.has(key)) continue;   // 前の候補と同じ状態で渡り終えた（その先の試走も同じ結果で、最善は変わらない）
    tried.add(key);
    for (const pure of [false, true]) {
      const cost = rolloutFrom(state, after, config, win, pure, best?.cost);
      if (cost && (!best || better(cost, best.cost))) best = { win, cost };
    }
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
  if (config.control?.enabled !== false && config.lookahead !== false && i < n - 1 && state.phase === 'approach' && (!plan || plan.signalIndex !== i)) {
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
    signalId: sig.id, type, t, atM: sig.atM, color: signalAt(sig.signal, t).color,
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
  // core は青の始まりのごくわずか後（+1e-9）に再開する。停止時間から復元した時刻は境界で「赤」と判定されうるので、1e-6 だけ後ろにする
  if (state.phase === 'waiting' && next.phase !== 'waiting') {
    const resumeT = state.stoppedAtT + (next.stopTimeS - state.stopTimeS) + 1e-6;
    ev('waitEnd', resumeT, { waitS: resumeT - state.stoppedAtT }); ev('crossStart', resumeT, { afterWait: true });
    moveT = resumeT; moveX = sig.atM; moveV = baseV;
  }
  // 横断を渡り終えた（point モデルでも atM + crossingM の位置）
  const endX = sig.atM + sig.signal.crossingM;
  let out = next;
  // 渡り終えの判定は、core が横断に入った後（approach・waiting 以外）だけ。横断長0の信号では横断地点＝渡り終え地点なので、
  // 位置の足し算の誤差で core が「着いた」と判定する前に次の信号へ切り替えてしまい、赤でも素通りしていた（改善ループ c03・Codex の指摘から）。
  // 待機から再開したときは、待機位置が渡り終え地点と同じでも切り替える
  if (next.phase !== 'approach' && next.phase !== 'waiting' && next.x >= endX - 1e-9 && (state.x < endX || state.phase === 'waiting')) {
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
