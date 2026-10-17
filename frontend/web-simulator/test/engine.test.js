import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../src/core-ns.js';
import { DEMO_SCENARIOS, getDemo, normalizeWalk } from '../src/scenarios.js';
import { createPair, expectedFor, matchesExpected, pairConfigs, pairDone, planFromMap, runnerView, secondsToGreen, signalConsistent, stepPair, summaryOf } from '../src/engine-adapter.js';
import { Playback } from '../src/playback.js';
import { buildRoute, pointAtDistance } from '../src/route-geometry.js';
import { matchSignals } from '../src/route-builder.js';
import { DEMO_ROUTE_POINTS, FIXTURE_SIGNALS } from '../src/fixtures.js';
import { defaultRunnerAndControl } from '../src/scenarios.js';

const runAll = (config) => {
  let p = createPair(config);
  while (!pairDone(p)) p = stepPair(p);
  return p;
};

test('デモ A/B/W が登録され、walk.enabled が明示される。endMarginS=5 を保持', () => {
  assert.deepEqual(DEMO_SCENARIOS.map((s) => s.id).sort(), ['A', 'B', 'W']);
  for (const s of DEMO_SCENARIOS) {
    assert.equal(s.config.control.walk.enabled, true);
    assert.equal(s.config.control.endMarginS, 5);
  }
  assert.equal(normalizeWalk(getDemo('B').config, false).control.walk.enabled, false);
});

test('pairConfigs: 差は control.enabled だけ（walk 設定は両方に保持）', () => {
  const { normal, runwave } = pairConfigs(getDemo('W').config);
  assert.equal(normal.control.enabled, false);
  assert.equal(runwave.control.enabled, true);
  assert.deepEqual({ ...normal, control: { ...normal.control, enabled: 0 } }, { ...runwave, control: { ...runwave.control, enabled: 0 } });
  assert.equal(normal.control.walk.enabled, true);
});

for (const id of ['B', 'W', 'A']) {
  test(`契約: ${id} を 1 tick ずつ回した結果が core.compare と一致`, () => {
    const config = getDemo(id).config;
    const exp = expectedFor(config);
    const pair = runAll(config);
    const m = matchesExpected(pair, exp);
    assert.ok(m.ok, m.diffs.join('; '));
    assert.deepEqual(summaryOf(pair.normal), exp.normal);
    assert.deepEqual(summaryOf(pair.runwave), exp.runwave);
  });
}

test('W: 通常は止まり、RUNWAVE は止まらず早歩きを使う（core の結果をそのまま表示）', () => {
  const exp = expectedFor(getDemo('W').config);
  assert.ok(exp.normal.stops >= 1);
  assert.equal(exp.runwave.stops, 0);
  assert.ok(exp.runwave.walkCount >= 1);
});

test('フレーム刻み・倍率・一時停止があっても結果は同じ（固定 tick）', () => {
  const config = getDemo('W').config;
  const exp = expectedFor(config);
  const finals = [];
  for (const [speed, dt, maxTicks] of [[1, 1 / 60, 50], [5, 0.0333, 7], [2, 0.5, 3], [5, 0.5, 50]]) {
    const pb = new Playback(config, { maxTicksPerFrame: maxTicks });
    pb.setSpeed(speed);
    pb.play();
    let frames = 0;
    while (pb.status !== 'completed' && frames < 1e6) {
      pb.frame(dt);
      frames++;
      if (frames % 97 === 0) { pb.pause(); pb.frame(1); pb.play(); } // 一時停止中は進まない
    }
    assert.ok(matchesExpected(pb.pair, exp).ok);
    finals.push(summaryOf(pb.pair.runwave));
  }
  for (const f of finals) assert.deepEqual(f, finals[0]);
});

