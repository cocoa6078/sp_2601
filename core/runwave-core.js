// RUNWAVE core — 信号・位置・停止・統計（DOM非依存、ブラウザ/Node 両対応の ES module）
// 単位: 時間=秒(s)、距離=m、BPM=歩/分（1拍=1歩。心拍数ではない）
// 契約の詳細は core/CONTRACT.md（作業票 v4 準拠）

import { runLowBpm, isEstimatedSignal } from './signal-input.js';

export const CORE_VERSION = '0.5.1';
export const DT = 0.1;          // 固定刻み（秒）。可変 dt には対応しない
const TPS = 10;                 // ticks per second（t = tick / TPS で浮動小数誤差を避ける）

export const MODES = ['normal', 'adjusting', 'walking', 'stopRecommended', 'waiting', 'finished'];
export const MODE_LABELS = {
  normal: '通常', adjusting: 'テンポ調整中', walking: '早歩き', stopRecommended: '停止推奨', waiting: '信号待ち', finished: 'ゴール',
};
// 歩行者信号: 青 → 青点滅 → 赤（日本の歩行者信号に「黄」は無い。仕様の yellowS は青点滅の秒数として扱う）
export const COLOR_LABELS = { green: '青', flashing: '青点滅', red: '赤' };
export const CROSSING_MODELS = ['point', 'length'];
// 目標を選んだ理由（approach 中）
// none: 調整不要 / signal: 信号に合わせて調整中 / noMargin: 余裕付きの計画は無いが通常BPMで青に着く見込み
// walkBridge: 走りでは間に合わないので早歩きでつなぐ（切り替える前の「走り続ける」段階も含む）
// unavoidable: どの候補でも青に着けない（停止推奨）/ off: 制御OFF（常に）/ waiting: 横断地点で信号待ち / passed: 横断地点を通過済み
// uncertain: 推定の信号データなので加速の提案を出さず、通常BPMのまま（要件 v2 SAFE-03。減速・早歩きは出す）
export const REASONS = ['none', 'signal', 'noMargin', 'walkBridge', 'unavoidable', 'off', 'waiting', 'passed', 'uncertain'];
// 歩き方（state.gait）: 'run' / 'walk'（早歩きが有効なときだけ state に出る）

