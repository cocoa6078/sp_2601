// 経路検索の試作：「止まりやすさ」の式で経路を比べる。信号の位相（いつ青になるか）は使わない。
// 止まりやすさ（1信号）= 1 −（着く時刻を動かせる幅 + 安全な青の長さ）÷ 周期（0〜1）。通常走行は（周期 − 青）÷ 周期。
// 経路の止まりやすさ = 信号ごとの止まりやすさの合計（止まる回数の見込み。信号どうしは独立とみなす近似）。
// 2段階（topK）では、式の上位だけを route-core で実際に走らせて決める（こちらは位相を使う）。
import { DEFAULT_CONTROL, speedOf, validateSignal } from '../runwave-core.js';
import { simulateRoute } from '../route-core.js';
import { enumerateRoutes } from './route-choice.js';

const need = (ok, message) => { if (!ok) throw new RangeError(message); };

function controlOf(control) {
  const c = { ...DEFAULT_CONTROL, ...(control || {}) };
  return { ...c, walk: { ...DEFAULT_CONTROL.walk, ...(c.walk || {}) } };
}

// BPM b0 から bT へ段階調整しながら distanceM を走る時間（core と同じく最初の変更は stepIntervalS 秒後）
function rampTimeS(distanceM, strideM, b0, bT, c) {
  let t = 0, x = 0, b = b0;
  for (let k = 0; k < 100000; k++) {
    const v = speedOf(strideM, b);
    if (x + v * c.stepIntervalS >= distanceM) return t + (distanceM - x) / v;
    x += v * c.stepIntervalS;
    t += c.stepIntervalS;
    b += Math.max(-c.stepBpm, Math.min(c.stepBpm, bT - b));
  }
  return t;
}

// 距離 distanceM の信号に着く時刻を動かせる幅。最も速い着き方（上限BPMへ段階調整）〜最も遅い走り（下限BPMへ段階調整）、
// 早歩きが有効なら最も遅い着き方は最初から最も遅い早歩き。通常BPMから始める
export function arrivalSpread(distanceM, runner, control) {
  need(Number.isFinite(distanceM) && distanceM > 0, 'distanceM は正の数');
  const c = controlOf(control);
  const base = runner.baseBpm;
  const fastestS = rampTimeS(distanceM, runner.strideM, base, base + c.maxDeltaBpm, c);
  const slowestRunS = rampTimeS(distanceM, runner.strideM, base, base - c.maxDeltaBpm, c);
  const slowestS = c.walk.enabled ? Math.max(slowestRunS, distanceM / (c.walk.minKmh / 3.6)) : slowestRunS;
  return { fastestS, slowestRunS, slowestS, runWidthS: slowestRunS - fastestS, widthS: slowestS - fastestS };
}

// 1信号の止まりやすさ（位相が分からないとき、適当なタイミングで近づいて止まる確率の近似）
export function stopRisk(signal, approachM, runner, control) {
  validateSignal(signal);
  const c = controlOf(control);
  if (!c.enabled) return (signal.cycleS - signal.greenS) / signal.cycleS;
  // length モデルでは、渡り切る時間ぶん安全な青が短くなる（通常BPMの速さで近似）
  const crossS = c.crossingModel === 'length' ? signal.crossingM / speedOf(runner.strideM, runner.baseBpm) : 0;
  const safeGreenS = Math.max(0, signal.greenS - c.startMarginS - c.endMarginS - crossS);
  // 安全な青が無い信号は、RUNWAVE も狙って合わせられない（偶然青に着くだけ）ので、通常走行と同じ見込みにする
  // （以前は動かせる幅を足して、青0秒でも止まりやすさ0になっていた。改善ループ c03・Codex の指摘）
  if (safeGreenS <= 0) return (signal.cycleS - signal.greenS) / signal.cycleS;
  const spread = arrivalSpread(approachM, runner, c);
  // 早歩きは point モデルでも横断を歩いて渡るので、遅い早歩きほど安全な青が短い。渡り切る青が残る早歩きのうち
  // 最も遅い速さ（core と同じ刻み）で着く時刻を「最も遅い着き方」とする。どの速さでも残らなければ走りの分だけ
  // （青が短い信号でこれを入れないと、止まりやすさを小さく見積もりすぎる）
  let slowestS = spread.slowestRunS;
  if (c.walk.enabled) {
    const n = Math.floor((c.walk.maxKmh - c.walk.minKmh) / c.walk.stepKmh + 1e-9);
    for (let i = 0; i <= n; i++) {
      const v = (c.walk.minKmh + i * c.walk.stepKmh) / 3.6;
      if (signal.greenS - c.startMarginS - c.endMarginS - signal.crossingM / v > 0) {
        slowestS = Math.max(slowestS, approachM / v);
        break;
      }
    }
  }
  const widthS = slowestS - spread.fastestS;
  // RUNWAVE は少なくとも通常走行と同じ動きはできる（合わせられないときも青なら通過する）ので、通常走行の見込みを上限にする
  // （安全な青がごく短いとき、通常走行より止まりやすい値になり、青を長くすると止まりやすくなる逆転があった。改善ループ c12a：ファズテストで発見）
  const normalRisk = (signal.cycleS - signal.greenS) / signal.cycleS;
  // 止まるのが避けられないとき、core は最も遅い速さで近づく（改善ループ c07a・c08b）。そのとき着く時刻が青の始まり直後
  // （開始後の余裕の中）なら止まらずに通過するので、その幅（開始後の余裕）も止まらずに済む範囲に足す（改善ループ c13a）
  const slowPassS = Math.min(c.startMarginS, signal.greenS);
  return Math.min(normalRisk, Math.max(0, 1 - (widthS + safeGreenS + slowPassS) / signal.cycleS));
}

