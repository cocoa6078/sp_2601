// SIM-06: 極端な条件でも落ちずに理由が出る／DATA-03: 校正値の欠損・不正はエラー
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCalibration } from '../src/api.js';
import { createPair, expectedFor, pairDone, planFromMap, stepPair, summaryOf } from '../src/engine-adapter.js';
import { Playback } from '../src/playback.js';
import { buildRoute } from '../src/route-geometry.js';
import { matchSignals } from '../src/route-builder.js';
import { defaultRunnerAndControl } from '../src/scenarios.js';
import { buildTimeSeriesCsv } from '../src/report.js';

const rc = defaultRunnerAndControl();
// 南北 約 500 m の直線
const route = buildRoute([{ lat: 43.06, lng: 141.35 }, { lat: 43.0645, lng: 141.35 }], { id: 't', source: 'test' });
const sigAt = (lat, extra = {}, key = 'a') => ({ key, signalId: key, lat, lng: 141.35, signal: { cycleS: 100, greenS: 40, yellowS: 5, redS: 55, phaseS: 0, crossingM: 15, ...extra } });

/** 地図コースと同じ流れ（matchSignals → planFromMap）→ 最後まで走らせる。落ちないこと・理由が文字列で出ることを確かめる */
function runCase({ runner = rc.runner, cands }) {
  const m = matchSignals(route, cands, {});
  if (m.errors.length) return { kind: 'invalid', reason: m.errors.join(' / ') };
  if (m.adopted.length === 0) return { kind: 'none', reason: m.excluded.map((e) => e.reason).join(' / ') || 'この経路に対応する信号なし' };
  const plan = planFromMap({ route, adopted: m.adopted, runner, control: rc.control });
  if (plan.kind !== 'single' && plan.kind !== 'route') return plan;
  const exp = expectedFor(plan.config);
  const pb = new Playback(plan.config);
  pb.play();
  let guard = 0;
  while (pb.status === 'playing' && guard++ < 1e6) pb.frame(0.5);
  const csv = buildTimeSeriesCsv(pb.series);
  return { ...plan, exp, pb, csv };
}

test('低速（歩幅が極小）: 落ちずに時間切れ（timedOut）として終わる', () => {
  const r = runCase({ runner: { ...rc.runner, strideM: 0.05 }, cands: [sigAt(43.062)] });
  assert.equal(r.kind, 'single');
  assert.equal(r.pb.status, 'completed');
  assert.equal(r.pb.timedOut, true);
  assert.equal(r.pb.pair.tick, 18000);
  assert.ok(r.csv.length > 100);
});

test('低速（BPM が maxDeltaBpm 以下）: core が拒否し、理由つきの invalid になる（例外にしない）', () => {
  const r = runCase({ runner: { ...rc.runner, baseBpm: 5 }, cands: [sigAt(43.062)] });
  assert.equal(r.kind, 'invalid');
  assert.match(r.reason, /BPM/);
});

test('横断長 0: 落ちずに完走する（単信号・複数信号とも）', () => {
  const one = runCase({ cands: [sigAt(43.062, { crossingM: 0 })] });
  assert.equal(one.kind, 'single');
  assert.equal(one.pb.status, 'completed');
  const two = runCase({ cands: [sigAt(43.062, { crossingM: 0 }, 'a'), sigAt(43.0635, { crossingM: 0 }, 'b')] });
  assert.equal(two.kind, 'route');
  assert.equal(two.pb.status, 'completed');
});

test('横断時間が青の長さより長い（青 6 秒・横断 60 m）: 落ちずに完走。結果が数値で出る', () => {
  const sg = { cycleS: 100, greenS: 6, yellowS: 5, redS: 89, crossingM: 60 };
  const one = runCase({ cands: [sigAt(43.062, sg)] });
  assert.equal(one.kind, 'single');
  assert.equal(one.pb.status, 'completed');
  assert.ok(Number.isFinite(summaryOf(one.pb.pair.normal).stopTimeS));
  const slow = runCase({ runner: { ...rc.runner, strideM: 0.3 }, cands: [sigAt(43.062, sg)] });
  assert.equal(slow.pb.status, 'completed');
  const two = runCase({ cands: [sigAt(43.062, sg, 'a'), sigAt(43.0635, sg, 'b')] });
  assert.equal(two.kind, 'route');
  assert.equal(two.pb.status, 'completed');
});

test('横断長が大きすぎて信号同士が重なる: 理由つきエラー（落ちない）', () => {
  const r = runCase({ cands: [sigAt(43.062, { crossingM: 400 }, 'a'), sigAt(43.0625, { crossingM: 400 }, 'b')] });
  assert.equal(r.kind, 'invalid');
  assert.match(r.reason, /近すぎ/);
});

test('不正な信号値（横断長が負・NaN・文字列）: 除外理由が出て、計算には渡らない', () => {
  for (const crossingM of [-5, Number.NaN, 'x']) {
    const r = runCase({ cands: [sigAt(43.062, { crossingM })] });
    assert.equal(r.kind, 'none');
    assert.match(r.reason, /不正|対応する信号なし/);
  }
});

test('低速で時間上限まで 1 tick ずつ回しても例外が出ない', () => {
  const m = matchSignals(route, [sigAt(43.062)], {});
  const plan = planFromMap({ route, adopted: m.adopted, runner: { ...rc.runner, strideM: 0.05 }, control: rc.control });
  let p = createPair(plan.config);
  while (!pairDone(p)) p = stepPair(p);
  assert.equal(p.tick, 18000);
});

// ---- DATA-03: 校正値 ----
const resp = (body, status = 200) => async () => ({ status, text: async () => JSON.stringify(body) });
test('校正値: 欠損・0・負・文字列・null は runner を返さずエラー理由を返す（既定値で黙って埋めない）', async () => {
  const bad = [
    { 歩幅: 0.85 },
    { NormalBPM: 160 },
    { 歩幅: 0, NormalBPM: 160 },
    { 歩幅: -1, NormalBPM: 160 },
    { 歩幅: '0.8', NormalBPM: 160 },
    { 歩幅: 0.8, NormalBPM: null },
    {},
  ];
  for (const data of bad) {
    const r = await fetchCalibration('http://localhost:3001', { fetchImpl: resp({ ステータス: '成功', データ: data }) });
    assert.equal(r.ok, false, JSON.stringify(data));
    assert.equal(r.runner, undefined);
    assert.ok(r.error && r.error.length > 0);
  }
  const http = await fetchCalibration('http://localhost:3001', { fetchImpl: resp({}, 503) });
  assert.equal(http.ok, false);
  assert.match(http.error, /HTTP 503/);
});
