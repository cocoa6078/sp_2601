import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWalkRouteUrl, fetchWalkRoute, thinPoints } from '../src/walk-routing.js';
import { buildRoute, distanceM, validateRoute, MIN_SEGMENT_M } from '../src/route-geometry.js';

const PTS = [{ lat: 43.0589, lng: 141.352 }, { lat: 43.0652, lng: 141.352 }];
// 約 1 m = 0.000009 度（緯度）
const lat = (m) => 43.06 + m * 0.000009;
const okFetch = (coordinates, calls = []) => async (url, opts) => {
  calls.push({ url, opts });
  return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates } }] }) };
};

test('URL: start・via・end を lng,lat の順で並べ、overview=full・geojson を付ける', () => {
  const url = buildWalkRouteUrl([PTS[0], { lat: 43.06, lng: 141.353 }, PTS[1]]);
  assert.equal(url, 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/141.352000,43.058900;141.353000,43.060000;141.352000,43.065200?overview=full&geometries=geojson');
});

test('成功: [lng,lat] を {lat,lng} に変換し、1 回の呼び出しで 1 リクエスト', async () => {
  const calls = [];
  const coords = [[141.352, lat(0)], [141.3521, lat(50)], [141.3522, lat(100)]];
  const r = await fetchWalkRoute(PTS, { fetchImpl: okFetch(coords, calls) });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/routing\.openstreetmap\.de\/routed-foot\/route\/v1\/foot\/141\.352000,43\.058900;141\.352000,43\.065200\?/);
  assert.deepEqual(r, coords.map(([lng, la]) => ({ lat: la, lng })));
  assert.ok(validateRoute(buildRoute(r, { source: 'osrm-foot' })).ok);
});

test('間引き: 2 m 未満の連続点を落とし、全区間が MIN_SEGMENT_M 以上になる。端点は残る', async () => {
  const coords = [[141.352, lat(0)], [141.352, lat(0.5)], [141.352, lat(1)], [141.352, lat(30)], [141.352, lat(31)], [141.352, lat(60)], [141.352, lat(60.5)]];
  const r = await fetchWalkRoute(PTS, { fetchImpl: okFetch(coords) });
  assert.deepEqual(r[0], { lat: lat(0), lng: 141.352 });
  assert.deepEqual(r[r.length - 1], { lat: lat(60.5), lng: 141.352 });
  assert.equal(r.length, 3); // 0 / 30 / 60.5（60 は終点 60.5 に近いので落ちる。1 と 31 も落ちる）
  for (let i = 1; i < r.length; i++) assert.ok(distanceM(r[i - 1], r[i]) >= MIN_SEGMENT_M, `seg ${i}`);
});

test('thinPoints: 終点が直前の点に近いときは途中点を落として終点を残す', () => {
  const pts = [{ lat: lat(0), lng: 141.352 }, { lat: lat(20), lng: 141.352 }, { lat: lat(20.5), lng: 141.352 }];
  const r = thinPoints(pts);
  assert.equal(r.length, 2);
  assert.deepEqual(r[1], pts[2]);
});

test('タイムアウト: 応答しない fetch は timeoutMs で理由つき reject（abort も呼ぶ）', async () => {
  let aborted = false;
  const never = (url, opts) => new Promise(() => { opts?.signal?.addEventListener('abort', () => { aborted = true; }); });
  await assert.rejects(fetchWalkRoute(PTS, { fetchImpl: never, timeoutMs: 30 }), /タイムアウト/);
  assert.equal(aborted, true);
});

test('code が Ok でない: 理由に code を含めて reject', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ code: 'NoRoute', message: 'x' }) });
  await assert.rejects(fetchWalkRoute(PTS, { fetchImpl: f }), /NoRoute/);
});

test('HTTP エラー・通信失敗・JSON 不正は理由つき reject', async () => {
  await assert.rejects(fetchWalkRoute(PTS, { fetchImpl: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
  await assert.rejects(fetchWalkRoute(PTS, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /通信に失敗/);
  await assert.rejects(fetchWalkRoute(PTS, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }) }), /JSON/);
});

test('点不足: 入力が 2 点未満、または間引き後に 2 点未満なら reject（通信しない / 結果を使わない）', async () => {
  let called = 0;
  const counting = async () => { called++; return okFetch([])(); };
  await assert.rejects(fetchWalkRoute([PTS[0]], { fetchImpl: counting }), /点が足りません/);
  assert.equal(called, 0);
  const tiny = [[141.352, lat(0)], [141.352, lat(0.5)], [141.352, lat(1)]];
  await assert.rejects(fetchWalkRoute(PTS, { fetchImpl: okFetch(tiny) }), /2 点未満/);
  await assert.rejects(fetchWalkRoute(PTS, { fetchImpl: okFetch([[141.352, lat(0)]]) }), /2 点未満/);
});
