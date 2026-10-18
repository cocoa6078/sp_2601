// 記録数の上限と、案内の巻き戻し・signal の検査（セキュリティの再レビューで見つかった点）。読み込みより前に環境変数を設定する
process.env.RUNWAVE_RATE_KEYS_MAX = '3';
process.env.RUNWAVE_LOGS_FILE = require('path').join(require('os').tmpdir(), `runwave-logs-lim-${process.pid}.json`);
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

test('S3 along-route：IP の記録が上限（ここでは3）に達したら、新しい IP は記録せず 429。記録済みの IP は通る', async () => {
  const along = (ip) => call('/api/signals/along-route', { method: 'POST', headers: { 'X-Forwarded-For': ip }, body: { route: { type: 'LineString', coordinates: [[141.35, 43.06], [141.36, 43.07]] } } });
  for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) assert.strictEqual((await along(ip)).res.status, 200, ip);
  const fourth = await along('192.0.2.4');
  assert.strictEqual(fourth.res.status, 429);
  assert.strictEqual(fourth.body.error.code, 'RATE_LIMITED');
  assert.strictEqual((await along('192.0.2.1')).res.status, 200, '記録済みの IP は数え続ける');
});

test('S3 書き込みのレート制限も、記録が上限に達したら新しい IP は 429', async () => {
  const calib = (ip) => call('/api/calibration', { method: 'POST', headers: { 'X-Forwarded-For': ip }, body: { 歩幅: 0.8, 通常BPM: 150 } });
  for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) assert.strictEqual((await calib(ip)).res.status, 200, ip);
  assert.strictEqual((await calib('198.51.100.4')).res.status, 429);
});

test('S8 案内が期限切れで消えても、古い番号への巻き戻しは 409', async () => {
  const id = `lim-seq-${Date.now()}-abcdef`;
  const first = await call(`/api/sessions/${id}/guidance`, { method: 'PUT', headers: { 'X-Forwarded-For': '203.0.113.50' }, body: { guidanceSeq: 50, expiresAt: new Date(Date.now() - 1000).toISOString() } });
  assert.strictEqual(first.res.status, 200);
  const token = first.body.writeToken;
  assert.strictEqual((await call(`/api/sessions/${id}/guidance`)).res.status, 410);
  const back = await call(`/api/sessions/${id}/guidance`, { method: 'PUT', headers: { 'X-Forwarded-For': '203.0.113.50', 'X-Session-Token': token }, body: { guidanceSeq: 1 } });
  assert.strictEqual(back.res.status, 409);
  assert.strictEqual(back.body.error.code, 'CONFLICT');
  const next = await call(`/api/sessions/${id}/guidance`, { method: 'PUT', headers: { 'X-Forwarded-For': '203.0.113.50', 'X-Session-Token': token }, body: { guidanceSeq: 51 } });
  assert.strictEqual(next.res.status, 200);
});

test('S7 案内の signal：長いキー名・Infinity（生 JSON の 1e309）は 400', async () => {
  const id = `lim-sig-${Date.now()}-abcdef`;
  const longKey = await call(`/api/sessions/${id}/guidance`, { method: 'PUT', headers: { 'X-Forwarded-For': '203.0.113.50' }, body: { guidanceSeq: 1, signal: { ['k'.repeat(1000)]: 1 } } });
  assert.strictEqual(longKey.res.status, 400);
  const inf = await call(`/api/sessions/${id}x/guidance`, { method: 'PUT', headers: { 'X-Forwarded-For': '203.0.113.50' }, raw: '{"guidanceSeq":1,"signal":{"remainingS":1e309}}' });
  assert.strictEqual(inf.res.status, 400);
});
