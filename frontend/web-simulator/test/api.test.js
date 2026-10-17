import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCalibration, fetchSignals } from '../src/api.js';

const resp = (body, status = 200) => async () => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const sig = (id, extra = {}) => ({ signalId: id, lat: 43.06, lon: 141.35, cycleS: 100, greenS: 40, yellowS: 5, redS: 55, phaseS: 0, crossingM: 15, note: 'n', ...extra });

test('fetchSignals: 成功（座標つき・region 無しは api 扱い）', async () => {
  const r = await fetchSignals('http://localhost:3001', { fetchImpl: resp({ ステータス: '成功', データ: [sig('a'), sig('b')] }) });
  assert.equal(r.ok, true);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0].key, 'api:a');
  assert.equal(r.candidates[0].lng, 141.35);
});

test('fetchSignals: 座標なしは NaN で返す／不正な信号は invalid に分ける', async () => {
  const r = await fetchSignals('http://localhost:3001', { fetchImpl: resp({ ステータス: '成功', データ: [sig('a', { lat: undefined }), sig('b', { greenS: 'x' })] }) });
  assert.equal(r.ok, true);
  assert.ok(Number.isNaN(r.candidates[0].lat));
  assert.equal(r.invalid.length, 1);
});

test('fetchSignals: 0 件・HTTP エラー・不正 JSON・接続失敗・ステータス失敗・URL 不正はすべて理由つきで失敗', async () => {
  const bad = [
    [resp({ ステータス: '成功', データ: [] }), /0 件|空/],
    [resp('x', 500), /HTTP 500/],
    [resp('{not json'), /JSON/],
    [async () => { throw new TypeError('fetch failed'); }, /接続できません/],
    [resp({ ステータス: 'エラー', データ: [sig('a')] }), /ステータス/],
  ];
  for (const [f, re] of bad) {
    const r = await fetchSignals('http://localhost:3001', { fetchImpl: f });
    assert.equal(r.ok, false);
    assert.match(r.error, re);
    assert.equal(r.candidates.length, 0);
  }
  assert.match((await fetchSignals('localhost:3001')).error, /http/);
});

test('fetchSignals: タイムアウト', async () => {
  const never = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
  const r = await fetchSignals('http://localhost:3001', { fetchImpl: never, timeoutMs: 20 });
  assert.match(r.error, /タイムアウト/);
});

test('fetchCalibration: 日本語キー／NormalBPM を受け付ける、欠落は失敗', async () => {
  const ok = await fetchCalibration('http://localhost:3001', { fetchImpl: resp({ ステータス: '成功', データ: { 歩幅: 0.85, NormalBPM: 160 } }) });
  assert.deepEqual(ok.runner, { strideM: 0.85, baseBpm: 160 });
  const ng = await fetchCalibration('http://localhost:3001', { fetchImpl: resp({ ステータス: '成功', データ: { 歩幅: 0.85 } }) });
  assert.equal(ng.ok, false);
});
