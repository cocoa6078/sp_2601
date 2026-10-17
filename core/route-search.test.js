import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from './runwave-core.js';
import { arrivalSpread, stopRisk, routeStopRisk, searchRoute } from './experimental/route-search.js';

const runner = { strideM: 0.8, baseBpm: 150 };
const control = { startMarginS: 3, endMarginS: 5 };
const sig = (cycleS, greenS, phaseS = 0) => ({ cycleS, greenS, yellowS: 5, redS: cycleS - greenS - 5, phaseS, crossingM: 15 });
const SAPPORO_1 = sig(145, 31), SAPPORO_2 = sig(100, 41);

// 位相を1秒ずつ全部試して、実際に止まった割合（式と比べる相手）
const simulatedRisk = (signal, approachM, ctl = control) => {
  let stops = 0;
  for (let p = 0; p < signal.cycleS; p++) {
    stops += simulate({ runner, control: ctl, signal: { ...signal, phaseS: p }, route: { crossingX: approachM, goalX: approachM + 65 } }).summary.stops;
  }
  return stops / signal.cycleS;
};

test('止まりやすさ: 通常走行は（周期 − 青）÷ 周期', () => {
  assert.equal(stopRisk(SAPPORO_1, 300, runner, { ...control, enabled: false }), 114 / 145);
});

test('止まりやすさ: 着く時刻を動かせる幅は距離とともに広がる（300m で約69秒、早歩きなしは狭い）', () => {
  const w = arrivalSpread(300, runner, control).widthS;
  assert.ok(Math.abs(w - 68.8) < 0.5, `${w}`);
  assert.ok(arrivalSpread(600, runner, control).widthS > 2 * w - 5);
  assert.ok(arrivalSpread(300, runner, { ...control, walk: { enabled: false } }).widthS < w / 1.5);
});

test('止まりやすさ: 距離が長いほど・青が長いほど小さい。0〜1 に収まる', () => {
  let prev = 1;
  for (const d of [50, 100, 200, 300, 450, 600]) {
    const r = stopRisk(SAPPORO_1, d, runner, control);
    assert.ok(r >= 0 && r <= 1 && r <= prev + 1e-12, `${d}m: ${r}`);
    prev = r;
  }
  assert.ok(stopRisk(sig(145, 50), 300, runner, control) < stopRisk(SAPPORO_1, 300, runner, control));
  assert.equal(stopRisk(SAPPORO_1, 600, runner, control), 0);
});

test('止まりやすさ: 式は位相を全部試した結果とほぼ一致（sapporo_1・sapporo_2、300m）', () => {
  for (const s of [SAPPORO_1, SAPPORO_2]) {
    const f = stopRisk(s, 300, runner, control), m = simulatedRisk(s, 300);
    assert.ok(Math.abs(f - m) <= 0.03, `式 ${f} / 計算 ${m}`);
  }
});

test('経路の止まりやすさ: 動かせる距離は前の信号の横断の終わりから測る', () => {
  const route = { distanceM: 800, signals: [{ id: 'a', atM: 300, signal: SAPPORO_1 }, { id: 'b', atM: 615, signal: SAPPORO_2 }] };
  const r = routeStopRisk(route, runner, control);
  assert.deepEqual(r.perSignal.map((s) => s.approachM), [300, 300]);
  assert.ok(Math.abs(r.expectedStops - (stopRisk(SAPPORO_1, 300, runner, control) + stopRisk(SAPPORO_2, 300, runner, control))) < 1e-12);
});

// 2経路：青の短い信号が1つ（遠回りなし）／青の長い信号が2つ（同じ距離）
const twoRoads = () => {
  const nodes = [{ id: 'start' }, { id: 'goal' }, { id: 'p' }, { id: 'q' }];
  const edges = [
    { id: 'one', from: 'start', to: 'goal', lengthM: 700, signals: [{ id: 's1', atM: 300, signal: SAPPORO_1 }] },
    { id: 'two1', from: 'start', to: 'p', lengthM: 350, signals: [{ id: 's2a', atM: 300, signal: SAPPORO_2 }] },
    { id: 'two2', from: 'p', to: 'goal', lengthM: 350, signals: [{ id: 's2b', atM: 250, signal: { ...SAPPORO_2, phaseS: 40 } }] },
  ];
  return { graph: { nodes, edges }, options: { startId: 'start', goalId: 'goal', runner, control, maxDetourRatio: 0, maxCandidates: 8 } };
};

test('経路検索: 信号の数より止まりやすさで選ぶ（青の長い信号2つの経路を選ぶ）', () => {
  const { graph, options } = twoRoads();
  const r = searchRoute(graph, options);
  assert.equal(r.ranked.length, 2);
  assert.equal(r.selected.id, 'two1/two2');
  assert.equal(r.selected.risk.signalCount, 2);
});

test('経路検索: 2段階では上位を実際に走らせ、完走した経路から選ぶ', () => {
  const { graph, options } = twoRoads();
  const r = searchRoute(graph, { ...options, topK: 2 });
  assert.equal(r.checked.length, 2);
  assert.ok(r.selected.summary.finished);
  for (const c of r.checked) assert.ok(r.selected.summary.stops <= c.summary.stops);
});
