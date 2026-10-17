// RUNWAVE core — 信号・位置・停止・統計（DOM非依存、ブラウザ/Node 両対応の ES module）
// 単位: 時間=秒(s)、距離=m、BPM=歩/分（1拍=1歩。心拍数ではない）
// 契約の詳細は core/CONTRACT.md（作業票 v4 準拠）

export const CORE_VERSION = '0.3.0';
export const DT = 0.1;          // 固定刻み（秒）。可変 dt には対応しない
const TPS = 10;                 // ticks per second（t = tick / TPS で浮動小数誤差を避ける）

export const MODES = ['normal', 'adjusting', 'stopRecommended', 'waiting', 'finished'];
export const MODE_LABELS = {
  normal: '通常', adjusting: 'テンポ調整中', stopRecommended: '停止推奨', waiting: '信号待ち', finished: 'ゴール',
};
// 歩行者信号: 青 → 青点滅 → 赤（日本の歩行者信号に「黄」は無い。仕様の yellowS は青点滅の秒数として扱う）
export const COLOR_LABELS = { green: '青', flashing: '青点滅', red: '赤' };
export const CROSSING_MODELS = ['point', 'length'];
// 目標を選んだ理由（approach 中）
// none: 調整不要 / signal: 信号に合わせて調整中 / noMargin: 余裕付きの計画は無いが通常BPMで青に着く見込み
// unavoidable: どの候補でも青に着けない（停止推奨）/ off: 制御OFF（常に）/ waiting: 横断地点で信号待ち / passed: 横断地点を通過済み
export const REASONS = ['none', 'signal', 'noMargin', 'unavoidable', 'off', 'waiting', 'passed'];

