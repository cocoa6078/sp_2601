import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateRoutes, chooseRoute } from './experimental/route-choice.js';
import { makeRouteChoiceFixture } from './experimental/route-choice-fixture.js';

test('経路選択試作: 同じ出発地・目的地の8経路。5信号を保ち、迂回は20%以内、周回なし', () => {
  const { graph, options } = makeRouteChoiceFixture(100);
  const result = enumerateRoutes(graph, options);
  assert.equal(result.routes.length, 8);
  assert.equal(result.shortestM, 1570);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.routes.map((r) => r.distanceM), [1570, 1650, 1650, 1650, 1730, 1730, 1730, 1810]);
  for (const route of result.routes) {
    assert.equal(route.nodeIds[0], 'start'); assert.equal(route.nodeIds.at(-1), 'goal');
    assert.equal(new Set(route.nodeIds).size, route.nodeIds.length);
    assert.equal(route.signals.length, 5);
    assert.ok(route.distanceM <= result.shortestM * 1.2);
  }
  for (const edge of graph.edges) {
    const a = graph.nodes.find((n) => n.id === edge.from), b = graph.nodes.find((n) => n.id === edge.to);
    assert.ok(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - edge.lengthM) < 1e-9);
  }
});

test('経路選択試作: 迂回なしなら最短経路のみ。候補の打ち切りを報告する', () => {
  const { graph, options } = makeRouteChoiceFixture();
  assert.equal(enumerateRoutes(graph, { ...options, maxDetourRatio: 0 }).routes.length, 1);
  const limited = enumerateRoutes(graph, { ...options, maxCandidates: 2 });
  assert.equal(limited.routes.length, 2); assert.equal(limited.truncated, true);
  const expanded = enumerateRoutes(graph, { ...options, maxExpanded: 1 });
  assert.equal(expanded.truncated, true); assert.equal(expanded.routes.length, 0);
});

const signal = { cycleS: 120, greenS: 20, yellowS: 5, redS: 95, phaseS: 0, crossingM: 15 };
const graph = { nodes: [{ id: 's' }, { id: 'g' }], edges: [
  { id: 'short', from: 's', to: 'g', lengthM: 200, signals: [{ id: 'red', atM: 100, signal }] },
  { id: 'long', from: 's', to: 'g', lengthM: 220, signals: [{ id: 'green', atM: 100, signal: { ...signal, greenS: 120, yellowS: 0, redS: 0 } }] },
] };
const options = { startId: 's', goalId: 'g', runner: { strideM: 0.8, baseBpm: 150 }, control: { enabled: false }, maxDetourRatio: 0.2 };

test('経路選択試作: 少し長くても停止ゼロで完走する経路を選ぶ。入力を変えない', () => {
  const before = structuredClone({ graph, options });
  const result = chooseRoute(graph, options);
  assert.equal(result.selected.id, 'long');
  assert.equal(result.selected.summary.stops, 0);
  assert.equal(result.evaluated.find((r) => r.id === 'short').summary.stops, 1);
  assert.deepEqual({ graph, options }, before);
  assert.deepEqual(chooseRoute(graph, options), result);
});

test('経路選択試作: 出発時刻を全信号に同じだけ反映する。出発待ちは挿入しない', () => {
  const result = chooseRoute(graph, { ...options, departureTimeS: 70 });
  assert.equal(result.selected.id, 'short');
  for (const r of result.evaluated) assert.equal(r.config.signals[0].signal.phaseS, 70);
  assert.equal(result.selected.summary.totalTimeS, 100);
});

test('経路選択試作: 時間切れの停止ゼロを成功として選ばない', () => {
  const result = chooseRoute(graph, { ...options, maxTimeS: 1 });
  assert.equal(result.selected, null);
  assert.ok(result.evaluated.every((r) => !r.summary.finished));
});

test('経路選択試作: 信号のない経路・到達不能・全候補で停止が必要な場合も区別する', () => {
  const free = { ...graph, edges: [{ id: 'free', from: 's', to: 'g', lengthM: 200 }] };
  const result = chooseRoute(free, options);
  assert.equal(result.selected.summary.stops, 0);
  assert.equal(result.selected.summary.totalTimeS, 100);
  assert.deepEqual(result.selected.summary.signals, []);
  assert.equal(chooseRoute(free, { ...options, maxTimeS: 1 }).selected, null);
  assert.equal(chooseRoute({ ...graph, edges: [] }, options).selected, null);
  assert.equal(chooseRoute({ ...graph, edges: [graph.edges[0]] }, options).selected.summary.stops, 1);
});

test('経路選択試作: 不正な道路・上限・信号を拒否する', () => {
  assert.throws(() => enumerateRoutes(graph, { ...options, maxCandidates: 0 }), RangeError);
  assert.throws(() => enumerateRoutes(graph, { ...options, maxDetourRatio: -1 }), RangeError);
  assert.throws(() => enumerateRoutes(graph, { ...options, goalId: 'missing' }), RangeError);
  assert.throws(() => enumerateRoutes({ ...graph, edges: [{ ...graph.edges[0], lengthM: -1 }] }, options), RangeError);
  assert.throws(() => enumerateRoutes({ ...graph, edges: [{ ...graph.edges[0], to: 'missing' }] }, options), RangeError);
  assert.throws(() => chooseRoute(graph, { ...options, departureTimeS: NaN }), RangeError);
  assert.throws(() => chooseRoute(graph, { ...options, maxTimeS: Infinity }), RangeError);
  const invalid = { ...graph, edges: [{ ...graph.edges[0], signals: [{ id: 'bad', atM: 199, signal }] }] };
  assert.throws(() => enumerateRoutes(invalid, options), RangeError);
});
