// backend API テスト（node:test + 組み込み fetch）。追加依存なし。
const test = require('node:test');
const assert = require('node:assert');
const app = require('../index.js');

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve); // 空きポート
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const QUALITY_KEYS = ['signalType', 'phaseBasis', 'phaseBasisNote', 'positionAccuracyM', 'fetchedAt', 'crossingDirection'];

function assertQuality(s) {
  for (const k of QUALITY_KEYS) assert.ok(k in s, `${k} がありません`);
  assert.strictEqual(s.signalType, 'vehicle');
  assert.strictEqual(s.phaseBasis, 'estimated');
  assert.strictEqual(typeof s.phaseBasisNote, 'string');
  assert.strictEqual(s.positionAccuracyM, null);
  assert.strictEqual(s.fetchedAt, null);
  assert.strictEqual(s.crossingDirection, null);
}

async function getJson(path, init) {
  const res = await fetch(base + path, init);
  return { res, body: await res.json() };
}

function postJson(path, payload, method = 'POST') {
  return getJson(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  });
}

test('GET /api/signals: 品質項目・既存キー・英語status', async () => {
  const { res, body } = await getJson('/api/signals');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(body.ステータス, '成功');
  assert.strictEqual(body.データ.length, 5);
  for (const s of body.データ) {
    assertQuality(s);
    assert.strictEqual(s.isEstimated, true);
    assert.ok(s.note);
    assert.strictEqual(typeof s.phaseS, 'number');
  }
});

test('GET /api/signals/all: 全件に品質項目', async () => {
  const { body } = await getJson('/api/signals/all');
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(body.総件数, body.データ.length);
  assert.ok(body.データ.length > 0);
  for (const s of body.データ) {
    assertQuality(s);
    assert.strictEqual(s.phaseS, 0);
  }
});

test('GET /api/signals/region/:region: 成功と NOT_FOUND', async () => {
  const ok = await getJson('/api/signals/region/' + encodeURIComponent('札幌方面'));
  assert.strictEqual(ok.body.status, 'ok');
  assert.ok(ok.body.件数 > 0);
  assertQuality(ok.body.データ[0]);

  const ng = await getJson('/api/signals/region/' + encodeURIComponent('存在しない'));
  assert.strictEqual(ng.res.status, 404);
  assert.strictEqual(ng.body.status, 'error');
  assert.strictEqual(ng.body.error.code, 'NOT_FOUND');
  assert.strictEqual(ng.body.ステータス, 'エラー');
  assert.ok(ng.body.メッセージ);
});

test('POST /api/calibration: 不正入力は INVALID_INPUT（値は書き換わらない）', async () => {
  const { res, body } = await postJson('/api/calibration', { 歩幅: -1, 通常BPM: 150 });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(body.status, 'error');
  assert.strictEqual(body.error.code, 'INVALID_INPUT');
  assert.strictEqual(body.error.message, body.メッセージ);
});

test('GET /api/calibration: 日本語キーと status:ok', async () => {
  const { body } = await getJson('/api/calibration');
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(body.ステータス, '成功');
  assert.ok('歩幅' in body.データ);
});

test('POST /api/logs: 空ボディは INVALID_INPUT（ファイル書き込みは発生しない）', async () => {
  const { res, body } = await postJson('/api/logs', {});
  assert.strictEqual(res.status, 400);
  assert.strictEqual(body.error.code, 'INVALID_INPUT');
});

test('セッション案内: PUT成功 / 古いseqは CONFLICT / 未登録は NOT_FOUND', async () => {
  const id = 'test-' + Date.now();
  const put = (seq) => postJson(`/api/sessions/${id}/guidance`, { guidanceSeq: seq }, 'PUT');
  const a = await put(2);
  assert.strictEqual(a.res.status, 200);
  assert.strictEqual(a.body.status, 'ok');
  const b = await put(1);
  assert.strictEqual(b.res.status, 409);
  assert.strictEqual(b.body.error.code, 'CONFLICT');
  assert.strictEqual(b.body.ステータス, '競合');
  const c = await getJson('/api/sessions/none-' + id + '/guidance');
  assert.strictEqual(c.res.status, 404);
  assert.strictEqual(c.body.error.code, 'NOT_FOUND');
});

test('未知のエンドポイントは 404 NOT_FOUND', async () => {
  const { res, body } = await getJson('/api/nothing');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(body.status, 'error');
  assert.strictEqual(body.error.code, 'NOT_FOUND');
});

test('不正JSONは 400 INVALID_INPUT', async () => {
  const { res, body } = await postJson('/api/calibration', '{bad');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(body.error.code, 'INVALID_INPUT');
});

test('POST /api/signals/along-route: デモ5件を通る経路で品質項目つき', async () => {
  const demo = (await getJson('/api/signals')).body.データ;
  const coordinates = demo.map((s) => [s.lon, s.lat]);
  const { res, body } = await postJson('/api/signals/along-route', {
    route: { type: 'LineString', coordinates },
    corridorM: 30
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.status, 'ok');
  assert.ok(body.matches.length > 0);
  for (const m of body.matches) {
    assertQuality(m);
    assert.strictEqual(m.isEstimated, true);
    assert.ok(m.timing && 'cycleS' in m.timing);
  }
});

test('POST /api/signals/along-route: 不正な形状は 400 と status:error', async () => {
  const { res, body } = await postJson('/api/signals/along-route', {
    route: { type: 'Point', coordinates: [] }
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(body.status, 'error');
  assert.strictEqual(body.error.code, 'INVALID_ROUTE_GEOMETRY');
});

test('along-route: alongRouteM 昇順・単調増加・offsetM<=corridorM・generatedAt', async () => {
  const demo = (await getJson('/api/signals')).body.データ;
  // 逆順の経路（始点=すすきの側）でも、並びは経路始点からの距離順になる
  const coordinates = demo.map((s) => [s.lon, s.lat]).reverse();
  const corridorM = 30;
  const { body } = await postJson('/api/signals/along-route', {
    route: { type: 'LineString', coordinates },
    corridorM
  });
  assert.ok(coordinates.length >= 3);
  assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));
  assert.ok(body.matches.length >= 2);
  for (let i = 0; i < body.matches.length; i++) {
    const m = body.matches[i];
    assert.strictEqual(typeof m.alongRouteM, 'number');
    assert.ok(m.offsetM >= 0 && m.offsetM <= corridorM);
    if (i > 0) assert.ok(m.alongRouteM > body.matches[i - 1].alongRouteM, '単調増加');
  }
  // 逆順にしたので、デモ最終点が先頭になる
  assert.strictEqual(body.matches[0].physicalSignalId, demo[demo.length - 1].signalId.replace('sapporo_', 'hokkaido_札幌方面_'));
});
