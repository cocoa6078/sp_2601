// RUNWAVE core — 信号・位置・停止・統計（DOM非依存、ブラウザ/Node 両対応の ES module）
// 単位: 時間=秒(s)、距離=m、BPM=歩/分（1拍=1歩。心拍数ではない）
// 契約の詳細は core/CONTRACT.md

export const CORE_VERSION = '0.1.0';
export const DT = 0.1;          // 固定刻み（秒）
const TPS = 10;                 // ticks per second（t = tick / TPS で浮動小数誤差を避ける）

export const MODES = ['normal', 'adjusting', 'stopRecommended', 'waiting', 'goal'];
export const MODE_LABELS = {
  normal: '通常', adjusting: 'テンポ調整中', stopRecommended: '停止推奨', waiting: '信号待ち', goal: 'ゴール',
};
// 歩行者信号: 青 → 青点滅 → 赤（日本の歩行者信号に「黄」は無い。仕様の yellowS は青点滅の秒数として扱う）
export const COLOR_LABELS = { green: '青', flashing: '青点滅', red: '赤' };

export const DEFAULT_CONTROL = {
  enabled: true,
  startMarginS: 3,     // 青開始から何秒後以降に着くよう狙うか
  endMarginS: 5,       // 横断完了後に残す青の秒数
  maxDeltaBpm: 20,     // 通常BPM±この範囲
  stepBpm: 2,          // 1回の変更量の上限
  stepIntervalS: 4,    // 変更できる間隔（変更は t = 4k 秒のときだけ）
  horizonS: 240,       // 何秒先までの青を探すか
};

// ---------- 入力検証 ----------
const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isNonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function need(cond, msg) {
  if (!cond) throw new RangeError(msg);
}

export function validateConfig(config) {
  need(config && typeof config === 'object', 'config がありません');
  const { signal: s, runner: r, route } = config;
  need(s && r && route, 'config には signal・runner・route が必要です');
  need(isPos(s.cycleS), 'signal.cycleS は正の数');
  need(isNonNeg(s.greenS) && isNonNeg(s.yellowS) && isNonNeg(s.redS), 'signal の各秒数は0以上の数');
  need(Math.abs(s.greenS + s.yellowS + s.redS - s.cycleS) < 1e-9, 'greenS+yellowS+redS は cycleS と一致させる');
  need(Number.isFinite(s.phaseS), 'signal.phaseS は数');
  need(isNonNeg(s.crossingM), 'signal.crossingM は0以上の数（0 は点通過モデル）');
  need(isPos(r.strideM) && isPos(r.baseBpm), 'runner.strideM と runner.baseBpm は正の数');
  need(isPos(route.crossingX) && isPos(route.goalX), 'route.crossingX と route.goalX は正の数');
  need(route.goalX >= route.crossingX + s.crossingM, 'goalX は横断歩道の先（crossingX + crossingM 以上）');
  const c = controlOf(config);
  need(c.baseLow > 0, '通常BPM − maxDeltaBpm は正である必要があります');
  return true;
}

function controlOf(config) {
  const c = { ...DEFAULT_CONTROL, ...(config.control || {}) };
  const base = config.runner.baseBpm;
  return { ...c, baseLow: base - c.maxDeltaBpm, baseHigh: base + c.maxDeltaBpm, intervalTicks: Math.round(c.stepIntervalS * TPS) };
}

// ---------- F-01 ----------
export function calibrate({ distanceM, steps, timeS }) {
  need(isPos(distanceM) && isPos(steps) && isPos(timeS), 'distanceM・steps・timeS は正の数');
  const strideM = distanceM / steps;            // L = D/N
  const baseBpm = (60 * steps) / timeS;          // C0 = 60N/T
  const speedMps = (strideM * baseBpm) / 60;     // v0 = L·C0/60
  return { strideM, baseBpm, speedMps };
}

export const speedOf = (strideM, bpm) => (strideM * bpm) / 60;

export function requiredBpm(distanceM, strideM, arriveInS) {
  need(isNonNeg(distanceM) && isPos(strideM) && isPos(arriveInS), 'distanceM≥0、strideM>0、arriveInS>0');
  return (60 * distanceM) / (strideM * arriveInS); // 60D/(L·T)
}

