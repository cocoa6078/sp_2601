// RUNWAVE core — 信号・位置・停止・統計（DOM非依存、ブラウザ/Node 両対応の ES module）
// 単位: 時間=秒(s)、距離=m、BPM=歩/分（1拍=1歩。心拍数ではない）
// 契約の詳細は core/CONTRACT.md（作業票 v4 準拠）

export const CORE_VERSION = '0.2.0';
export const DT = 0.1;          // 固定刻み（秒）。可変 dt には対応しない
const TPS = 10;                 // ticks per second（t = tick / TPS で浮動小数誤差を避ける）

export const MODES = ['normal', 'adjusting', 'stopRecommended', 'waiting', 'finished'];
export const MODE_LABELS = {
  normal: '通常', adjusting: 'テンポ調整中', stopRecommended: '停止推奨', waiting: '信号待ち', finished: 'ゴール',
};
// 歩行者信号: 青 → 青点滅 → 赤（日本の歩行者信号に「黄」は無い。仕様の yellowS は青点滅の秒数として扱う）
export const COLOR_LABELS = { green: '青', flashing: '青点滅', red: '赤' };
export const CROSSING_MODELS = ['point', 'length'];

export const DEFAULT_CONTROL = {
  enabled: true,
  crossingModel: 'point', // point: 横断地点での通過判定（v4 の現行 CONTRACT）／length: 横断長を渡り切る時間も扱う（拡張・要合意）
  startMarginS: 3,     // 青開始から何秒後以降に着くよう狙うか
  endMarginS: 5,       // 青終了の何秒前までに通過（length では渡り切り）するよう狙うか
  maxDeltaBpm: 20,     // 通常BPM±この範囲
  stepBpm: 2,          // 1回の変更量の上限
  stepIntervalS: 4,    // BPM を変えられる間隔（変更は t = 4k 秒のときだけ）
  targetIntervalS: 1,  // 目標BPMを再計算する間隔
  horizonS: 240,       // 何秒先までの青を探すか
};

// ---------- 入力検証 ----------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos = (v) => isNum(v) && v > 0;
const isNonNeg = (v) => isNum(v) && v >= 0;
// 秒数が dt の整数倍か（tick で正確に表せるか）
const isTickMultiple = (s) => isPos(s) && Math.abs(s * TPS - Math.round(s * TPS)) < 1e-9;

function need(cond, msg) {
  if (!cond) throw new RangeError(msg);
}

export function validateSignal(s) {
  need(s && typeof s === 'object', 'signal がありません');
  need(isPos(s.cycleS), 'signal.cycleS は正の数');
  need(isNonNeg(s.greenS) && isNonNeg(s.yellowS) && isNonNeg(s.redS), 'signal の各秒数は0以上の数');
  need(Math.abs(s.greenS + s.yellowS + s.redS - s.cycleS) < 1e-9, 'greenS+yellowS+redS は cycleS と一致させる');
  need(isNum(s.phaseS), 'signal.phaseS は数');
  need(isNonNeg(s.crossingM), 'signal.crossingM（横断長）は0以上の数');
  return true;
}

