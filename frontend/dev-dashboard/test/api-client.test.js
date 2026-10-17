// API 判定のテスト。tools/mock-server.js の createMockServer を実ポートで起動して確認する（モックの fetch は使わない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMockServer } from '../../../tools/mock-server.js';
import { ENDPOINTS, applyApiSignal, buildUrl, checkAll, checkEndpoint, overallStatus } from '../src/api-client.js';
import { getFixedScenario } from '../src/sim-engine.js';

const byId = (id) => ENDPOINTS.find((e) => e.id === id);

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
/** 指定した応答を返すだけのサーバー */
function fixedServer(handler) {
  return createServer((req, res) => handler(req, res));
}
const json = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

async function withServer(server, fn) {
  const port = await listen(server);
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await close(server);
  }
}

test('正常な API（偽サーバー）: 3 本とも成功し、取得時刻・HTTP・内容が入る', async () => {
  await withServer(createMockServer(), async (base) => {
    const methods = [];
    const fetchImpl = (url, init) => {
      methods.push(init.method);
      return fetch(url, init);
    };
    const results = await checkAll(base, { fetchImpl });
    assert.deepEqual(results.map((r) => r.id), ['signals', 'calibration', 'logs']);
    for (const r of results) {
      assert.equal(r.status, 'success', `${r.id}: ${r.problems.join(' / ')}`);
      assert.equal(r.httpStatus, 200);
      assert.ok(!Number.isNaN(Date.parse(r.at)), '取得時刻が ISO 形式');
      assert.deepEqual(r.problems, []);
    }
    const sig = results[0].data.signals;
    assert.equal(sig.length, 2);
    assert.equal(sig[0].id, 'sapporo_3');
    assert.equal(sig[0].signal.crossingM, 15);
    assert.deepEqual(results[1].data.runner, { strideM: 0.8, baseBpm: 150 });
    assert.equal(results[2].data.count, 0);
    assert.equal(overallStatus(results), 'success');
    assert.deepEqual([...new Set(methods)], ['GET'], 'GET 以外は送らない（POST で書き込まない）');
    assert.equal(methods.length, 3);
  });
});

test('broken: true の偽サーバー: 一部不正の信号は「成功＋警告」、HTTP 500 の HTML は失敗', async () => {
  await withServer(createMockServer({ broken: true }), async (base) => {
    const sig = await checkEndpoint(base, byId('signals'));
    assert.equal(sig.status, 'success', '使える信号が 1 件以上あれば成功');
    assert.equal(sig.warnings.length, 1);
    assert.match(sig.warnings[0], /mock_demo.*cycleS/);
    assert.equal(sig.data.signals.filter((x) => x.signal).length, 1);
    assert.equal(sig.data.signals.find((x) => x.id === 'mock_demo').signal, null);

    // 存在しない URL → broken では 500 の HTML が返る（B1〜B3 未対応時の振る舞い）
    const bad = await checkEndpoint(base, { id: 'logs', path: '/api/missing', label: 'missing' });
    assert.equal(bad.status, 'failure');
    assert.equal(bad.httpStatus, 500);
    assert.ok(bad.problems.some((p) => /HTTP 500/.test(p)));
    assert.ok(bad.problems.some((p) => /Content-Type が JSON ではない/.test(p)));
    assert.ok(bad.problems.some((p) => /JSON として読めない/.test(p)));
  });
});

test('接続不可（誰も待っていないポート）は失敗として理由を示し、例外を投げない', async () => {
  const s = createServer();
  const port = await listen(s);
  await close(s); // このポートはもう誰も待っていない
  const r = await checkEndpoint(`http://127.0.0.1:${port}`, byId('signals'), { timeoutMs: 2000 });
  assert.equal(r.status, 'failure');
  assert.equal(r.httpStatus, null);
  assert.match(r.problems[0], /接続できません/);
  assert.equal(overallStatus([r]), 'failure');
});

test('タイムアウト: 応答しないサーバーを打ち切り、再試行できる', async () => {
  const hang = fixedServer(() => {}); // 何も返さない
  const port = await listen(hang);
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  const r = await checkEndpoint(base, byId('signals'), { timeoutMs: 200 });
  assert.ok(Date.now() - t0 < 3000, '打ち切られる');
  assert.equal(r.status, 'failure');
  assert.match(r.problems[0], /タイムアウト（200ms/);
  await close(hang);

  // 本文の途中で止まる場合も同じ（ヘッダーだけ送って終わらない）
  const half = fixedServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"ステ');
  });
  const r2 = await checkEndpoint(`http://127.0.0.1:${await listen(half)}`, byId('signals'), { timeoutMs: 200 });
  assert.equal(r2.status, 'failure');
  assert.match(r2.problems[0], /タイムアウト/);
  await close(half);

  // 再試行: 同じ関数をもう一度呼べば、直った API は成功になる
  await withServer(createMockServer(), async (okBase) => {
    const retry = await checkEndpoint(okBase, byId('signals'), { timeoutMs: 200 });
    assert.equal(retry.status, 'success');
  });
});

