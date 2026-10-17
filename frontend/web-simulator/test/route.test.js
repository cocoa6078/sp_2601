import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeNs } from '../src/core-ns.js';
import { createPair, expectedFor, matchesExpected, pairDone, planFromMap, runnerView, stepPair, summaryOf } from '../src/engine-adapter.js';
import { Playback } from '../src/playback.js';
import { buildRoute, pointAtDistance } from '../src/route-geometry.js';
import { matchSignals } from '../src/route-builder.js';
import { defaultRunnerAndControl, getDemo } from '../src/scenarios.js';
import { DEMO_ROUTE_POINTS, FIXTURE_SIGNALS } from '../src/fixtures.js';
import { fetchSignals } from '../src/api.js';

const sg = (cycleS, greenS, phaseS) => ({ cycleS, greenS: greenS - 5, yellowS: 5, redS: cycleS - greenS, phaseS, crossingM: 15 });
const cand = (key, route, s, signal) => ({ key, signalId: key.split(':')[1], ...pointAtDistance(route, s), signal, origin: 'test' });

// 一直線に近い 1500m の折れ線（途中点あり）。信号 4 件: 位相を変えて赤待ちが出る条件を含める
const longPts = [{ lat: 43.05, lng: 141.35 }, { lat: 43.0556, lng: 141.3502 }, { lat: 43.0640, lng: 141.3505 }];
const route = buildRoute(longPts);
function planWith(positions, phases) {
  const cands = positions.map((s, i) => cand(`t:s${i + 1}`, route, s, sg(120, 50, phases[i])));
  const m = matchSignals(route, cands);
  assert.deepEqual(m.errors, []);
  const { runner, control } = defaultRunnerAndControl();
  const plan = planFromMap({ route, adopted: m.adopted, runner, control });
  assert.equal(plan.kind, m.adopted.length > 1 ? 'route' : 'single');
  return plan.config;
}

const runPair = (config) => { let p = createPair(config); while (!pairDone(p)) p = stepPair(p); return p; };

for (const [name, pos, phases] of [
  ['3 信号', [250, 600, 950], [100, 26, 60]],
  ['4 信号', [200, 500, 800, 1100], [20, 90, 5, 70]],
  ['5 信号', [150, 400, 650, 900, 1150], [0, 40, 80, 110, 30]],
]) {
  test(`${name}: 1 tick ずつの結果が compareRoute と一致（信号ごとの結果も）`, () => {
    const config = planWith(pos, phases);
    assert.ok(config.signals.length >= 3 && config.goalM > config.signals.at(-1).atM);
    const exp = expectedFor(config);
    const pair = runPair(config);
    const m = matchesExpected(pair, exp);
    assert.ok(m.ok, m.diffs.join('; '));
    assert.deepEqual(summaryOf(pair.runwave), exp.runwave);
    assert.equal(summaryOf(pair.runwave).signals.length, config.signals.length);
  });
}

test('赤待ちのある条件を含む: 通常が待ち、イベントは arrive/waitStart/waitEnd/crossStart/crossEnd の順で記録される', () => {
  let found = null;
  for (let ph = 0; ph < 120 && !found; ph += 10) {
    const config = planWith([250, 600, 950], [ph, 26, 60]);
    const e = expectedFor(config);
    if (e.normal.stops >= 1) found = { config, e };
  }
  assert.ok(found, '待ちが出る位相が見つかる');
  const pair = runPair(found.config);
  const ps = summaryOf(pair.normal).signals;
  const w = ps.find((s) => s.waited);
  assert.ok(w && w.waitS > 0 && w.colorAtArrive !== 'green');
  const types = pair.normal.state.events.filter((e) => e.signalId === w.signalId).map((e) => e.type);
  assert.deepEqual(types, ['arrive', 'waitStart', 'waitEnd', 'crossStart', 'crossEnd']);
  // 待った信号の到着色は非青、通過した信号は青で進入（描画時刻ではなくイベントが正）
  for (const s of summaryOf(pair.runwave).signals) if (s.passed) assert.equal(s.colorAtCross, 'green');
});

