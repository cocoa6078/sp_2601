import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute, distanceM, localFrame, pointAtDistance, projectOnRoute, validateRoute } from '../src/route-geometry.js';

const A = { lat: 43.05, lng: 141.35 };

test('distanceM: 緯度 0.001 度 ≒ 111.2 m、同一点は 0', () => {
  assert.equal(distanceM(A, A), 0);
  const d = distanceM(A, { lat: 43.051, lng: 141.35 });
  assert.ok(Math.abs(d - 111.195) < 0.1, `d=${d}`);
});

test('distanceM: 経度方向は cos(緯度) で縮む（札幌 43 度で約 81.3 km/度）', () => {
  const d = distanceM(A, { lat: 43.05, lng: 141.351 });
  assert.ok(Math.abs(d - 81.3) < 0.3, `d=${d}`);
});

test('buildRoute: 累積距離は線分距離の和、lengthM は最後の累積', () => {
  const pts = [A, { lat: 43.051, lng: 141.35 }, { lat: 43.051, lng: 141.351 }];
  const r = buildRoute(pts);
  assert.equal(r.cumulativeM[0], 0);
  assert.ok(Math.abs(r.cumulativeM[1] - distanceM(pts[0], pts[1])) < 1e-9);
  assert.ok(Math.abs(r.lengthM - (distanceM(pts[0], pts[1]) + distanceM(pts[1], pts[2]))) < 1e-9);
  assert.throws(() => buildRoute([A]), RangeError);
  assert.throws(() => buildRoute([A, { lat: NaN, lng: 1 }]), RangeError);
});

test('投影: 局所メートル座標の距離が地理距離と近い（札幌周辺 1km で 0.5% 以内）', () => {
  const f = localFrame(A);
  for (const q of [{ lat: 43.055, lng: 141.355 }, { lat: 43.045, lng: 141.345 }, { lat: 43.058, lng: 141.35 }]) {
    const xy = f.toXY(q);
    const local = Math.hypot(xy.x, xy.y);
    const geo = distanceM(A, q);
    assert.ok(Math.abs(local - geo) / geo < 0.005, `local=${local} geo=${geo}`);
    const back = f.toLatLng(xy);
    assert.ok(Math.abs(back.lat - q.lat) < 1e-12 && Math.abs(back.lng - q.lng) < 1e-12);
  }
});

test('projectOnRoute: 線分上の点は距離 0・s は累積距離と一致', () => {
  const r = buildRoute([A, { lat: 43.052, lng: 141.35 }, { lat: 43.052, lng: 141.353 }]);
  const mid = pointAtDistance(r, 100);
  const pr = projectOnRoute(r, mid);
  assert.ok(pr.distM < 1e-6, `dist=${pr.distM}`);
  assert.ok(Math.abs(pr.s - 100) < 1e-6, `s=${pr.s}`);
  const onSecond = pointAtDistance(r, r.cumulativeM[1] + 50);
  assert.ok(Math.abs(projectOnRoute(r, onSecond).s - (r.cumulativeM[1] + 50)) < 1e-6);
});

test('projectOnRoute: 横にずれた点の垂線距離（東へ 0.0003 度 ≒ 24.4 m）と s', () => {
  const r = buildRoute([A, { lat: 43.052, lng: 141.35 }]);
  const off = { lat: 43.051, lng: 141.3503 };
  const pr = projectOnRoute(r, off);
  const expectOffset = distanceM({ lat: 43.051, lng: 141.35 }, off);
  assert.ok(Math.abs(pr.distM - expectOffset) / expectOffset < 0.005, `dist=${pr.distM} expect=${expectOffset}`);
  assert.ok(Math.abs(pr.s - distanceM(A, { lat: 43.051, lng: 141.35 })) < 0.5);
});

test('projectOnRoute: 端の外は端に丸める（s=0 / s=lengthM）', () => {
  const r = buildRoute([A, { lat: 43.052, lng: 141.35 }]);
  assert.equal(projectOnRoute(r, { lat: 43.049, lng: 141.35 }).s, 0);
  assert.ok(Math.abs(projectOnRoute(r, { lat: 43.053, lng: 141.35 }).s - r.lengthM) < 1e-9);
});

test('pointAtDistance: 範囲外は端、折れ線の補間', () => {
  const r = buildRoute([A, { lat: 43.051, lng: 141.35 }, { lat: 43.051, lng: 141.351 }]);
  assert.deepEqual(pointAtDistance(r, -5), A);
  assert.deepEqual(pointAtDistance(r, 1e9), r.points[2]);
  const p = pointAtDistance(r, r.cumulativeM[1] + 40.65);
  assert.ok(Math.abs(p.lat - 43.051) < 1e-9 && Math.abs(p.lng - 141.3505) < 1e-6);
});

test('validateRoute: 重複点・短すぎ・開始=終了・自己交差・往復を拒否', () => {
  const ok = buildRoute([A, { lat: 43.052, lng: 141.35 }]);
  assert.equal(validateRoute(ok).ok, true);
  assert.equal(validateRoute(buildRoute([A, A, { lat: 43.052, lng: 141.35 }])).ok, false);
  assert.equal(validateRoute(buildRoute([A, { lat: 43.05003, lng: 141.35 }])).ok, false);
  assert.equal(validateRoute(buildRoute([A, { lat: 43.052, lng: 141.35 }, { lat: 43.052, lng: 141.352 }, { lat: 43.0505, lng: 141.352 }, { lat: 43.0505, lng: 141.349 }, A])).ok, false);
  // 自己交差（X 字）
  const x = buildRoute([A, { lat: 43.052, lng: 141.352 }, { lat: 43.052, lng: 141.35 }, { lat: 43.05, lng: 141.352 }]);
  assert.match(validateRoute(x).errors.join('\n'), /交差/);
  // 往復（ほぼ引き返す）
  const back = buildRoute([A, { lat: 43.052, lng: 141.35 }, { lat: 43.0505, lng: 141.35001 }]);
  assert.match(validateRoute(back).errors.join('\n'), /往復/);
});