export const DEFAULT_CONTROL = {
  enabled: true,
  crossingModel: 'point', // point: 横断地点での通過判定（v4 の現行 CONTRACT）／length: 横断長を渡り切る時間も扱う（拡張・要合意）
  startMarginS: 3,     // 青開始から何秒後以降に着くよう狙うか
  endMarginS: 5,       // 青終了の何秒前までに通過（length では渡り切り）するよう狙うか
  maxDeltaBpm: 20,     // 通常BPM±この範囲
  stepBpm: 2,          // 1回の変更量の上限
  stepIntervalS: 4,    // BPM を変えられる間隔（変更は t = 4k 秒のときだけ）
  targetIntervalS: 1,  // 目標BPMを再計算する間隔
  // 予測の範囲は固定せず、横断地点までの距離から決める（最も遅い候補でも必ず到着まで予測する）
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
// 浮動小数の誤差は安全側に倒す：境界のごく手前（EPS 以内）は次の区間とみなすが、
// 赤→青の境界だけは「まだ赤」とする（青を早く始めない）。丸めは表示用の remainingS だけ
const EPS = 1e-9;
export function signalAt(signal, t) {
  validateSignal(signal);
  need(isNum(t), 't は数');
  const { cycleS, greenS, yellowS } = signal;
  // 正の剰余に周期を足すと、周期のごく手前が周期ちょうど（＝青の始まり）に丸まるので、負のときだけ足す
  let pos = (t + signal.phaseS) % cycleS;
  if (pos < 0) pos += cycleS;
  if (pos >= cycleS) pos = cycleS;   // 足し算で周期に丸まったら「赤の終わり」とする（安全側）
  let color, endPos;
  if (pos < greenS - EPS) { color = 'green'; endPos = greenS; }
  else if (pos < greenS + yellowS - EPS) { color = 'flashing'; endPos = greenS + yellowS; }
  else { color = 'red'; endPos = cycleS; }
  return { color, label: COLOR_LABELS[color], remainingS: round6(Math.max(0, endPos - pos)), cycleProgress: Math.min(pos / cycleS, 1) };
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

// 目標BPM c で走ったときの横断地点到着を、段階調整込みで予測する（limitRate と同じ規則を内側で計算）
// 予測の範囲は距離から決める：BPM は常に baseLow 以上なので、残り距離 ÷ 最も遅い速度 で必ず着く
function predictArrival(state, config, c, ctl) {
  const { strideM } = config.runner;
  const { crossingX } = config.route;
  const target = clamp(c, ctl.baseLow, ctl.baseHigh);
  let tick = state.tick, x = state.x, bpm = state.bpm;
  const limit = tick + Math.ceil(((crossingX - x) / speedOf(strideM, ctl.baseLow)) * TPS) + 2 * TPS;
  while (tick < limit) {
    if (tick !== 0 && tick % ctl.intervalTicks === 0) bpm += clamp(target - bpm, -ctl.stepBpm, ctl.stepBpm);
    bpm = clamp(bpm, ctl.baseLow, ctl.baseHigh);
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
  const modeFor = (target) => (target === base && state.bpm === base ? 'normal' : 'adjusting');
  // 横断中は進入時のBPMを保持（length モデルの横断時間の予測を崩さない）。横断後は通常BPMへ段階的に戻す
  const passedReason = ctl.enabled ? 'passed' : 'off';
  if (state.phase === 'crossing') return { targetBpm: state.bpm, mode: modeFor(state.bpm), reason: passedReason };
  if (state.phase !== 'approach') return { targetBpm: base, mode: modeFor(base), reason: passedReason };
  if (!ctl.enabled) return { targetBpm: base, mode: modeFor(base), reason: 'off' };

  const { signal } = config;
  const now = state.tick / TPS;
  // fromT は現在時刻（到着時刻にすると切り詰め＋丸めで境界判定がずれる）
  const windowsUntil = (untilT, crossTimeS) => safeGreenWindows(signal, now, untilT, { ...ctl, crossTimeS });
  const feasible = (c) => {
    const p = predictArrival(state, config, c, ctl);
    if (!p) return false;
    return windowsUntil(p.arriveT, crossTimeOf(config, p.bpm)).some((w) => p.arriveT >= w.startT && p.arriveT < w.endT);
  };

  // 到着時刻は目標BPMが高いほど早い（単調）。最速と最遅の到着の間に安全な窓が無ければ、どの候補も不可
  const pFast = predictArrival(state, config, ctl.baseHigh, ctl);
  const pSlow = predictArrival(state, config, ctl.baseLow, ctl);
  const anyWindow = !pFast || !pSlow
    || windowsUntil(pSlow.arriveT, crossTimeOf(config, pFast.bpm)).some((w) => w.endT > pFast.arriveT && w.startT <= pSlow.arriveT);

  // 候補: 通常BPMとの差が小さい順、同じ差なら低い方（減速寄り）。毎回選び直し、通常に近い目標で済むならそちらへ
  let chosen = null;
  if (anyWindow) {
    const cands = [base];
    for (let d = 1; d <= ctl.maxDeltaBpm; d++) cands.push(base - d, base + d);
    chosen = cands.find(feasible) ?? null;
  }
  if (chosen !== null) {
    // 同じ差の候補が両方使えるときは、今の目標を保つ（加速と減速を行き来しない）
    if (state.targetBpm !== chosen && Math.abs(state.targetBpm - base) === Math.abs(chosen - base) && feasible(state.targetBpm)) {
      chosen = state.targetBpm;
    }
    return { targetBpm: chosen, mode: modeFor(chosen), reason: chosen === base ? 'none' : 'signal' };
  }
  // 余裕付きの計画は無い。通常BPMで青に着けるなら通常どおり（余裕なし）、着けなければ停止推奨
  // 停止推奨: 通常BPMへ段階的に戻しながら横断地点まで進み、非青ならそこで止まる
  const pBase = predictArrival(state, config, base, ctl);
  if (pBase && canEnter(signal, pBase.arriveT, crossTimeOf(config, pBase.bpm))) {
    return { targetBpm: base, mode: modeFor(base), reason: 'noMargin' };
  }
  return { targetBpm: base, mode: 'stopRecommended', reason: 'unavoidable' };
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
    reason: controlOf(config).enabled ? 'none' : 'off',
    stops: 0, stopTimeS: 0, stoppedAtT: null,   // stopTimeS は再開済みの停止の合計
    minBpm: base, maxBpm: base, totalBpmChange: 0,
    // リズムの指標: 基準BPMからのずれ×時間（BPM·秒）、基準から外れて走った時間、止まらずに走れた最長時間
    deviationBpmS: 0, offBaseTimeS: 0, runStartT: 0, longestRunS: 0,
    finished: false, finishTimeS: null,
    history: [],
  };
  return { ...s, history: [snapshot(s)] };
}

const snapshot = (s) => ({ t: s.t, x: s.x, bpm: s.bpm, targetBpm: s.targetBpm, mode: s.mode, reason: s.reason, phase: s.phase, color: s.signal.color });

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
      stopTimeS: round6(s.stopTimeS + (resumeT - s.stoppedAtT)), stoppedAtT: null, runStartT: resumeT };
    moveS = t + DT - resumeT;
  }

  // 目標の再計算（1秒ごと）と BPM の変更（4秒ごと）は別の周期
  if (s.tick % ctl.targetTicks === 0) {
    const d = chooseTarget(s, config);
    s.targetBpm = d.targetBpm;
    s.mode = d.mode;
    s.reason = d.reason;
  }
  if (s.phase === 'crossing') s.targetBpm = s.bpm;
  const prevBpm = s.bpm;
  s.bpm = limitRate(s.bpm, s.targetBpm, s, config);
  s.totalBpmChange += Math.abs(s.bpm - prevBpm);
  if (s.phase !== 'approach') s.mode = s.bpm === base ? 'normal' : 'adjusting';

  const v = speedOf(runner.strideM, s.bpm);
  let nx = s.x + v * moveS;
  const len = crossingLength(config);
  // このステップで最後に動いた区間（ゴール時刻を到達した瞬間で求めるため）
  let seg = { startT: t + DT - moveS, startX: s.x, v, devBpm: Math.abs(s.bpm - base) };
  let movedS = moveS;
  const devBpm = seg.devBpm;

  // 1ステップで横断地点をまたぐ場合も、到達した時刻の信号で判定する
  if (s.phase === 'approach' && nx >= route.crossingX) {
    const arriveT = t + (route.crossingX - s.x) / v;
    if (canEnter(signal, arriveT, len / v)) {
      s.phase = 'crossing';
    } else {
      s.minBpm = Math.min(s.minBpm, s.bpm);
      s.maxBpm = Math.max(s.maxBpm, s.bpm);
      s.stops += 1;
      movedS = arriveT - t;
      s.longestRunS = round6(Math.max(s.longestRunS, arriveT - s.runStartT));
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
        s.runStartT = resumeT;
        seg = { startT: resumeT, startX: route.crossingX, v: speedOf(runner.strideM, base), devBpm: 0 };
        nx = route.crossingX + seg.v * (t + DT - resumeT);
      }
    }
  }
  s.deviationBpmS += devBpm * movedS;
  if (devBpm > 0) s.offBaseTimeS += movedS;
  if (s.phase === 'crossing' && nx >= route.crossingX + len) s.phase = 'after';
  s.x = nx;
  if (s.phase !== 'waiting') {
    s.minBpm = Math.min(s.minBpm, s.bpm);
    s.maxBpm = Math.max(s.maxBpm, s.bpm);
  }
  // 位置の足し算の誤差でゴール判定が1ステップ遅れないよう、ごくわずかな誤差は許す
  if (s.phase !== 'waiting' && nx >= route.goalX - 1e-6) {
    s.x = route.goalX;
    s.phase = 'finished';
    s.mode = 'finished';
    s.finished = true;
    // ゴールした瞬間の時刻（ステップの終わりではなく）
    s.finishTimeS = round6(seg.startT + Math.max(0, route.goalX - seg.startX) / seg.v);
    s.longestRunS = round6(Math.max(s.longestRunS, s.finishTimeS - s.runStartT));
    // ゴールの後（ステップの残り）まで数えた分を、リズムの指標から引く
    const afterGoalS = Math.max(0, t + DT - s.finishTimeS);
    s.deviationBpmS -= seg.devBpm * afterGoalS;
    if (seg.devBpm > 0) s.offBaseTimeS -= afterGoalS;
  } else if (s.phase !== 'waiting') {
    // 走っている間も、止まらずに走れている時間を更新する
    s.longestRunS = round6(Math.max(s.longestRunS, t + DT - s.runStartT));
  }
  // 理由を今の phase に合わせる（制御OFFは常に off）
  if (!ctl.enabled) s.reason = 'off';
  else if (s.phase === 'waiting') s.reason = 'waiting';
  else if (s.phase !== 'approach') s.reason = 'passed';
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
  // 青の始まりちょうどは誤差で「まだ赤」と判定されうる（signalAt は安全側）ので、ごくわずかに後ろへずらす
  const tg = from + toGreen + 1e-9;
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
    deviationBpmS: round6(s.deviationBpmS),
    offBaseTimeS: round6(s.offBaseTimeS),
    // 走行中に打ち切った場合は、最後の再開（またはスタート）からの時間も含める
    longestRunS: round6(s.finished || s.phase === 'waiting' ? s.longestRunS : Math.max(s.longestRunS, s.t - s.runStartT)),
    baseBpm: config.runner.baseBpm,
  };
}

// 同じ条件で通常（制御OFF）と RUNWAVE（制御ON）を比較。差は control.enabled だけ
export function compare(config, opts) {
  const withEnabled = (enabled) => ({ ...config, control: { ...(config.control || {}), enabled } });
  return { normal: simulate(withEnabled(false), opts).summary, runwave: simulate(withEnabled(true), opts).summary };
}
