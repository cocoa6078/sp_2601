// RUNWAVE route-core — 複数の信号を順番に通過する連続走行（DOM非依存、ブラウザ/Node 両対応の ES module）
// 1信号の core（runwave-core.js）の step をそのまま使い、信号を渡り終えたら「今の信号」と「横断地点の位置」だけを
// 次の信号に差し替える。時刻・位置・BPM・歩き方・集計は交差点ごとに初期化しない。契約は core/CONTRACT-route.md
import { CORE_VERSION, DT, createRun, step, summarize, signalAt, speedOf, validateConfig } from './runwave-core.js';

export const ROUTE_VERSION = '0.1.0';
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

// 0.1秒進めた新しい状態を返す（入力の state は変更しない。ゴール後は同じ state）
export function stepRoute(state, config) {
  if (state.finished) return state;
  const i = state.signalIndex;
  const n = config.signals.length;
  const leg = legConfig(config, i);
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
  const movingV = (s) => (s.gait === 'walk' ? s.targetSpeedKmh / 3.6 : speedOf(config.runner.strideM, s.bpm));

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
      const resumeT = state.t + DT - (next.x - sig.atM) / baseV;
      const arriveT = resumeT - (next.stopTimeS - state.stopTimeS);
      ev('arrive', arriveT, { passed: false }); ev('waitStart', arriveT); ev('waitEnd', resumeT, { waitS: resumeT - arriveT }); ev('crossStart', resumeT, { afterWait: true });
      moveT = resumeT; moveX = sig.atM; moveV = baseV;
    } else {
      const arriveT = state.t + (sig.atM - state.x) / stepV;
      ev('arrive', arriveT, { passed: true }); ev('crossStart', arriveT);
    }
  }
  // 待っていて再開した（再開時刻 = 待ち始め + 増えた停止時間。再開後は通常BPMの走り）
  if (state.phase === 'waiting' && next.phase !== 'waiting') {
    const resumeT = state.stoppedAtT + (next.stopTimeS - state.stopTimeS);
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