export function validateConfig(config) {
  need(config && typeof config === 'object', 'config がありません');
  const { signal: s, runner: r, route } = config;
  need(s && r && route, 'config には signal・runner・route が必要です');
  validateSignal(s);
  need(isPos(r.strideM) && isPos(r.baseBpm), 'runner.strideM と runner.baseBpm は正の数');
  need(isPos(route.crossingX) && isPos(route.goalX), 'route.crossingX（横断地点の位置）と route.goalX は正の数');
  need(config.dt === undefined || config.dt === DT, `dt は ${DT} 秒固定（可変 dt は未対応）`);
  const c = { ...DEFAULT_CONTROL, ...(config.control || {}) };
  need(typeof c.enabled === 'boolean', 'control.enabled は true/false');
  need(CROSSING_MODELS.includes(c.crossingModel), `control.crossingModel は ${CROSSING_MODELS.join(' / ')}`);
  need(isNonNeg(c.startMarginS) && isNonNeg(c.endMarginS), 'control の余裕秒数は0以上の数');
  need(isNonNeg(c.maxDeltaBpm) && isPos(c.stepBpm), 'control.maxDeltaBpm は0以上、stepBpm は正の数');
  need(isTickMultiple(c.stepIntervalS) && isTickMultiple(c.targetIntervalS), `stepIntervalS・targetIntervalS は ${DT} 秒の倍数の正の数`);
  need(isPos(c.horizonS), 'control.horizonS は正の数');
  need(r.baseBpm - c.maxDeltaBpm > 0, '通常BPM − maxDeltaBpm は正である必要があります');
  need(route.goalX > route.crossingX + crossingLength(config), 'goalX は横断の先（crossingX + 横断長 より先）');
  return true;
}

function controlOf(config) {
  const c = { ...DEFAULT_CONTROL, ...(config.control || {}) };
  const base = config.runner.baseBpm;
  return {
    ...c,
    baseLow: base - c.maxDeltaBpm, baseHigh: base + c.maxDeltaBpm,
    intervalTicks: Math.round(c.stepIntervalS * TPS),
    targetTicks: Math.round(c.targetIntervalS * TPS),
  };
}

// 横断長: point モデルでは 0（横断地点の通過だけを判定）
function crossingLength(config) {
  const model = config.control?.crossingModel ?? DEFAULT_CONTROL.crossingModel;
  return model === 'length' ? config.signal.crossingM : 0;
}
const crossTimeOf = (config, bpm) => crossingLength(config) / speedOf(config.runner.strideM, bpm);

// ---------- F-01 ----------
export function calibrate({ distanceM, steps, timeS }) {
  need(isPos(distanceM) && isPos(steps) && isPos(timeS), 'distanceM・steps・timeS は正の数');
  const strideM = distanceM / steps;            // L = D/N
  const baseBpm = (60 * steps) / timeS;          // C0 = 60N/T
  const speedMps = (strideM * baseBpm) / 60;     // v0 = L·C0/60
  return { strideM, baseBpm, speedMps };
}

export const speedOf = (strideM, bpm) => (strideM * bpm) / 60;

// 残り距離 distanceM を、到着までの残り秒 arriveInS で走るのに必要な一定BPM（絶対時刻ではなく残り秒を渡す）
// distanceM=0 は 0 を返す。arriveInS は正の数のみ（0以下は RangeError）
export function requiredBpm(distanceM, strideM, arriveInS) {
  need(isNonNeg(distanceM) && isPos(strideM) && isPos(arriveInS), 'distanceM≥0、strideM>0、arriveInS>0');
  return (60 * distanceM) / (strideM * arriveInS); // 60D/(L·T)
}

