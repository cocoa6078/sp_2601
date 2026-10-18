// セキュリティ対策のテスト（node:test + 組み込み fetch。追加依存なし）
// ログの保存先を一時フォルダにする（リポジトリの logs.json を書き換えない）。読み込みより前に設定する
process.env.RUNWAVE_LOGS_FILE = require('path').join(require('os').tmpdir(), `runwave-logs-test-${process.pid}.json`);
const test = require('node:test');
const assert = require('node:assert');
const app = require('../index.js');

let server;
let base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise((r) => server.close(r)); });

async function call(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { res, body: await res.json() };
}
const sid = (tag) => `sec-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const put = (id, body, headers) => call(`/api/sessions/${id}/guidance`, { method: 'PUT', body, headers });

test('S5 案内の乗っ取り防止（同じインスタンス内）: トークン無し・違うトークンの2回目の書き込みは 403。正しいトークンなら通る', async () => {
  const id = sid('owner');
  const first = await put(id, { guidanceSeq: 1, guidance: { targetBpm: 150 } });
  assert.strictEqual(first.res.status, 200);
  const token = first.body.writeToken;
  assert.ok(token);
  // 攻撃者：大きい番号で上書きしようとする
  const noToken = await put(id, { guidanceSeq: 999999, guidance: { targetBpm: 220 } });
  assert.strictEqual(noToken.res.status, 403);
  assert.strictEqual(noToken.body.error.code, 'FORBIDDEN');
  const wrong = await put(id, { guidanceSeq: 999999 }, { 'X-Session-Token': 'x'.repeat(token.length) });
  assert.strictEqual(wrong.res.status, 403);
  // 本人
  const ok = await put(id, { guidanceSeq: 2, guidance: { targetBpm: 152 } }, { 'X-Session-Token': token });
  assert.strictEqual(ok.res.status, 200);
  assert.strictEqual(ok.body.writeToken, undefined, '2回目以降はトークンを返さない');
  // 読み出し：攻撃者の値になっておらず、トークンも含まれない
  const get = await call(`/api/sessions/${id}/guidance`);
  assert.strictEqual(get.body.データ.guidance.targetBpm, 152);
  assert.ok(!JSON.stringify(get.body).includes(token), 'GET にトークンが含まれない');
});

test('S6 sessionId の形の検査（16〜64文字の英数字・-・_ 以外は 400。推測しにくさは呼ぶ側の責任）', async () => {
  for (const id of ['abc', 'short-id', 'a'.repeat(65), 'has%20space-0123456789']) {
    const r = await put(id, { guidanceSeq: 1 });
    assert.strictEqual(r.res.status, 400, id);
  }
  assert.strictEqual((await call('/api/sessions/abc/guidance')).res.status, 400);
});

test('S7 案内の値の検査：範囲外の BPM・不明な gait/mode・小数や負の番号・不正な日時・深い signal は 400', async () => {
  const deep = {}; let cur = deep; for (let i = 0; i < 3000; i++) { cur.a = {}; cur = cur.a; }
  const bad = [
    { guidanceSeq: 1, guidance: { targetBpm: 400 } },
    { guidanceSeq: 1, guidance: { targetBpm: 59 } },
    { guidanceSeq: 1, guidance: { targetBpm: '150' } },
    { guidanceSeq: 1, guidance: { gait: 'fly' } },
    { guidanceSeq: 1, guidance: { mode: 'sprint' } },
    { guidanceSeq: 1.5 },
    { guidanceSeq: -1 },
    { guidanceSeq: 1, expiresAt: 'not-a-date' },
    { guidanceSeq: 1, expiresAt: '1' },
    { guidanceSeq: 1, guidance: [] },
    { guidanceSeq: 1, signal: deep },
    { guidanceSeq: 1, signal: { color: { nested: true } } },
  ];
  for (const body of bad) {
    const r = await put(sid('v'), body);
    assert.strictEqual(r.res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.strictEqual(r.body.error.code, 'INVALID_INPUT');
  }
  // 境界値と正しい形は通る
  for (const body of [
    { guidanceSeq: 0, guidance: { targetBpm: 60 } },
    { guidanceSeq: 1, guidance: { targetBpm: 220, gait: 'walk', mode: 'walking', status: 'running' }, signal: { color: 'green', remainingS: 12.5, isEstimated: true } },
  ]) assert.strictEqual((await put(sid('g'), body)).res.status, 200, JSON.stringify(body));
});

test('S8 期限：省略は5分後、10分より先は 400、期限切れは配らず消す', async () => {
  const id = sid('ttl');
  const r = await put(id, { guidanceSeq: 1 });
  const ttl = Date.parse(r.body.データ.expiresAt) - Date.now();
  assert.ok(ttl > 4 * 60000 && ttl <= 5 * 60000, `省略時の期限 ${ttl}ms`);
  assert.strictEqual((await put(sid('far'), { guidanceSeq: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() })).res.status, 400);
  const old = sid('exp');
  assert.strictEqual((await put(old, { guidanceSeq: 1, expiresAt: new Date(Date.now() - 60000).toISOString() })).res.status, 200);
  const g1 = await call(`/api/sessions/${old}/guidance`);
  assert.strictEqual(g1.res.status, 410);
  assert.strictEqual(g1.body.error.code, 'EXPIRED');
  assert.strictEqual((await call(`/api/sessions/${old}/guidance`)).res.status, 404, '期限切れの案内は消える');
  assert.strictEqual((await put(old, { guidanceSeq: 2 })).res.status, 403, '持ち主の記録は残るので、別人が同じ ID を取れない');
});

test('S4 ログ：既知の項目の不正な値は 400。決まった項目だけ保存し、長すぎる文字列は切る', async () => {
  for (const body of [{ シナリオ: 'ok', gait: {} }, { シナリオ: 'ok', walkCount: [] }, { 停止回数: '1' }, { 停止回数: -1 }, { 総所要時間: -5 }, { シナリオ: 123 }]) {
    const r = await call('/api/logs', { method: 'POST', body });
    assert.strictEqual(r.res.status, 400, JSON.stringify(body));
  }
  const r = await call('/api/logs', { method: 'POST', body: { シナリオ: 'x'.repeat(500), 停止回数: 1, 総所要時間: 300, evil: '<script>alert(1)</script>' } });
  assert.strictEqual(r.res.status, 201);
  const got = await call(`/api/logs/${r.body.id}`);
  assert.strictEqual(got.body.データ.evil, undefined);
  assert.strictEqual(got.body.データ.シナリオ.length, 100);
  assert.strictEqual((await call('/api/logs', { method: 'POST', body: { evil: 1 } })).res.status, 400, '保存できる項目が無ければ 400');
});

test('S9 校正値：Infinity（生 JSON の 1e309）・範囲外は 400 で、値は書き換わらない', async () => {
  const before = (await call('/api/calibration')).body.データ;
  for (const raw of ['{"歩幅":0.8,"通常BPM":1e309}', '{"歩幅":1e309,"通常BPM":150}', '{"歩幅":0.8,"通常BPM":30}', '{"歩幅":5,"通常BPM":150}', '{"歩幅":0.8,"通常BPM":150,"walkStrideM":-1}']) {
    const r = await call('/api/calibration', { method: 'POST', raw, headers: { 'X-Forwarded-For': '198.51.100.9' } });
    assert.strictEqual(r.res.status, 400, raw);
  }
  assert.deepStrictEqual((await call('/api/calibration')).body.データ, before);
});

test('S10 along-route：null の点・範囲外の座標・不正な corridorM は 400（500 にならない）', async () => {
  const line = (coordinates, extra = {}) => call('/api/signals/along-route', { method: 'POST', body: { route: { type: 'LineString', coordinates }, ...extra }, headers: { 'X-Forwarded-For': '198.51.100.10' } });
  for (const [coords, extra] of [[[null, null]], [[[141.35, 43.06], [200, 43.06]]], [[['141', 43.06], [141.36, 43.07]]], [[[141.35, 43.06], [141.36, 43.07]], { corridorM: 'Infinity' }], [[[141.35, 43.06], [141.36, 43.07]], { corridorM: 1000 }]]) {
    const r = await line(coords, extra);
    assert.strictEqual(r.res.status, 400, JSON.stringify([coords, extra]));
  }
  assert.strictEqual((await line([[141.35, 43.06], [141.36, 43.07]])).res.status, 200, '正しい経路は通る');
});

test('S1 共通の防御ヘッダー・X-Powered-By を出さない・大きすぎる本文は 413 PAYLOAD_TOO_LARGE', async () => {
  const r = await fetch(base + '/api/signals');
  assert.strictEqual(r.headers.get('x-powered-by'), null);
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
  const big = await call('/api/logs', { method: 'POST', body: { シナリオ: 'x'.repeat(200 * 1024) } });
  assert.strictEqual(big.res.status, 413);
  assert.strictEqual(big.body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('S3 書き込みのレート制限：同じ IP から1分に30回までは通り、31回目は 429。別の IP は数えない', async () => {
  const headers = { 'X-Forwarded-For': '203.0.113.7' };
  for (let i = 0; i < 30; i++) {
    const r = await call('/api/calibration', { method: 'POST', headers, body: { 歩幅: 0.8, 通常BPM: 150 } });
    assert.strictEqual(r.res.status, 200, `${i + 1}回目`);
  }
  const last = await call('/api/calibration', { method: 'POST', headers, body: { 歩幅: 0.8, 通常BPM: 150 } });
  assert.strictEqual(last.res.status, 429);
  assert.strictEqual(last.body.error.code, 'RATE_LIMITED');
  const other = await call('/api/calibration', { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.8' }, body: { 歩幅: 0.8, 通常BPM: 150 } });
  assert.strictEqual(other.res.status, 200);
  // x-vercel-forwarded-for など、X-Forwarded-For 以外の転送ヘッダーでは別の IP にならない
  const spoof = await call('/api/calibration', { method: 'POST', headers: { ...headers, 'X-Vercel-Forwarded-For': '192.0.2.1' }, body: { 歩幅: 0.8, 通常BPM: 150 } });
  assert.strictEqual(spoof.res.status, 429);
});