test('Playback: 隠れていた実時間はまとめて計算しない（1 フレームの実時間上限）、reset で初期化', () => {
  const pb = new Playback(getDemo('B').config);
  pb.play();
  const n = pb.frame(600); // 10 分ぶんの隠れ時間
  assert.ok(n <= 5, `n=${n}`);
  pb.reset();
  assert.equal(pb.status, 'ready');
  assert.equal(pb.pair.tick, 0);
  assert.equal(pb.events.length, 0);
  assert.equal(pb.frame(1), 0, 'ready 中は進まない');
});

test('Playback: 交差点到達イベント（通常は赤で停止、RUNWAVE は進入）と表示色の整合', () => {
  const pb = new Playback(getDemo('B').config);
  pb.setSpeed(5);
  pb.play();
  while (pb.status !== 'completed') pb.frame(0.5);
  const n = pb.events.find((e) => e.lane === 'normal');
  const r = pb.events.find((e) => e.lane === 'runwave');
  assert.equal(n.entered, false);
  assert.notEqual(n.color, 'green');
  assert.equal(r.entered, true);
  assert.equal(r.color, 'green', 'RUNWAVE は青で進入');
  const pair = pb.pair;
  assert.ok(signalConsistent(pair.runwave));
});

test('runnerView: waiting 中は速度 0・BPM 0、完走後は固定、早歩き中は歩幅が walkStrideM', () => {
  const config = getDemo('W').config;
  let p = createPair(config);
  let sawWalk = false;
  let sawWait = false;
  while (!pairDone(p)) {
    p = stepPair(p);
    const t = p.tick / 10;
    const v = runnerView(p.runwave, t);
    if (v.walking) {
      sawWalk = true;
      assert.equal(v.strideM, 0.75);
      assert.equal(v.gait, 'walk');
      assert.ok(v.speedKmh >= 5.3 - 1e-9 && v.speedKmh <= 5.8 + 1e-9);
    }
    const n = runnerView(p.normal, t);
    if (n.waiting) {
      sawWait = true;
      assert.equal(n.speedMps, 0);
      assert.equal(n.bpm, 0);
    }
  }
  assert.ok(sawWalk && sawWait);
  const fin = runnerView(p.runwave, p.tick / 10);
  assert.equal(fin.finished, true);
  assert.equal(fin.speedMps, 0);
  assert.equal(fin.distToSignalM, null);
});

test('secondsToGreen: 青 0 / 青点滅は残り+赤 / 赤は残り / 青区間なしは null', () => {
  const s = { cycleS: 100, greenS: 40, yellowS: 5, redS: 55, phaseS: 0, crossingM: 15 };
  assert.equal(secondsToGreen(s, 10), 0);
  assert.equal(secondsToGreen(s, 42), 3 + 55);
  assert.equal(secondsToGreen(s, 60), 40);
  assert.equal(secondsToGreen({ ...s, greenS: 0, yellowS: 45 }, 10), null);
});

test('地図経路 → 1 信号なら single、0 件は none', () => {
  const route = buildRoute(DEMO_ROUTE_POINTS);
  const { runner, control } = defaultRunnerAndControl();
  const one = matchSignals(route, FIXTURE_SIGNALS);
  const plan = planFromMap({ route, adopted: one.adopted, runner, control });
  assert.equal(plan.kind, 'single');
  assert.ok(Math.abs(plan.config.route.crossingX - one.adopted[0].s) < 1e-9);
  assert.ok(Math.abs(plan.config.route.goalX - route.lengthM) < 1e-9);
  assert.ok(matchesExpected(runAll(plan.config), expectedFor(plan.config)).ok);


  assert.equal(planFromMap({ route, adopted: [], runner, control }).kind, 'none');
  // goalX が横断の先にならない配置は core の検証で invalid
  const bad = planFromMap({ route, adopted: [{ ...one.adopted[0], s: route.lengthM - 5 }], runner, control });
  assert.equal(bad.kind, 'invalid');
});

test('fixture の signal は core.validateSignal を通る', () => {
  for (const f of FIXTURE_SIGNALS) assert.ok(core.validateSignal(f.signal));
  assert.ok(pointAtDistance(buildRoute(DEMO_ROUTE_POINTS), 0));
});