// ---------- F-02 ----------
// 区間は半開: 青 [0, g) / 青点滅 [g, g+y) / 赤 [g+y, cycle)
export function signalAt(signal, t) {
  validateSignal(signal);
  need(isNum(t), 't は数');
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
// 横断地点に「着いてよい」時刻の窓: [青開始 + startMarginS, 青終了 − crossTimeS − endMarginS)
// crossTimeS は point モデルでは 0、length モデルでは横断長 ÷ 速度
export function safeGreenWindows(signal, fromT, untilT, control = {}) {
  validateSignal(signal);
  need(isNum(fromT) && isNum(untilT) && untilT >= fromT, 'fromT・untilT は数で fromT ≤ untilT');
  // 省略（undefined）だけ既定値。null などの明示的な不正値は拒否する
  const pick = (k, d) => (control[k] === undefined ? d : control[k]);
  const startMarginS = pick('startMarginS', DEFAULT_CONTROL.startMarginS);
  const endMarginS = pick('endMarginS', DEFAULT_CONTROL.endMarginS);
  const crossTimeS = pick('crossTimeS', 0);
  need(isNonNeg(startMarginS) && isNonNeg(endMarginS) && isNonNeg(crossTimeS), '余裕秒数・crossTimeS は0以上の数');
  const { cycleS, greenS } = signal;
  // 位相を周期内に正規化（巨大な位相でもループ変数が整数精度を失わないように）
  const phaseS = ((signal.phaseS % cycleS) + cycleS) % cycleS;
  // 青開始時刻 = k·cycleS − phaseS
  const out = [];
  const k0 = Math.floor((fromT + phaseS) / cycleS) - 1;
  const maxK = k0 + Math.ceil((untilT - fromT) / cycleS) + 3;
  need(Number.isSafeInteger(k0) && Number.isSafeInteger(maxK), 'fromT・untilT が大きすぎます');
  for (let k = k0; k <= maxK; k++) {
    const gStart = k * cycleS - phaseS;
    if (gStart > untilT) break;
    const startT = gStart + startMarginS;
    const endT = gStart + greenS - crossTimeS - endMarginS;
    // 範囲と重なる窓を、開始を fromT で切り詰めて返す
    if (endT > startT && endT > fromT && startT <= untilT) out.push({ startT: round6(Math.max(startT, fromT)), endT: round6(endT) });
  }
  return out;
}

// 横断地点に時刻 t で着いたとき通過（進入）できるか（通常/RUNWAVE 共通の規則）
// 青であること。length モデルでは、さらに残りの青のうちに渡り切れること。青点滅・赤では通過しない
export function canEnter(signal, t, crossTimeS = 0) {
  need(isNonNeg(crossTimeS), 'crossTimeS は0以上の数');
  const s = signalAt(signal, t);
  return s.color === 'green' && s.remainingS >= crossTimeS;
}

// ---------- F-04 ----------
// 変化は t = stepIntervalS の倍数のときだけ、1回 stepBpm 以内、通常BPM±maxDeltaBpm にクランプ
export function limitRate(bpm, targetBpm, state, config) {
  need(isNum(bpm) && isNum(targetBpm), 'bpm・targetBpm は数');
  need(state && Number.isSafeInteger(state.tick) && state.tick >= 0, 'state.tick は0以上の整数');
  const c = controlOf(config);
  const target = clamp(targetBpm, c.baseLow, c.baseHigh);
  // 最初の変更は t = stepIntervalS（t = 0 では変えない）
  if (state.tick === 0 || state.tick % c.intervalTicks !== 0) return clamp(bpm, c.baseLow, c.baseHigh);
  const next = bpm + clamp(target - bpm, -c.stepBpm, c.stepBpm);
  return clamp(next, c.baseLow, c.baseHigh);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 目標BPM c で走ったときの横断地点到着を、段階調整込みで予測する
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
  // 横断中は進入時のBPMを保持（length モデルの横断時間の予測を崩さない）。横断後は通常BPMへ段階的に戻す
  if (state.phase === 'crossing') {
    return { targetBpm: state.bpm, mode: state.bpm === base ? 'normal' : 'adjusting' };
  }
  if (!ctl.enabled || state.phase !== 'approach') {
    return { targetBpm: base, mode: state.bpm === base ? 'normal' : 'adjusting' };
  }
  const { signal } = config;
  const feasible = (c) => {
    const p = predictArrival(state, config, c, ctl);
    if (!p) return false;
    // fromT は現在時刻（到着時刻にすると切り詰め＋丸めで境界判定がずれる）
    const ws = safeGreenWindows(signal, state.tick / TPS, p.arriveT, { ...ctl, crossTimeS: crossTimeOf(config, p.bpm) });
    return ws.some((w) => p.arriveT >= w.startT && p.arriveT < w.endT);
  };
  // 現在の目標がまだ有効なら維持（再計算のたびに目標が揺れないように）
  if (state.targetBpm !== base && state.mode === 'adjusting' && feasible(state.targetBpm)) {
    return { targetBpm: state.targetBpm, mode: 'adjusting' };
  }
  // 候補: 通常BPMとの差が小さい順、同じ差なら低い方（減速寄り）
  const cands = [base];
  for (let d = 1; d <= ctl.maxDeltaBpm; d++) cands.push(base - d, base + d);
  for (const c of cands) {
    if (feasible(c)) return { targetBpm: c, mode: c === base && state.bpm === base ? 'normal' : 'adjusting' };
  }
  // 候補なし: 停止推奨。通常BPMへ段階的に戻しながら横断地点まで進み、非青ならそこで止まる
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
    phase: 'approach',          // approach | waiting | crossing | after | finished
    signal: signalAt(config.signal, 0),
    stops: 0, stopTimeS: 0, stoppedAtT: null,   // stopTimeS は再開済みの停止の合計
    minBpm: base, maxBpm: base, totalBpmChange: 0,
    finished: false, finishTimeS: null,
    history: [],
  };
  return { ...s, history: [snapshot(s)] };
}