export const DEFAULT_CONTROL = {
  enabled: true,
  crossingModel: 'point', // point: 横断地点での通過判定（v4 の現行 CONTRACT）／length: 横断長を渡り切る時間も扱う（拡張・要合意）
  startMarginS: 3,     // 青開始から何秒後以降に着くよう狙うか
  endMarginS: 8,       // 青終了の何秒前までに通過（length では渡り切り）するよう狙うか。15〜20m を渡り切る時間（約7〜9秒）を確保
  maxDeltaBpm: 20,     // 通常BPM±この範囲
  stepBpm: 2,          // 1回の変更量の上限
  stepIntervalS: 4,    // BPM を変えられる間隔（変更は t = 4k 秒のときだけ）
  targetIntervalS: 1,  // 目標BPMを再計算する間隔
  // 予測の範囲は横断地点までの距離から決める（最も遅い候補でも到着まで予測する）。
  // horizonS はその上限（計算の打ち切り）。既定は十分長く、通常の距離では効かない（v0.2.0 以前の 240 秒固定は廃止）
  horizonS: 3600,
  // 早歩きフェーズ：走り（通常BPM±maxDeltaBpm）では間に合わないときだけ、早歩きでつなぐ。enabled: false なら従来と完全に同じ
  walk: { enabled: true, minKmh: 5.3, maxKmh: 5.8, stepKmh: 0.1 },
};
const DEFAULT_WALK_STRIDE_M = 0.75;   // 早歩きの歩幅（歩/分の目安を出すため）【仮】

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
  need(isPos(c.horizonS), 'control.horizonS（予測の上限）は正の数');
  need(r.baseBpm - c.maxDeltaBpm > 0, '通常BPM − maxDeltaBpm は正である必要があります');
  need(c.walk && typeof c.walk === 'object', 'control.walk はオブジェクト');
  const w = { ...DEFAULT_CONTROL.walk, ...c.walk };
  need(typeof w.enabled === 'boolean', 'control.walk.enabled は true/false');
  need(isPos(w.minKmh) && isNum(w.maxKmh) && w.minKmh <= w.maxKmh, 'control.walk: 0 < minKmh ≤ maxKmh');
  need(isPos(w.stepKmh), 'control.walk.stepKmh は正の数');
  // 早歩きの速さを明示したときだけ、走りの下限より遅いことを求める。既定のままなら controlOf で切り詰める
  // （既定のままだと、走りの下限が 5.8km/h 以下のゆっくり走る人で RangeError になっていた。改善ループ c10a）
  const walkGiven = config.control?.walk ?? {};
  const walkSpeedGiven = walkGiven.maxKmh !== undefined || walkGiven.minKmh !== undefined;
  need(!walkSpeedGiven || w.maxKmh < speedOf(r.strideM, runLowBpm(r.baseBpm, c.maxDeltaBpm)) * 3.6, 'control.walk.maxKmh は走りの下限の速さより遅くする');
  need(r.walkStrideM === undefined || isPos(r.walkStrideM), 'runner.walkStrideM は正の数');
  // 早歩きでは point モデルでも横断長ぶん歩いて渡るので、ゴールは横断の先に置く
  need(!w.enabled || route.goalX > route.crossingX + s.crossingM, '早歩きを使うときは goalX を crossingX + 横断長 より先にする');
  need(route.goalX > route.crossingX + crossingLength(config), 'goalX は横断の先（crossingX + 横断長 より先）');
  return true;
}