// ---------- F-02 ----------
// 区間は半開: 青 [0, g) / 青点滅 [g, g+y) / 赤 [g+y, cycle)
export function signalAt(signal, t) {
  const { cycleS, greenS, yellowS } = signal;
  let pos = (((t + signal.phaseS) % cycleS) + cycleS) % cycleS;
  pos = Math.round(pos * 1e6) / 1e6;
  if (pos >= cycleS) pos = 0;
  let color, endPos;
  if (pos < greenS) { color = 'green'; endPos = greenS; }
  else if (pos < greenS + yellowS) { color = 'flashing'; endPos = greenS + yellowS; }
  else { color = 'red'; endPos = cycleS; }
  return { color, label: COLOR_LABELS[color], remainingS: round6(endPos - pos), cycleProgress: pos / cycleS };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

// ---------- F-03 ----------
// 横断に「進入してよい」時刻の窓: [青開始 + startMarginS, 青終了 − crossTimeS − endMarginS]
export function safeGreenWindows(signal, fromT, untilT, control = {}) {
  const startMarginS = control.startMarginS ?? DEFAULT_CONTROL.startMarginS;
  const endMarginS = control.endMarginS ?? DEFAULT_CONTROL.endMarginS;
  const crossTimeS = control.crossTimeS ?? 0;
  const { cycleS, greenS, phaseS } = signal;
  // 青開始時刻 = k·cycleS − phaseS
  const out = [];
  for (let k = Math.floor((fromT + phaseS) / cycleS) - 1; ; k++) {
    const gStart = k * cycleS - phaseS;
    if (gStart > untilT) break;
    const startT = gStart + startMarginS;
    const endT = gStart + greenS - crossTimeS - endMarginS;   // 窓は [startT, endT)
    // 範囲と重なる窓を、開始を fromT で切り詰めて返す
    if (endT > startT && endT > fromT && startT <= untilT) out.push({ startT: round6(Math.max(startT, fromT)), endT: round6(endT) });
  }
  return out;
}

// 停止線に時刻 t で着いたとき横断に進入できるか（通常/RUNWAVE 共通の規則）
// 青で、かつ残りの青のうちに横断を終えられること。青点滅・赤では進入しない。
export function canEnter(signal, t, crossTimeS) {
  const s = signalAt(signal, t);
  return s.color === 'green' && s.remainingS >= crossTimeS;
}

// ---------- F-04 ----------
// 変化は t = stepIntervalS の倍数のときだけ、1回 stepBpm 以内、通常BPM±maxDeltaBpm にクランプ
export function limitRate(bpm, targetBpm, state, config) {
  const c = controlOf(config);
  const target = clamp(targetBpm, c.baseLow, c.baseHigh);
  // 最初の変更は t = stepIntervalS（t = 0 では変えない）
  if (state.tick === 0 || state.tick % c.intervalTicks !== 0) return clamp(bpm, c.baseLow, c.baseHigh);
  const next = bpm + clamp(target - bpm, -c.stepBpm, c.stepBpm);
  return clamp(next, c.baseLow, c.baseHigh);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 目標BPM c で走ったときの停止線到着を、段階調整込みで予測する
function predictArrival(state, config, c, ctl) {
  const { strideM } = config.runner;
  const { crossingX } = config.route;
  let tick = state.tick, x = state.x, bpm = state.bpm;
  const limit = tick + ctl.horizonS * TPS;
  while (tick < limit) {
    bpm = limitRate(bpm, c, { tick }, config);
    const v = speedOf(strideM, bpm);
    const nx = x + v * DT;
    if (nx >= crossingX) return { arriveT: tick / TPS + (crossingX - x) / v, bpm };
    x = nx;
    tick++;
  }
  return null;
}

export function chooseTarget(state, config) {
  const ctl = controlOf(config);
  const base = config.runner.baseBpm;
  // 横断中は進入時のBPMを保持（横断時間の予測を崩さない）。横断後は通常BPMへ段階的に戻す
  if (state.phase === 'crossing') {
    return { targetBpm: state.bpm, mode: state.bpm === base ? 'normal' : 'adjusting' };
  }
  if (!ctl.enabled || state.phase !== 'approach') {
    return { targetBpm: base, mode: state.bpm === base ? 'normal' : 'adjusting' };
  }
  const { signal, runner } = config;
  const feasible = (c) => {
    const p = predictArrival(state, config, c, ctl);
    if (!p) return false;
    const crossTimeS = signal.crossingM / speedOf(runner.strideM, p.bpm);
    // fromT は現在時刻（到着時刻にすると切り詰め＋丸めで境界判定がずれる）
    const ws = safeGreenWindows(signal, state.tick / TPS, p.arriveT, { ...ctl, crossTimeS });
    return ws.some((w) => p.arriveT >= w.startT && p.arriveT < w.endT);
  };
  // 現在の目標がまだ有効なら維持（4秒ごとの再計算で目標が揺れないように）
  if (state.targetBpm !== base && state.mode === 'adjusting' && feasible(state.targetBpm)) {
    return { targetBpm: state.targetBpm, mode: 'adjusting' };
  }
  // 候補: 通常BPMとの差が小さい順、同じ差なら低い方（減速寄り）
  const cands = [base];
  for (let d = 1; d <= ctl.maxDeltaBpm; d++) cands.push(base - d, base + d);
  for (const c of cands) {
    if (feasible(c)) return { targetBpm: c, mode: c === base && state.bpm === base ? 'normal' : 'adjusting' };
  }
  return { targetBpm: base, mode: 'stopRecommended' };
}

// ---------- 走行 ----------
export function createRun(config) {
  validateConfig(config);
  const base = config.runner.baseBpm;
  const s = {
    tick: 0, t: 0, x: 0,
    bpm: base, targetBpm: base,
    mode: 'normal',
    phase: 'approach',          // approach | waiting | crossing | after | goal
    signal: signalAt(config.signal, 0),
    stops: 0, stopTimeS: 0, stoppedAtT: null,   // stopTimeS は再開済みの停止の合計
    minBpm: base, maxBpm: base, totalBpmChange: 0,
    finished: false, finishTimeS: null,
    history: [],
  };
  return { ...s, history: [snapshot(s)] };
}

const snapshot = (s) => ({ t: s.t, x: s.x, bpm: s.bpm, targetBpm: s.targetBpm, mode: s.mode, phase: s.phase, color: s.signal.color });

// 入力 state は変更せず、dt 進めた新しい state を返す
export function step(state, config) {
  if (state.finished) return state;
  const ctl = controlOf(config);
  const { signal, runner, route } = config;
  const base = runner.baseBpm;
  const t = state.tick / TPS;
  let s = { ...state };

  if (s.phase === 'waiting') {
    // 再開は通常BPMへ即時（段階調整の例外。停止中は走行テンポの制限対象外）
    if (canEnter(signal, t, signal.crossingM / speedOf(runner.strideM, base))) {
      s = { ...s, phase: 'crossing', bpm: base, targetBpm: base, mode: 'normal',
        stopTimeS: round6(s.stopTimeS + (t - s.stoppedAtT)), stoppedAtT: null };
    } else {
      return finishTick(s, config);
    }
  }

  if (s.tick % ctl.intervalTicks === 0) {
    const d = chooseTarget(s, config);
    s.targetBpm = d.targetBpm;
    s.mode = d.mode;
  }
  if (s.phase === 'crossing') s.targetBpm = s.bpm;
  const prevBpm = s.bpm;
  s.bpm = limitRate(s.bpm, s.targetBpm, s, config);
  s.totalBpmChange += Math.abs(s.bpm - prevBpm);
  if (s.phase !== 'approach' && s.mode !== 'goal') s.mode = s.bpm === base ? 'normal' : 'adjusting';

  const v = speedOf(runner.strideM, s.bpm);
  let nx = s.x + v * DT;

  if (s.phase === 'approach' && nx >= route.crossingX) {
    const arriveT = t + (route.crossingX - s.x) / v;
    if (canEnter(signal, arriveT, signal.crossingM / v)) {
      s.phase = 'crossing';
    } else {
      nx = route.crossingX;
      s.phase = 'waiting';
      s.mode = 'waiting';
      s.stops += 1;
      s.stoppedAtT = round6(arriveT);
    }
  }
  if (s.phase === 'crossing' && nx >= route.crossingX + signal.crossingM) s.phase = 'after';
  s.x = nx;
  if (s.phase !== 'waiting') {
    s.minBpm = Math.min(s.minBpm, s.bpm);
    s.maxBpm = Math.max(s.maxBpm, s.bpm);
  }
  if (nx >= route.goalX) {
    s.x = route.goalX;
    s.phase = 'goal';
    s.mode = 'goal';
    s.finished = true;
    s.finishTimeS = (s.tick + 1) / TPS;
  }
  return finishTick(s, config);
}

function finishTick(s, config) {
  const tick = s.tick + 1;
  const t = tick / TPS;
  const next = { ...s, tick, t, signal: signalAt(config.signal, t) };
  if (tick % TPS === 0 || next.finished) next.history = [...s.history, snapshot(next)];
  return next;
}

// 終了まで走らせて最終 state と集計を返す
export function simulate(config, { maxTimeS = 1800 } = {}) {
  let s = createRun(config);
  const maxTick = maxTimeS * TPS;
  while (!s.finished && s.tick < maxTick) s = step(s, config);
  return { state: s, summary: summarize(s, config) };
}

export function summarize(s, config) {
  const ctl = controlOf(config);
  return {
    enabled: ctl.enabled,
    finished: s.finished,
    stops: s.stops,
    stopTimeS: s.stopTimeS,
    totalTimeS: s.finishTimeS,
    minBpm: s.minBpm,
    maxBpm: s.maxBpm,
    totalBpmChange: s.totalBpmChange,
    baseBpm: config.runner.baseBpm,
  };
}

// 同じ条件で通常（制御OFF）と RUNWAVE（制御ON）を比較
export function compare(config, opts) {
  const withEnabled = (enabled) => ({ ...config, control: { ...(config.control || {}), enabled } });
  return { normal: simulate(withEnabled(false), opts).summary, runwave: simulate(withEnabled(true), opts).summary };
}