test('再生（フレーム刻み・倍速・一時停止・フレーム上限が違っても）の結果が compareRoute と一致、イベントは state.events 由来', () => {
  const config = planWith([200, 500, 800, 1100], [20, 90, 5, 70]);
  const exp = expectedFor(config);
  const finals = [];
  for (const [speed, dt, maxTicks] of [[1, 1 / 60, 50], [5, 0.0333, 7], [2, 0.5, 3], [5, 0.5, 50]]) {
    const pb = new Playback(config, { maxTicksPerFrame: maxTicks });
    pb.setSpeed(speed);
    pb.play();
    let f = 0;
    while (pb.status !== 'completed' && f < 1e6) {
      pb.frame(dt);
      f++;
      if (f % 89 === 0) { pb.pause(); pb.frame(1); pb.play(); }
    }
    assert.ok(matchesExpected(pb.pair, exp).ok);
    finals.push({ s: summaryOf(pb.pair.runwave), ev: pb.events.length });
    const rwEv = pb.pair.runwave.state.events.length + pb.pair.normal.state.events.length;
    assert.equal(pb.events.length, rwEv);
  }
  for (const f of finals) assert.deepEqual(f, finals[0]);
});

test('runnerView: 複数信号で次の信号・距離・通過済み・完走後が正しい', () => {
  const config = planWith([250, 600, 950], [100, 26, 60]);
  let p = createPair(config);
  const first = runnerView(p.runwave, 0);
  assert.equal(first.signalCount, 3);
  assert.ok(Math.abs(first.distToSignalM - config.signals[0].atM) < 1e-9);
  let maxIdx = 0;
  while (!pairDone(p)) { p = stepPair(p); maxIdx = Math.max(maxIdx, runnerView(p.runwave, p.tick / 10).signalIndex); }
  assert.equal(maxIdx, 3);
  const fin = runnerView(p.runwave, p.tick / 10);
  assert.equal(fin.distToSignalM, null);
  assert.equal(fin.speedMps, 0);
});

test('1 信号の経路は単信号のまま（route-core と結果が一致）', () => {
  const config = planWith([600], [30]);
  assert.ok(Array.isArray(config.signals) === false);
  const single = expectedFor(config);
  const asRoute = routeNs.compareRoute({ runner: config.runner, control: config.control, goalM: config.route.goalX, signals: [{ id: 'a', atM: config.route.crossingX, signal: config.signal }] });
  for (const k of ['normal', 'runwave']) {
    for (const f of ['stops', 'stopTimeS', 'totalTimeS', 'walkCount']) assert.equal(asRoute[k][f], single[k][f], `${k}.${f}`);
  }
});

test('複数信号の atM は経路の開始点から測り直した s、goalM は経路長（API の distanceFromStartM は使わない）', () => {
  const r2 = buildRoute(DEMO_ROUTE_POINTS);
  const m = matchSignals(r2, FIXTURE_SIGNALS.map((f) => ({ ...f, distanceFromStartM: 9999 })));
  const config = planFromMap({ route: r2, adopted: [{ ...m.adopted[0], s: 200, key: 'a' }, { ...m.adopted[0], s: 400, key: 'b' }], ...defaultRunnerAndControl() }).config;
  assert.deepEqual(config.signals.map((s) => s.atM), [200, 400]);
  assert.equal(config.goalM, r2.lengthM);
  assert.deepEqual(config.signals.map((s) => s.id), ['a', 'b']);
});

test('不正な複数信号条件（goalM が最後の信号の手前）は invalid', () => {
  const r2 = buildRoute(DEMO_ROUTE_POINTS);
  const m = matchSignals(r2, FIXTURE_SIGNALS);
  const a = m.adopted[0];
  const plan = planFromMap({ route: r2, adopted: [{ ...a, key: 'a', s: 100 }, { ...a, key: 'b', s: r2.lengthM - 5 }], ...defaultRunnerAndControl() });
  assert.equal(plan.kind, 'invalid');
});

test('api: adapter の lat/lon を使う（座標なしは NaN）', async () => {
  const body = { ステータス: '成功', データ: [{ signalId: 'a', lat: 43.06, lon: 141.35, cycleS: 100, greenS: 40, yellowS: 5, redS: 55, phaseS: 0, crossingM: 15 }, { signalId: 'b', cycleS: 100, greenS: 40, yellowS: 5, redS: 55, phaseS: 0, crossingM: 15 }] };
  const r = await fetchSignals('http://localhost:3001', { fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify(body) }) });
  assert.equal(r.candidates[0].lat, 43.06);
  assert.equal(r.candidates[0].lng, 141.35);
  assert.ok(Number.isNaN(r.candidates[1].lat));
  assert.ok(getDemo('B'));
});