test('JSON 以外の応答（HTTP 200 の HTML）は失敗', async () => {
  await withServer(fixedServer((req, res) => json(res, 200, '<html>hello</html>', 'text/html')), async (base) => {
    const r = await checkEndpoint(base, byId('signals'));
    assert.equal(r.status, 'failure');
    assert.equal(r.httpStatus, 200);
    assert.ok(r.problems.some((p) => /Content-Type が JSON ではない/.test(p)));
    assert.ok(r.problems.some((p) => /JSON として読めない/.test(p)));
  });
});

test('HTTP 200 でも、空の信号一覧・全件不正・本文ステータス失敗は「利用可能」にしない', async () => {
  const cases = [
    [{ 'ステータス': '成功', 'データ': [] }, /空/],
    [{ 'ステータス': '成功', 'データ': [{ signalId: 'x', cycleS: 'abc', greenS: 1, yellowS: 1, redS: 1, phaseS: 0, crossingM: 15 }] }, /使える信号が 0 件/],
    [{ 'ステータス': '成功', 'データ': [{ signalId: 'neg', cycleS: -10, greenS: -5, yellowS: -2, redS: -3, phaseS: 0, crossingM: 15 }] }, /使える信号が 0 件/],
    [{ 'ステータス': '失敗', 'エラー': 'サーバー内部エラー' }, /本文のステータスが「失敗」/],
    [{ 'ステータス': '成功', 'データ': [{ signalId: 'sum', cycleS: 120, greenS: 50, yellowS: 5, redS: 60, phaseS: 0, crossingM: 15 }] }, /一致しない/],
  ];
  for (const [body, re] of cases) {
    await withServer(fixedServer((req, res) => json(res, 200, body)), async (base) => {
      const r = await checkEndpoint(base, byId('signals'));
      assert.equal(r.status, 'failure', JSON.stringify(body));
      assert.equal(r.httpStatus, 200, 'HTTP は 200 でも失敗になる');
      assert.ok(r.problems.some((p) => re.test(p)), `${JSON.stringify(body)} → ${r.problems.join(' | ')}`);
    });
  }
});

test('calibration と logs の形式検証（不正値・配列でない・空配列は有効）', async () => {
  const run = async (id, body) =>
    withServer(fixedServer((req, res) => json(res, 200, body)), (base) => checkEndpoint(base, byId(id)));
  const badCal = await run('calibration', { 'ステータス': '成功', 'データ': { '歩幅': -1, '通常BPM': 150 } });
  assert.equal(badCal.status, 'failure');
  assert.match(badCal.problems.join(' '), /歩幅/);
  const noCal = await run('calibration', { 'ステータス': '成功', 'データ': {} });
  assert.equal(noCal.status, 'failure');
  const okCal = await run('calibration', { 'ステータス': '成功', 'データ': { '歩幅': 0.85, '通常BPM': 160 } });
  assert.equal(okCal.status, 'success');
  assert.deepEqual(okCal.data.runner, { strideM: 0.85, baseBpm: 160 });
  const badLogs = await run('logs', { 'ステータス': '成功', 'データ': 'none' });
  assert.equal(badLogs.status, 'failure');
  const emptyLogs = await run('logs', { 'ステータス': '成功', 'データ': [] });
  assert.equal(emptyLogs.status, 'success');
  assert.equal(emptyLogs.data.count, 0);
});

test('URL の誤りは失敗として返す。overallStatus は未確認 / 失敗 / 成功を区別する', async () => {
  assert.throws(() => buildUrl('localhost:3001', '/api/signals'), TypeError);
  const r = await checkEndpoint('localhost:3001', byId('signals'));
  assert.equal(r.status, 'failure');
  assert.match(r.problems[0], /http:\/\//);
  assert.equal(overallStatus([]), 'unchecked');
  assert.equal(overallStatus(undefined), 'unchecked');
  assert.equal(overallStatus([{ status: 'success' }]), 'unchecked', '3 本そろうまで成功にしない');
  assert.equal(buildUrl('http://localhost:3001', '/api/signals'), 'http://localhost:3001/api/signals');
  assert.equal(buildUrl('http://localhost:3001/', '/api/logs'), 'http://localhost:3001/api/logs');
});

test('applyApiSignal: API の crossingM は横断幅（signal.crossingM）に入り、route.crossingX は変わらない', () => {
  const base = getFixedScenario('B').config;
  const r = applyApiSignal(base, { cycleS: 125, greenS: 39, yellowS: 5, redS: 81, phaseS: 0, crossingM: 15 });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.config.signal, { cycleS: 125, greenS: 39, yellowS: 5, redS: 81, phaseS: 0, crossingM: 15 });
  assert.equal(r.config.route.crossingX, 400);
  assert.deepEqual(r.config.runner, base.runner);
  assert.deepEqual(r.config.control, base.control);
  assert.equal(base.signal.cycleS, 120, '元の config は変更されない');

  // core が受け付けない組み合わせはエラー文で返す（length で横断幅が大きすぎる）
  const len = { ...base, control: { ...base.control, crossingModel: 'length' } };
  const bad = applyApiSignal(len, { cycleS: 120, greenS: 50, yellowS: 5, redS: 65, phaseS: 0, crossingM: 300 });
  assert.equal(bad.config, undefined);
  assert.match(bad.error, /goalX/);
});