const snapshot = (s) => ({ t: s.t, x: s.x, bpm: s.bpm, targetBpm: s.targetBpm, mode: s.mode, phase: s.phase, color: s.signal.color });

// 入力 state は変更せず、dt 進めた新しい state を返す（ゴール後は同じ state を返す）
export function step(state, config) {
  if (state.finished) return state;
  const ctl = controlOf(config);
  const { signal, runner, route } = config;
  const base = runner.baseBpm;
  const t = state.tick / TPS;
  let s = { ...state };
  let moveS = DT;   // このステップで動く秒数（待機から途中で再開したときは残りの時間だけ）

  if (s.phase === 'waiting') {
    // 再開は通常BPMへ即時（段階調整・±20 の例外。待機中は bpm=0、速度0）
    // このステップの途中で青になる場合も、その時刻で再開する（短い青の取り逃しと停止時間の過大計上を防ぐ）
    const resumeT = resumeTimeWithin(signal, t, t + DT, crossTimeOf(config, base));
    if (resumeT === null) return finishTick(s, config);
    s = { ...s, phase: crossingLength(config) > 0 ? 'crossing' : 'after', bpm: base, targetBpm: base, mode: 'normal',
      stopTimeS: round6(s.stopTimeS + (resumeT - s.stoppedAtT)), stoppedAtT: null };
    moveS = t + DT - resumeT;
  }

  // 目標の再計算（1秒ごと）と BPM の変更（4秒ごと）は別の周期
  if (s.tick % ctl.targetTicks === 0) {
    const d = chooseTarget(s, config);
    s.targetBpm = d.targetBpm;
    s.mode = d.mode;
  }
  if (s.phase === 'crossing') s.targetBpm = s.bpm;
  const prevBpm = s.bpm;
  s.bpm = limitRate(s.bpm, s.targetBpm, s, config);
  s.totalBpmChange += Math.abs(s.bpm - prevBpm);
  if (s.phase !== 'approach') s.mode = s.bpm === base ? 'normal' : 'adjusting';

  const v = speedOf(runner.strideM, s.bpm);
  let nx = s.x + v * moveS;
  const len = crossingLength(config);

  // 1ステップで横断地点をまたぐ場合も、到達した時刻の信号で判定する
  if (s.phase === 'approach' && nx >= route.crossingX) {
    const arriveT = t + (route.crossingX - s.x) / v;
    if (canEnter(signal, arriveT, len / v)) {
      s.phase = 'crossing';
    } else {
      s.minBpm = Math.min(s.minBpm, s.bpm);
      s.maxBpm = Math.max(s.maxBpm, s.bpm);
      s.stops += 1;
      // 止まった同じステップの残り時間のうちに青になれば、そこで再開する
      const resumeT = resumeTimeWithin(signal, arriveT, t + DT, crossTimeOf(config, base));
      if (resumeT === null) {
        nx = route.crossingX;
        s.phase = 'waiting';
        s.mode = 'waiting';
        s.bpm = 0;
        s.stoppedAtT = round6(arriveT);
      } else {
        s.stopTimeS = round6(s.stopTimeS + (resumeT - arriveT));
        s.bpm = base;
        s.targetBpm = base;
        s.mode = 'normal';
        s.phase = len > 0 ? 'crossing' : 'after';
        nx = route.crossingX + speedOf(runner.strideM, base) * (t + DT - resumeT);
      }
    }
  }
  if (s.phase === 'crossing' && nx >= route.crossingX + len) s.phase = 'after';
  s.x = nx;
  if (s.phase !== 'waiting') {
    s.minBpm = Math.min(s.minBpm, s.bpm);
    s.maxBpm = Math.max(s.maxBpm, s.bpm);
  }
  if (s.phase !== 'waiting' && nx >= route.goalX) {
    s.x = route.goalX;
    s.phase = 'finished';
    s.mode = 'finished';
    s.finished = true;
    s.finishTimeS = (s.tick + 1) / TPS;
  }
  return finishTick(s, config);
}

