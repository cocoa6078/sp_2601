import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from './mock-server.js';
import { runChecks } from './api-check.js';
import { extractSignals, extractRunner, toCalibrationBody, toLogBody } from '../core/api-adapter.js';

async function withServer(opts, fn) {
  const server = createMockServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---------- 変換（API → core） ----------
test('extractSignals: 配列・{signals}・単体のどれでも読み、F-02 以外の名前は受け付けない', () => {
  const s = { cycleS: 120, greenS: 50, yellowS: 5, redS: 65, phaseS: 0, crossingM: 20 };
  assert.equal(extractSignals([s])[0].signal.cycleS, 120);
  assert.equal(extractSignals({ signals: [s] })[0].signal.greenS, 50);
  assert.equal(extractSignals(s)[0].signal.redS, 65);
  const r = extractSignals({ cycle: 120, green: 50 })[0];
  assert.equal(r.signal, null);
  assert.ok(r.problems.includes('cycleS がない'));
});

test('extractSignals: 合計が周期と合わない・数値でない値を報告する', () => {
  const bad = extractSignals({ cycleS: 120, greenS: 50, yellowS: 5, redS: 60, phaseS: 0, crossingM: '20' })[0];
  assert.ok(bad.problems.some((p) => p.startsWith('crossingM が数値でない')));
  const sum = extractSignals({ cycleS: 120, greenS: 50, yellowS: 5, redS: 60, phaseS: 0, crossingM: 20 })[0];
  assert.ok(sum.problems.some((p) => p.includes('一致しない')));
});

test('extractSignals: ガイドの形 { ステータス: 成功, データ: [...] } を読み、signalId と note を残す', () => {
  const json = { 'ステータス': '成功', 'データ': [
    { signalId: 'sapporo_3', cycleS: 125, greenS: 39, yellowS: 5, redS: 81, phaseS: 0, crossingM: 15.0, note: '車両用' },
  ] };
  const [r] = extractSignals(json);
  assert.deepEqual(r.problems, []);
  assert.equal(r.id, 'sapporo_3');
  assert.deepEqual(r.signal, { cycleS: 125, greenS: 39, yellowS: 5, redS: 81, phaseS: 0, crossingM: 15 });
  assert.ok(extractSignals({ 'ステータス': '失敗', 'データ': [] })[0].problems.some((p) => p.includes('失敗')));
});

test('extractRunner: ガイドの日本語キー（歩幅・通常BPM）と英語キーを読み、正の数値だけ受け付ける', () => {
  assert.deepEqual(extractRunner({ '歩幅': 0.85, '通常BPM': 160 }).runner, { strideM: 0.85, baseBpm: 160 });
  assert.deepEqual(extractRunner({ 'ステータス': '成功', 'データ': { '歩幅': 0.8, '通常BPM': 150 } }).runner, { strideM: 0.8, baseBpm: 150 });
  assert.deepEqual(extractRunner({ strideM: 0.8, baseBpm: 150 }).runner, { strideM: 0.8, baseBpm: 150 });
  assert.equal(extractRunner({ '歩幅': -1, '通常BPM': 150 }).runner, null);
});

test('toCalibrationBody / toLogBody: ガイドの形で送る', () => {
  assert.deepEqual(toCalibrationBody({ strideM: 0.85, baseBpm: 160 }), { '歩幅': 0.85, '通常BPM': 160 });
  assert.deepEqual(toLogBody('RUNWAVE適用時', { stops: 0, totalTimeS: 283.4 }), { 'シナリオ': 'RUNWAVE適用時', '停止回数': 0, '総所要時間': 283.4 });
});

// ---------- 確認スクリプト（偽サーバー相手） ----------
test('api-check: 計画どおりの API なら全項目 OK、取得した信号で core が最後まで走る', async () => {
  const rep = await withServer({}, (url) => runChecks(url, { write: true }));
  const ng = rep.results.filter((r) => !r.ok);
  assert.deepEqual(ng.map((r) => `${r.id}: ${r.problems}`), []);
  assert.equal(rep.core.signals.length, 2);
  for (const s of rep.core.signals) {
    assert.deepEqual(s.problems, []);
    assert.equal(s.summary.normal.finished, true);
    assert.equal(s.summary.runwave.finished, true);
  }
  assert.deepEqual(rep.core.runner.runner, { strideM: 0.8, baseBpm: 150 });
});

test('api-check: --write なしでは POST を送らない', async () => {
  const rep = await withServer({}, (url) => runChecks(url));
  const posts = rep.results.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 0);
  assert.ok(rep.results.some((r) => r.skipped));
});

test('api-check: 500・HTML・合計の不一致を NG として報告する', async () => {
  const rep = await withServer({ broken: true }, (url) => runChecks(url, { write: true }));
  const nobody = rep.results.find((r) => r.id === 'calibration-post-nobody');
  assert.equal(nobody.ok, false);
  assert.ok(nobody.problems.some((p) => p.includes('サーバーエラー')));
  assert.ok(nobody.problems.some((p) => p.includes('JSON でない')));
  assert.ok(rep.core.signals[1].problems.some((p) => p.includes('一致しない')));
});

test('api-check: つながらない URL はエラーとして記録し、例外で止まらない', async () => {
  const rep = await runChecks('http://127.0.0.1:9', { config: { timeoutMs: 2000, checks: [{ id: 'x', kind: 'read', method: 'GET', path: '/api/signals', expect: '2xx' }] } });
  assert.equal(rep.results[0].ok, false);
  assert.ok(rep.results[0].problems[0]);
});

test('extractRunner: バックエンドが保存後に返す NormalBPM と、早歩きの歩幅 walkStrideM も読む', () => {
  assert.deepEqual(extractRunner({ 'ステータス': '成功', 'データ': { '歩幅': 0.85, 'NormalBPM': 160, walkStrideM: 0.75 } }).runner,
    { strideM: 0.85, baseBpm: 160, walkStrideM: 0.75 });
  assert.deepEqual(extractRunner({ '歩幅': 0.8, '通常BPM': 150 }).runner, { strideM: 0.8, baseBpm: 150 });  // walkStrideM は任意
  assert.equal(extractRunner({ '歩幅': 0.8, '通常BPM': 150, walkStrideM: -1 }).runner, null);
});