function controlOf(config) {
  const c = { ...DEFAULT_CONTROL, ...(config.control || {}) };
  const base = config.runner.baseBpm;
  const walk = { ...DEFAULT_CONTROL.walk, ...(c.walk || {}) };
  // 走りの下限の速さ以上の早歩きは意味が無い（走ったほうが遅い）。早歩きの速さを走りの下限より遅い範囲に切り詰め、
  // 範囲が残らなければ早歩きを使わない（改善ループ c10a：ゆっくり走る人で既定の早歩きが RangeError になっていた）
  if (walk.enabled) {
    const runLowKmh = speedOf(config.runner.strideM, runLowBpm(base, c.maxDeltaBpm)) * 3.6;
    if (walk.maxKmh >= runLowKmh) {
      const n = Math.floor((runLowKmh - walk.minKmh) / walk.stepKmh - 1e-9);
      if (n < 0) walk.enabled = false;
      else walk.maxKmh = round6(walk.minKmh + n * walk.stepKmh);
    }
  }
  return {
    ...c,
    walk,
    baseLow: runLowBpm(base, c.maxDeltaBpm), baseHigh: base + c.maxDeltaBpm,
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
// 進入の判定に使う横断時間。青そのものが横断時間より短い信号では、渡り切れる青は来ないので、青の始まりに入る
// （以前は length モデルで待ち続けてゴールしなかった。改善ループ c11a：ファズテストで発見）
const enterTimeOf = (signal, crossTimeS) => Math.min(crossTimeS, Math.max(0, signal.greenS - 1e-6));

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
const PLAN_EPS = 1e-6;   // 計画（狙う到着時刻）が窓の端から取る余白（秒）
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
  const byDistance = Math.ceil(((crossingX - x) / speedOf(strideM, ctl.baseLow)) * TPS) + 2 * TPS;
  const limit = tick + Math.min(byDistance, Math.ceil(ctl.horizonS * TPS));
  while (tick < limit) {
    if (tick !== 0 && tick % ctl.intervalTicks === 0) bpm += clamp(target - bpm, -ctl.stepBpm, ctl.stepBpm);
    bpm = clamp(bpm, ctl.baseLow, ctl.baseHigh);
    const v = speedOf(strideM, bpm);
    // Keep tick-by-tick position additions, but reuse the speed until the next BPM update.
    const moveM = v * DT;
    const endTick = Math.min(limit, tick + ctl.intervalTicks - tick % ctl.intervalTicks);
    for (; tick < endTick; tick++) {
      const nx = x + moveM;
      if (nx >= crossingX) return { arriveT: tick / TPS + (crossingX - x) / v, bpm };
      x = nx;
    }
  }
  return null;
}

// ---------- 早歩きフェーズ ----------
// 早歩きは速度（km/h）で扱う（走りの「歩幅×BPM」は使わない）。歩/分は目安として 速さ×60÷walkStrideM で出す
const walkStrideOf = (config) => config.runner.walkStrideM ?? DEFAULT_WALK_STRIDE_M;
const walkBpmOf = (config, kmh) => round6(((kmh / 3.6) * 60) / walkStrideOf(config));
// 距離 distanceM を時速 kmh で歩く時間（秒）
const walkTimeOf = (distanceM, kmh) => distanceM / (kmh / 3.6);
function walkSpeedsOf(walk) {
  const n = Math.floor((walk.maxKmh - walk.minKmh) / walk.stepKmh + 1e-9);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(round6(walk.minKmh + i * walk.stepKmh));
  return out;
}
// 位置 fromX・時刻 fromT から一定の速さ kmh で歩いたときの到着と、着く安全な窓
// 早歩きは point モデルでも横断時間（横断長 ÷ 早歩きの速さ）を数える
function walkPlanAt(config, ctl, fromX, fromT, kmh) {
  const arriveT = fromT + walkTimeOf(config.route.crossingX - fromX, kmh);
  const crossTimeS = walkTimeOf(config.signal.crossingM, kmh);
  const w = safeGreenWindows(config.signal, fromT, arriveT, { ...ctl, crossTimeS })
    .find((win) => arriveT >= win.startT + PLAN_EPS && arriveT < win.endT - PLAN_EPS);
  return w ? { kmh, arriveT, window: w } : null;
}
// 使える早歩きの速さのうち、窓の中央に最も近く着くもの（ずれに強い）。同じくらいなら速いほう
// win（着いてよい時間帯の指定）があれば、まずその時間帯に近いもの（中なら0）を選ぶ。早歩きの速さは刻みがあるので、
// 狭い時間帯にぴったり入れないときも、近いものを選んで1秒ごとに寄せていく
function bestWalkAt(config, ctl, fromX, fromT, win = null) {
  let best = null;
  for (const kmh of walkSpeedsOf(ctl.walk)) {
    const p = walkPlanAt(config, ctl, fromX, fromT, kmh);
    if (!p) continue;
    const toWin = win ? Math.max(0, win.startT - p.arriveT, p.arriveT - win.endT) : 0;
    const off = toWin * 1e3 + Math.abs(p.arriveT - (p.window.startT + p.window.endT) / 2);
    if (!best || off < best.off - 1e-6 || (Math.abs(off - best.off) <= 1e-6 && kmh > best.kmh)) best = { ...p, off };
  }
  return best;
}
// 今すぐ歩いても間に合わないとき、走りの下限へ向けて走り続け、1秒ごとに「ここから早歩きで間に合うか」を調べる。
// 間に合う時点があれば、その時刻を返す（無ければ null）。「止まるのが避けられない」の判断から
// 「しばらく走ってから歩く」組み合わせが抜けていて、停止推奨を一時的に誤って出していた（改善ループ c14a）
function laterWalkPlan(state, config, ctl, win) {
  const { strideM } = config.runner;
  // 先に、早歩きで着ける時刻の範囲に安全な青があるかを大まかに調べる（最速の早歩きの短い横断時間で広めに取るので、
  // 間に合う時点を見落とさない）。あるときだけ細かく調べる（計算を軽くする。改善ループ c16）
  const vMin = ctl.walk.minKmh / 3.6, vMax = ctl.walk.maxKmh / 3.6;
  const now = state.tick / TPS;
  const coarse = safeGreenWindows(config.signal, now, now + (config.route.crossingX - state.x) / vMin + 1, { ...ctl, crossTimeS: config.signal.crossingM / vMax });
  if (!coarse.length) return null;
  let tick = state.tick, x = state.x, bpm = state.bpm;
  for (let i = 0; i < 36000; i++) {
    if (tick !== 0 && tick % ctl.intervalTicks === 0) bpm += clamp(ctl.baseLow - bpm, -ctl.stepBpm, ctl.stepBpm);
    bpm = clamp(bpm, ctl.baseLow, ctl.baseHigh);
    x += speedOf(strideM, bpm) * DT;
    tick++;
    if (x >= config.route.crossingX) return null;
    if (tick % ctl.targetTicks === 0) {
      const t = tick / TPS, d = config.route.crossingX - x;
      if (!coarse.some((cw) => cw.endT > t + d / vMax && cw.startT <= t + d / vMin)) continue;
      const w = bestWalkAt(config, ctl, x, t, win);
      if (w && (!win || (w.arriveT >= win.startT && w.arriveT < win.endT))) return { t: tick / TPS };
    }
  }
  return null;
}

// 走りの目標 c に向けて n tick 走り続けた後の位置（横断地点に着いたら crossed）
function runFor(state, config, c, ctl, n) {
  const { strideM } = config.runner;
  const target = clamp(c, ctl.baseLow, ctl.baseHigh);
  let tick = state.tick, x = state.x, bpm = state.bpm;
  for (let i = 0; i < n; i++) {
    if (tick !== 0 && tick % ctl.intervalTicks === 0) bpm += clamp(target - bpm, -ctl.stepBpm, ctl.stepBpm);
    bpm = clamp(bpm, ctl.baseLow, ctl.baseHigh);
    x += speedOf(strideM, bpm) * DT;
    tick++;
    if (x >= config.route.crossingX) return { crossed: true };
  }
  return { crossed: false, x, t: tick / TPS };
}

// route.arriveWindow（任意・{ startT, endT }）：着いてよい時間帯をさらに絞る（複数信号の先読みで使う）。
// その中で計画が立たなければ、絞らない場合の選び方に戻る。無ければ従来と同じ
export function chooseTarget(state, config) {
  const win = config.route?.arriveWindow;
  if (win) {
    const d = chooseTargetIn(state, config, win);
    if (d.reason !== 'unavoidable' && d.reason !== 'noMargin') return d;
  }
  return chooseTargetIn(state, config, null);
}

function chooseTargetIn(state, config, win) {
  const inWin = (t) => !win || (t >= win.startT && t < win.endT);
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
  // 時間帯の指定があっても、早歩きの速さの範囲で届かないなら従来の選び方に戻す（呼び出し元の chooseTarget が戻す）
  const walkReach = (fromX, fromT) => {
    const d = config.route.crossingX - fromX;
    return { lo: fromT + walkTimeOf(d, ctl.walk.maxKmh), hi: fromT + walkTimeOf(d, ctl.walk.minKmh) };
  };
  if (ctl.walk.enabled && state.gait === 'walk') {
    if (win) {
      const r = walkReach(state.x, now);
      if (r.lo >= win.endT || r.hi < win.startT) return { targetBpm: state.bpm, mode: 'stopRecommended', reason: 'unavoidable', targetSpeedKmh: state.targetSpeedKmh };
    }
    const w = bestWalkAt(config, ctl, state.x, now, win);
    if (w) return { targetBpm: walkBpmOf(config, w.kmh), mode: 'walking', reason: 'walkBridge', targetSpeedKmh: w.kmh };
    // 早歩きでも間に合わなくなった：今の速さのまま歩き、非青なら横断地点で止まる
    return { targetBpm: state.bpm, mode: 'stopRecommended', reason: 'unavoidable', targetSpeedKmh: state.targetSpeedKmh };
  }
  // fromT は現在時刻（到着時刻にすると切り詰め＋丸めで境界判定がずれる）
  const windowsUntil = (untilT, crossTimeS) => safeGreenWindows(signal, now, untilT, { ...ctl, crossTimeS });
  // 同じ目標の到着予測は1回だけ計算する（渡り切り優先の候補探しと従来の候補探しで同じ目標を2回予測していた。改善ループ c17p：結果は同じ）
  const arrivals = new Map();
  const arriveOf = (c) => {
    if (!arrivals.has(c)) arrivals.set(c, predictArrival(state, config, c, ctl));
    return arrivals.get(c);
  };
  const feasibleWith = (crossOf) => (c) => {
    const p = arriveOf(c);
    if (!p || !inWin(p.arriveT)) return false;
    // 窓の端ちょうどの到着は、信号判定（誤差を安全側に倒す）で非青になりうるので、ごくわずかな余白を取る。
    // 毎秒選び直すと到着が窓の端に寄るため、余裕0の設定で必要になる
    return windowsUntil(p.arriveT, crossOf(p.bpm))
      .some((w) => p.arriveT >= w.startT + PLAN_EPS && p.arriveT < w.endT - PLAN_EPS);
  };
  const feasible = feasibleWith((bpm) => crossTimeOf(config, bpm));
  // point モデルでも、その速さで横断を渡り切る青が残る時間帯に着ける候補があれば、そちらを優先する
  // （渡り終えが青でない横断を減らす。無ければ従来どおり「横断地点で青なら入れる」時間帯で選ぶ）
  const crossAwareFirst = crossingLength(config) === 0;
  const feasibleSafe = feasibleWith((bpm) => signal.crossingM / speedOf(config.runner.strideM, bpm));

  // 到着時刻は目標BPMが高いほど早い（単調）。最速と最遅の到着の間に安全な窓が無ければ、どの候補も不可
  const pFast = arriveOf(ctl.baseHigh);
  const pSlow = arriveOf(ctl.baseLow);
  const anyWindow = !pFast || !pSlow
    || windowsUntil(pSlow.arriveT, crossTimeOf(config, pFast.bpm)).some((w) => w.endT > pFast.arriveT && w.startT <= pSlow.arriveT);

  // 候補: 通常BPMとの差が小さい順、同じ差なら低い方（減速寄り）。毎回選び直し、通常に近い目標で済むならそちらへ
  let chosen = null;
  if (anyWindow) {
    const cands = [base];
    for (let d = 1; d <= ctl.maxDeltaBpm; d++) cands.push(base - d, base + d);
    chosen = (crossAwareFirst ? cands.find(feasibleSafe) : undefined) ?? cands.find(feasible) ?? null;
  }
  if (chosen !== null) {
    // 同じ差の候補が両方使えるときは、今の目標を保つ（加速と減速を行き来しない）。保つ目標も同じ基準で使えること
    const usable = crossAwareFirst && feasibleSafe(chosen) ? feasibleSafe : feasible;
    if (state.targetBpm !== chosen && Math.abs(state.targetBpm - base) === Math.abs(chosen - base) && usable(state.targetBpm)) {
      chosen = state.targetBpm;
    }
    // 推定の信号データでは加速の提案を出さない（位相が外れていると青の終わりに飛び込むことになるため。要件 v2 SAFE-03）
    if (chosen > base && isEstimatedSignal(signal)) return { targetBpm: base, mode: modeFor(base), reason: 'uncertain' };
    return { targetBpm: chosen, mode: modeFor(chosen), reason: chosen === base ? 'none' : 'signal' };
  }
  // 余裕付きの計画は無い。通常BPMで青に着けるなら通常どおり（余裕なし）、着けなければ停止推奨
  // 停止推奨: 通常BPMへ段階的に戻しながら横断地点まで進み、非青ならそこで止まる
  const pBase = arriveOf(base);
  // 時間帯の指定があるときは、余裕なしで通るより、指定の時間帯に早歩きで着くほうを先に調べる
  if (!win && pBase && canEnter(signal, pBase.arriveT, crossTimeOf(config, pBase.bpm))) {
    return { targetBpm: base, mode: modeFor(base), reason: 'noMargin' };
  }
  // 早歩きでつなぐ。走りを優先し、歩く距離を短くするため、
  // 「あと1回分（目標の再計算間隔）走ってからでも早歩きで間に合う」うちは走りの下限へ向けて走り続け、間に合わなくなる直前に切り替える
  // 時間帯の指定があるときは、走ってから歩く組み合わせで届くか（走りの下限で走り続けた到着〜今から最も遅く歩いた到着）
  const walkUseful = !win || (pSlow && pSlow.arriveT < win.endT && walkReach(state.x, now).hi >= win.startT);
  if (ctl.walk.enabled && walkUseful) {
    const nowWalk = bestWalkAt(config, ctl, state.x, now, win);
    if (nowWalk) {
      const after = runFor(state, config, ctl.baseLow, ctl, ctl.targetTicks);
      const later = after.crossed ? null : bestWalkAt(config, ctl, after.x, after.t, win);
      // 時間帯の指定があるときは、あと1回分走ってからでも、最も遅い早歩きで時間帯の中央以降に着けるかで判断する
      // （走るほど早く着く。走りすぎて時間帯より早く着くことになる前に切り替える。端ではなく中央を狙う）
      const reachLater = () => after.t + walkTimeOf(config.route.crossingX - after.x, ctl.walk.minKmh) >= (win.startT + win.endT) / 2;
      if (later && (win ? reachLater() : true)) {
        return { targetBpm: ctl.baseLow, mode: 'adjusting', reason: 'walkBridge' };
      }
      return { targetBpm: walkBpmOf(config, nowWalk.kmh), mode: 'walking', reason: 'walkBridge', targetSpeedKmh: nowWalk.kmh };
    }
    // 今すぐ歩いても間に合わないが、走りの下限でしばらく走ってから歩けば間に合う → 停止推奨にせず、走りの下限へ
    if (laterWalkPlan(state, config, ctl, win)) return { targetBpm: ctl.baseLow, mode: 'adjusting', reason: 'walkBridge' };
  }
  // 止まるのが避けられないときは、走りの下限へ段階的に下げながら近づく（遅く着くほど待つ時間が短い。
  // 改善ループ c07a・要合意：以前は通常BPMへ戻して早く着き、そのぶん長く待っていた。規則4の変更）
  // 早歩きが使えるなら、最も遅い早歩きで近づく（さらに遅く着いて待つ時間を減らす。改善ループ c08a・要合意）。
  // ただし先に信号がある区間（route.lastLeg === false）では使わない（遅れが後ろの信号に響くため。改善ループ c08b）
  if (ctl.walk.enabled && config.route?.lastLeg !== false) return { targetBpm: walkBpmOf(config, ctl.walk.minKmh), mode: 'stopRecommended', reason: 'unavoidable', targetSpeedKmh: ctl.walk.minKmh, walkSlow: true };
  return { targetBpm: ctl.baseLow, mode: 'stopRecommended', reason: 'unavoidable' };
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
  // 早歩きが有効なときだけ、歩き方・速さ・早歩きの集計を持つ（無効なら従来と同じ state の形）
  if (controlOf(config).walk.enabled) {
    Object.assign(s, {
      gait: 'run', speedMps: speedOf(config.runner.strideM, base), targetSpeedKmh: null, walkUntilX: null,
      walkCount: 0, walkTimeS: 0, walkDistanceM: 0, walkMinBpm: null, walkMaxBpm: null,
    });
  }
  return { ...s, history: [snapshot(s)] };
}

const snapshot = (s) => {
  const snap = { t: s.t, x: s.x, bpm: s.bpm, targetBpm: s.targetBpm, mode: s.mode, reason: s.reason, phase: s.phase, color: s.signal.color };
  if ('gait' in s) Object.assign(snap, { gait: s.gait, speedMps: s.speedMps });
  return snap;
};

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
    const resumeT = resumeTimeWithin(signal, t, t + DT, enterTimeOf(signal, crossTimeOf(config, base)));
    if (resumeT === null) return finishTick(s, config);
    s = { ...s, phase: crossingLength(config) > 0 ? 'crossing' : 'after', bpm: base, targetBpm: base, mode: 'normal',
      stopTimeS: round6(s.stopTimeS + (resumeT - s.stoppedAtT)), stoppedAtT: null, runStartT: resumeT };
    if ('gait' in s) Object.assign(s, { gait: 'run', targetSpeedKmh: null, walkUntilX: null });
    moveS = t + DT - resumeT;
  }

  // 目標の再計算（1秒ごと）と BPM の変更（4秒ごと）は別の周期
  if (s.tick % ctl.targetTicks === 0) {
    const d = chooseTarget(s, config);
    s.targetBpm = d.targetBpm;
    s.mode = d.mode;
    s.reason = d.reason;
    if ('gait' in s && s.phase === 'approach') {
      // 走り → 早歩きはすぐ切り替える（段階調整の例外。減速なので安全側）。早歩き中は速さを1秒ごとに見直す
      if ((d.mode === 'walking' || d.walkSlow) && s.gait !== 'walk') { s.gait = 'walk'; s.walkCount += 1; }
      if (s.gait === 'walk' && d.targetSpeedKmh != null) s.targetSpeedKmh = d.targetSpeedKmh;
    }
  }
  const walking = s.gait === 'walk';
  if (walking) {
    // 早歩き：速さで進む。歩/分は目安（速さ×60÷早歩きの歩幅）
    s.bpm = walkBpmOf(config, s.targetSpeedKmh);
    s.targetBpm = s.bpm;
    if (s.phase !== 'approach') s.mode = 'walking';
  } else {
    if (s.phase === 'crossing') s.targetBpm = s.bpm;
    const prevBpm = s.bpm;
    s.bpm = limitRate(s.bpm, s.targetBpm, s, config);
    s.totalBpmChange += Math.abs(s.bpm - prevBpm);
    if (s.phase !== 'approach') s.mode = s.bpm === base ? 'normal' : 'adjusting';
  }
  const moveBpm = s.bpm;

  const v = walking ? s.targetSpeedKmh / 3.6 : speedOf(runner.strideM, s.bpm);
  let nx = s.x + v * moveS;
  const len = crossingLength(config);
  // このステップで最後に動いた区間（ゴール時刻を到達した瞬間で求めるため）
  // リズムの指標（基準BPMからのずれ）は走りの間だけ数える
  let seg = { startT: t + DT - moveS, startX: s.x, v, devBpm: walking ? 0 : Math.abs(s.bpm - base) };
  let movedS = moveS;
  const devBpm = seg.devBpm;

  // 1ステップで横断地点をまたぐ場合も、到達した時刻の信号で判定する
  if (s.phase === 'approach' && nx >= route.crossingX) {
    const arriveT = t + (route.crossingX - s.x) / v;
    if (canEnter(signal, arriveT, enterTimeOf(signal, len / v))) {
      s.phase = 'crossing';
      // 早歩きで進入したら、point モデルでも横断長ぶんは同じ速さで歩いて渡る（横断中は速さを保つ）
      if (walking) s.walkUntilX = route.crossingX + signal.crossingM;
    } else {
      if (!walking) {
        s.minBpm = Math.min(s.minBpm, s.bpm);
        s.maxBpm = Math.max(s.maxBpm, s.bpm);
      }
      s.stops += 1;
      movedS = arriveT - t;
      s.longestRunS = round6(Math.max(s.longestRunS, arriveT - s.runStartT));
      // 止まった同じステップの残り時間のうちに青になれば、そこで再開する
      const resumeT = resumeTimeWithin(signal, arriveT, t + DT, enterTimeOf(signal, crossTimeOf(config, base)));
      if (resumeT === null) {
        nx = route.crossingX;
        s.phase = 'waiting';
        s.mode = 'waiting';
        s.bpm = 0;
        s.stoppedAtT = round6(arriveT);
        if ('gait' in s) Object.assign(s, { gait: 'run', targetSpeedKmh: null, walkUntilX: null });
      } else {
        s.stopTimeS = round6(s.stopTimeS + (resumeT - arriveT));
        s.bpm = base;
        s.targetBpm = base;
        s.mode = 'normal';
        s.phase = len > 0 ? 'crossing' : 'after';
        s.runStartT = resumeT;
        if ('gait' in s) Object.assign(s, { gait: 'run', targetSpeedKmh: null, walkUntilX: null });
        seg = { startT: resumeT, startX: route.crossingX, v: speedOf(runner.strideM, base), devBpm: 0 };
        nx = route.crossingX + seg.v * (t + DT - resumeT);
      }
    }
  }
  s.deviationBpmS += devBpm * movedS;
  if (devBpm > 0) s.offBaseTimeS += movedS;
  if (walking) {
    // 早歩きの集計（このステップで歩いた時間・距離）
    s.walkTimeS = round6(s.walkTimeS + movedS);
    s.walkDistanceM = round6(s.walkDistanceM + v * movedS);
    s.walkMinBpm = s.walkMinBpm === null ? moveBpm : Math.min(s.walkMinBpm, moveBpm);
    s.walkMaxBpm = s.walkMaxBpm === null ? moveBpm : Math.max(s.walkMaxBpm, moveBpm);
  }
  if (s.phase === 'crossing' && nx >= route.crossingX + len) s.phase = 'after';
  s.x = nx;
  if (s.phase !== 'waiting' && s.gait !== 'walk') {
    s.minBpm = Math.min(s.minBpm, s.bpm);
    s.maxBpm = Math.max(s.maxBpm, s.bpm);
  }
  // 横断を渡り終えたら、通常BPMの走りにすぐ戻す（「青で再開」と同じ例外）。
  // 渡り終えた瞬間でステップを分け、残りの時間は走りで進む（早歩きの時間・距離を多く数えない）
  if (s.gait === 'walk' && s.walkUntilX !== null && nx >= s.walkUntilX - 1e-9) {
    const endT = seg.startT + Math.max(0, s.walkUntilX - seg.startX) / seg.v;
    const runS = Math.max(0, t + DT - endT);
    s.walkTimeS = round6(s.walkTimeS - runS);
    s.walkDistanceM = round6(s.walkDistanceM - Math.max(0, nx - s.walkUntilX));
    const runV = speedOf(runner.strideM, base);
    nx = s.walkUntilX + runV * runS;
    s.x = nx;
    seg = { startT: endT, startX: s.walkUntilX, v: runV, devBpm: 0 };
    Object.assign(s, { gait: 'run', bpm: base, targetBpm: base, targetSpeedKmh: null, walkUntilX: null, mode: 'normal' });
  }
  if ('gait' in s) s.speedMps = s.phase === 'waiting' ? 0 : (s.gait === 'walk' ? s.targetSpeedKmh / 3.6 : speedOf(runner.strideM, s.bpm));
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
    // 早歩きが有効なときだけ
    ...('gait' in s ? { walkCount: s.walkCount, walkTimeS: s.walkTimeS, walkDistanceM: s.walkDistanceM, walkMinBpm: s.walkMinBpm, walkMaxBpm: s.walkMaxBpm } : {}),
  };
}

// 同じ条件で通常（制御OFF）と RUNWAVE（制御ON）を比較。差は control.enabled だけ
export function compare(config, opts) {
  const withEnabled = (enabled) => ({ ...config, control: { ...(config.control || {}), enabled } });
  return { normal: simulate(withEnabled(false), opts).summary, runwave: simulate(withEnabled(true), opts).summary };
}