// 経路の止まりやすさ。信号ごとの「動かせる距離」は、前の信号の横断の終わり（最初はスタート）からの距離
export function routeStopRisk(route, runner, control) {
  let prevEnd = 0;
  const perSignal = route.signals.map((s) => {
    const approachM = s.atM - prevEnd;
    prevEnd = s.atM + s.signal.crossingM;
    return { id: s.id, approachM, risk: stopRisk(s.signal, approachM, runner, control) };
  });
  return { expectedStops: perSignal.reduce((a, s) => a + s.risk, 0), signalCount: perSignal.length, perSignal };
}

// 信号のない経路は通常BPMで進める
function freeSummary(route, runner) {
  return { finished: true, stops: 0, stopTimeS: 0, walkTimeS: 0, totalTimeS: route.distanceM / speedOf(runner.strideM, runner.baseBpm), signals: [] };
}

// 経路を route-core で走らせる（phaseOf で信号ごとの位相を差し替えられる。推定の位相で選ぶ検証に使う）
export function simulateCandidate(route, { runner, control, departureTimeS = 0, maxTimeS = 3600, phaseOf = (s) => s.signal.phaseS }) {
  if (!route.signals.length) return freeSummary(route, runner);
  const config = { runner, control, goalM: route.distanceM,
    signals: route.signals.map((s) => ({ ...s, signal: { ...s.signal, phaseS: phaseOf(s) + departureTimeS } })) };
  return simulateRoute(config, { maxTimeS }).summary;
}

// 候補を式で並べる（止まりやすさ → 距離 → id）
export function rankByRisk(routes, runner, control) {
  return routes.map((route) => ({ ...route, risk: routeStopRisk(route, runner, control) }))
    .sort((a, b) => a.risk.expectedStops - b.risk.expectedStops || a.distanceM - b.distanceM || a.id.localeCompare(b.id));
}

// 経路検索。topK = 0 なら式だけで選ぶ（位相を使わない）。topK > 0 なら式の上位 topK 本を走らせ、
// 止まる回数 → 停止時間 → 早歩きの時間 → 止まりやすさ → 距離 の順で選ぶ（未完走は選ばない）
export function searchRoute(graph, options) {
  const { runner, control, topK = 0 } = options;
  need(Number.isSafeInteger(topK) && topK >= 0, 'topK は0以上の整数');
  const search = enumerateRoutes(graph, options);
  const ranked = rankByRisk(search.routes, runner, control);
  if (!topK || !ranked.length) return { selected: ranked[0] ?? null, ranked, checked: [], shortestM: search.shortestM, truncated: search.truncated };
  const checked = ranked.slice(0, topK).map((route) => ({ ...route, summary: simulateCandidate(route, options) }));
  const score = (r) => [r.summary.stops, r.summary.stopTimeS, r.summary.walkTimeS || 0, r.risk.expectedStops, r.distanceM];
  const better = (a, b) => {
    const x = score(a), y = score(b);
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 1e-9) return x[i] < y[i];
    return false;
  };
  let selected = null;
  for (const r of checked) if (r.summary.finished && (!selected || better(r, selected))) selected = r;
  return { selected, ranked, checked, shortestM: search.shortestM, truncated: search.truncated };
}
