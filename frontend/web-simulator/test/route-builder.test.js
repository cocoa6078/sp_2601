import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute, pointAtDistance } from '../src/route-geometry.js';
import { addVia, draftPoints, draftRoute, matchSignals, moveVia, removeVia, reorderVia } from '../src/route-builder.js';
import { DEMO_ROUTE_POINTS, FIXTURE_SIGNALS } from '../src/fixtures.js';

const route = buildRoute(DEMO_ROUTE_POINTS);
const sig = (key, p, extra = {}) => ({ key, signalId: key, lat: p.lat, lng: p.lng, signal: { cycleS: 100, greenS: 40, yellowS: 5, redS: 55, phaseS: 0, crossingM: 15 }, ...extra });

test('デモ経路: 約 600 m で fixture の sapporo_1 が 2/3 付近に投影される', () => {
  assert.ok(Math.abs(route.lengthM - 600) < 2, `len=${route.lengthM}`);
  const r = matchSignals(route, FIXTURE_SIGNALS);
  assert.equal(r.adopted.length, 1);
  assert.equal(r.adopted[0].signalId, 'sapporo_1');
  assert.ok(Math.abs(r.adopted[0].s - 400) < 2);
  assert.ok(r.adopted[0].offsetM < 1);
  assert.deepEqual(r.errors, []);
  assert.equal(r.excluded.filter((e) => e.code === 'too-far').length, 4);
});

test('0 件: 信号なしの経路は none=true', () => {
  const r = matchSignals(route, []);
  assert.equal(r.none, true);
  assert.equal(r.adopted.length, 0);
});

test('許容距離 30m の境界: 29m は採用、31m は除外', () => {
  const at = pointAtDistance(route, 300);
  const dLng = (m) => m / (111195 * Math.cos((at.lat * Math.PI) / 180));
  const near = sig('n', { lat: at.lat, lng: at.lng + dLng(29) });
  const far = sig('f', { lat: at.lat, lng: at.lng + dLng(31) });
  const r = matchSignals(route, [near, far]);
  assert.deepEqual(r.adopted.map((a) => a.key), ['n']);
  assert.equal(r.excluded.find((e) => e.key === 'f').code, 'too-far');
});

test('同一 key は最も近い 1 件だけ採用（黙って統合しない: duplicate として記録）', () => {
  const at = pointAtDistance(route, 300);
  const a = sig('x', { lat: at.lat, lng: at.lng + 0.0001 });
  const b = sig('x', { lat: at.lat, lng: at.lng + 0.00005 });
  const r = matchSignals(route, [a, b]);
  assert.equal(r.adopted.length, 1);
  assert.ok(Math.abs(r.adopted[0].lng - b.lng) < 1e-12);
  assert.equal(r.excluded.filter((e) => e.code === 'duplicate').length, 1);
});

test('別地域で同じ signalId でも key が違えば別の信号として両方採用', () => {
  const a = sig('r1:7', pointAtDistance(route, 200), { signalId: '7' });
  const b = sig('r2:7', pointAtDistance(route, 400), { signalId: '7' });
  const r = matchSignals(route, [a, b]);
  assert.equal(r.adopted.length, 2);
});

test('端点: スタート/ゴール直上は errors（削除はしない）', () => {
  const r1 = matchSignals(route, [sig('s', pointAtDistance(route, 5))]);
  assert.equal(r1.adopted.length, 1);
  assert.match(r1.errors.join('\n'), /スタート直上/);
  const r2 = matchSignals(route, [sig('g', pointAtDistance(route, route.lengthM - 3))]);
  assert.match(r2.errors.join('\n'), /ゴール直上/);
});

test('横断区間が重なる信号（距離 < 横断幅）は errors', () => {
  const r = matchSignals(route, [sig('a', pointAtDistance(route, 300)), sig('b', pointAtDistance(route, 308))]);
  assert.equal(r.adopted.length, 2);
  assert.match(r.errors.join('\n'), /近すぎ/);
});

test('6 件は最大 5 件超過の errors、s の昇順', () => {
  const list = [500, 100, 300, 200, 450, 350].map((s) => sig(`k${s}`, pointAtDistance(route, s)));
  const r = matchSignals(route, list);
  assert.deepEqual(r.adopted.map((a) => a.key), ['k100', 'k200', 'k300', 'k350', 'k450', 'k500']);
  assert.match(r.errors.join('\n'), /最大 5/);
});

test('座標が不明・非有限・信号値が不正なら除外して理由を返す', () => {
  const bad1 = { ...sig('a', { lat: 0, lng: 0 }), lat: NaN };
  const bad2 = { ...sig('b', pointAtDistance(route, 300)), signal: { cycleS: 100, greenS: 10, yellowS: 5, redS: 5, phaseS: 0, crossingM: 15 } };
  const r = matchSignals(route, [bad1, bad2]);
  assert.equal(r.adopted.length, 0);
  assert.deepEqual(r.excluded.map((e) => e.code).sort(), ['invalid-coordinates', 'invalid-signal']);
});

test('手動除外は manual として記録される', () => {
  const r = matchSignals(route, FIXTURE_SIGNALS, { manualExclude: new Set(['fixture:sapporo_1']) });
  assert.equal(r.adopted.length, 0);
  assert.ok(r.excluded.some((e) => e.code === 'manual'));
});

test('draft の編集: 経由点の追加・移動・削除・順序入れ替え', () => {
  let d = { start: { lat: 43.05, lng: 141.35 }, end: { lat: 43.06, lng: 141.35 }, via: [] };
  assert.equal(draftPoints({ start: null, end: d.end, via: [] }), null);
  d = addVia(d, { lat: 43.052, lng: 141.351 });
  d = addVia(d, { lat: 43.055, lng: 141.352 });
  assert.equal(draftPoints(d).length, 4);
  d = reorderVia(d, 0, 1);
  assert.equal(d.via[0].lat, 43.055);
  d = moveVia(d, 0, { lat: 43.056, lng: 141.352 });
  assert.equal(d.via[0].lat, 43.056);
  d = removeVia(d, 1);
  assert.equal(d.via.length, 1);
  assert.equal(draftRoute(d).route.points.length, 3);
  assert.match(draftRoute({ start: null, end: null, via: [] }).errors[0], /開始地点/);
});
