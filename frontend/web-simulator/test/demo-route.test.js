import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_ROUTE_POINTS, DEMO_WALK_PATH, FIXTURE_SIGNALS, demoRoutePoints } from '../src/fixtures.js';
import { DEMO_SCENARIOS } from '../src/scenarios.js';
import { buildRoute, distanceM, pointAtDistance, sliceRoute, validateRoute } from '../src/route-geometry.js';

const sig1 = FIXTURE_SIGNALS.find((f) => f.signalId === 'sapporo_1');

test('固定デモ A/B/W: 経路長が goalX と 1 m 以内・crossingX の地点が sapporo_1 から 15 m 以内・validateRoute OK', () => {
  assert.deepEqual(DEMO_SCENARIOS.filter((d) => d.kind === 'single').map((d) => d.id).sort(), ['A', 'B', 'W']);
  for (const d of DEMO_SCENARIOS.filter((x) => x.kind === 'single')) {
    const { crossingX, goalX } = d.config.route;
    const route = buildRoute(demoRoutePoints(crossingX, goalX), { source: 'preset' });
    assert.ok(Math.abs(route.lengthM - goalX) <= 1, `${d.id}: len=${route.lengthM}`);
    const p = pointAtDistance(route, crossingX);
    assert.ok(distanceM(p, sig1) <= 15, `${d.id}: crossing は sapporo_1 から ${distanceM(p, sig1)} m`);
    assert.deepEqual(validateRoute(route), { ok: true, errors: [] }, d.id);
  }
});

test('800 m / 1000 m（crossingX 800・goalX 1000）でも切り出せる: 手前 820 m 以上・先 220 m 以上の経路', () => {
  const route = buildRoute(demoRoutePoints(800, 1000));
  assert.ok(Math.abs(route.lengthM - 1000) <= 1);
  assert.ok(distanceM(pointAtDistance(route, 800), sig1) <= 15);
  assert.ok(validateRoute(route).ok);
});

test('DEMO_ROUTE_POINTS は A/B 用（400/600 m）の切り出し結果', () => {
  const route = buildRoute(DEMO_ROUTE_POINTS);
  assert.ok(Math.abs(route.lengthM - 600) <= 1);
});

test('DEMO_WALK_PATH: 検証 OK・sapporo_1 の手前 820 m 以上・先 220 m 以上・他の fixture 信号から 100 m 以上離れる', () => {
  const path = buildRoute(DEMO_WALK_PATH);
  assert.ok(validateRoute(path).ok);
  const near = path.points.map((p, i) => [distanceM(p, sig1), path.cumulativeM[i]]).sort((a, b) => a[0] - b[0])[0];
  assert.ok(near[1] >= 820 && path.lengthM - near[1] >= 220, `s=${near[1]} / ${path.lengthM}`);
  for (const f of FIXTURE_SIGNALS.filter((x) => x !== sig1)) {
    const d = Math.min(...path.points.map((p) => distanceM(p, f)));
    assert.ok(d > 100, `${f.signalId}: ${d} m`);
  }
});

test('sliceRoute: 範囲外は RangeError・切り出した長さは toS−fromS', () => {
  const path = buildRoute(DEMO_WALK_PATH);
  assert.throws(() => sliceRoute(path, -50, 100), RangeError);
  assert.throws(() => sliceRoute(path, 100, path.lengthM + 50), RangeError);
  assert.throws(() => sliceRoute(path, 300, 300), RangeError);
  const part = sliceRoute(path, 100.3, 400.7);
  assert.ok(Math.abs(part.lengthM - 300.4) < 0.5, `${part.lengthM}`);
  assert.equal(part.source, path.source);
});