// 待機中、[from, until) のうち最初に進入できる時刻（なければ null）
function resumeTimeWithin(signal, from, until, crossTimeS) {
  if (canEnter(signal, from, crossTimeS)) return from;
  const sig = signalAt(signal, from);
  // 次の青開始までの秒数（青なのに渡り切れない場合は次の周期の青）
  const toGreen = sig.color === 'red' ? sig.remainingS
    : sig.color === 'flashing' ? sig.remainingS + signal.redS
    : sig.remainingS + signal.yellowS + signal.redS;
  const tg = round6(from + toGreen);
  return tg < until && canEnter(signal, tg, crossTimeS) ? tg : null;
}

function finishTick(s, config) {
  const tick = s.tick + 1;
  const t = tick / TPS;
  const next = { ...s, tick, t, signal: signalAt(config.signal, t) };
  if (tick % TPS === 0 || next.finished) next.history = [...s.history, snapshot(next)];
  return next;
}

// 終了まで走らせて最終 state と集計を返す。BPM履歴は state.history（1秒ごと）
// maxTimeS までにゴールしなければ summary.termination = 'timeLimit'（到達不能と断定はしない）
export function simulate(config, { maxTimeS = 1800 } = {}) {
  need(isPos(maxTimeS), 'maxTimeS は正の数');
  let s = createRun(config);
  const maxTick = Math.ceil(maxTimeS * TPS);
  while (!s.finished && s.tick < maxTick) s = step(s, config);
  return { state: s, summary: summarize(s, config) };
}

export function summarize(s, config) {
  const ctl = controlOf(config);
  // 待機中に終わった場合は、進行中の待ち時間も含める
  const ongoing = s.phase === 'waiting' && s.stoppedAtT !== null ? s.t - s.stoppedAtT : 0;
  return {
    enabled: ctl.enabled,
    crossingModel: ctl.crossingModel,
    finished: s.finished,
    termination: s.finished ? 'finished' : 'timeLimit',
    stops: s.stops,
    stopTimeS: round6(s.stopTimeS + ongoing),
    totalTimeS: s.finishTimeS,
    minBpm: s.minBpm,
    maxBpm: s.maxBpm,
    totalBpmChange: s.totalBpmChange,
    baseBpm: config.runner.baseBpm,
  };
}

// 同じ条件で通常（制御OFF）と RUNWAVE（制御ON）を比較。差は control.enabled だけ
export function compare(config, opts) {
  const withEnabled = (enabled) => ({ ...config, control: { ...(config.control || {}), enabled } });
  return { normal: simulate(withEnabled(false), opts).summary, runwave: simulate(withEnabled(true), opts).summary };
}
