// 公開デモ（Vercel）では既定で書き込み禁止（S2）。読み込みより前に環境変数を設定する。
// VERCEL=1 で DEMO_READONLY を設定しない＝本番と同じ条件。ログの保存先は一時フォルダ
process.env.VERCEL = '1';
delete process.env.DEMO_READONLY;
process.env.RUNWAVE_LOGS_FILE = require('path').join(require('os').tmpdir(), `runwave-logs-ro-${process.pid}.json`);
const test = require('node:test');
const assert = require('node:assert');
const app = require('../index.js');

let server;
let base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise((r) => server.close(r)); });

const send = (path, method, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('S2 Vercel では既定で：校正値の書き換え・ログの読み書き・案内の中継は 403 READ_ONLY', async () => {
  const id = 'readonly-session-0123456789';
  const blocked = [
    await send('/api/calibration', 'POST', { 歩幅: 0.9, 通常BPM: 170 }),
    await send('/api/logs', 'POST', { シナリオ: 'x', 停止回数: 0 }),
    await send('/api/logs', 'GET'),
    await send('/api/logs/log_1', 'GET'),
    await send(`/api/sessions/${id}/guidance`, 'PUT', { guidanceSeq: 1 }),
    await send(`/api/sessions/${id}/guidance`, 'GET'),
  ];
  for (const r of blocked) {
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await r.json()).error.code, 'READ_ONLY');
  }
  const calib = await (await send('/api/calibration', 'GET')).json();
  assert.strictEqual(calib.データ.通常BPM, 150, '書き換わっていない');
});

test('S2 デモで使う読み取りはそのまま：信号（デモ・全件・地域）・校正値の取得・along-route', async () => {
  for (const p of ['/api/signals', '/api/signals/all', '/api/calibration']) assert.strictEqual((await send(p, 'GET')).status, 200, p);
  const region = await send(`/api/signals/region/${encodeURIComponent('札幌方面')}`, 'GET');
  assert.strictEqual(region.status, 200);
  const along = await send('/api/signals/along-route', 'POST', { route: { type: 'LineString', coordinates: [[141.35, 43.06], [141.36, 43.07]] } });
  assert.strictEqual(along.status, 200);
});
