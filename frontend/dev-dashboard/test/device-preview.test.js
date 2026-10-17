import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MISSING,
  UNAVAILABLE,
  UNMEASURED,
  buildPreviewModel,
  formatPace,
  paceFromSpeed,
  parseSensorInput,
  sensorText,
} from '../src/device-preview.js';
import { advance, createPair, getFixedScenario, laneView, stepPair } from '../src/sim-engine.js';

test('模擬入力: 空欄は未計測・欠測チェックは欠測（どちらも 0 にならない）。不正値は入力エラー', () => {
  assert.deepEqual(parseSensorInput({ text: '' }), { state: 'unmeasured', value: null, message: null });
  assert.equal(parseSensorInput({}).value, null);
  assert.equal(parseSensorInput({ text: '  ' }).state, 'unmeasured');
  assert.deepEqual(parseSensorInput({ text: '2.5', missing: true }), { state: 'missing', value: null, message: null }, '欠測が優先');
  assert.equal(parseSensorInput({ text: '2.5' }).value, 2.5);
  assert.equal(parseSensorInput({ text: '0' }).value, 0, '0 は実際に入力された 0');
  for (const bad of ['abc', '-1', 'Infinity', 'NaN']) {
    const r = parseSensorInput({ text: bad });
    assert.equal(r.state, 'invalid', bad);
    assert.equal(r.value, null);
    assert.ok(r.message);
  }
  assert.equal(sensorText(parseSensorInput({ text: '' }), 'm/s'), UNMEASURED);
  assert.equal(sensorText(parseSensorInput({ missing: true }), 'm/s'), MISSING);
  assert.equal(sensorText(parseSensorInput({ text: '2.456' }), 'm/s', 2), '2.46 m/s');
});

test('ペース = 1000 / 速度。速度 0・未計測・負・非数は算出不能', () => {
  assert.equal(paceFromSpeed(2).text, '8:20/km'); // 500 秒/km
  assert.equal(paceFromSpeed(2).secPerKm, 500);
  assert.equal(paceFromSpeed(1000 / 359.6).text, '6:00/km', '四捨五入で 5:60 にならない');
  assert.equal(formatPace(65), '1:05/km');
  for (const v of [0, null, undefined, NaN, -1, Infinity]) {
    const p = paceFromSpeed(v);
    assert.equal(p.available, false, String(v));
    assert.equal(p.text, UNAVAILABLE);
    assert.equal(p.secPerKm, null);
  }
});

test('表示モデル: 目標値・core の推定値は core state と同じ値で、模擬入力に左右されない', () => {
  const config = getFixedScenario('A').config;
  const pair = advance(createPair(config), 55); // 通常レーンは接近中
  const view = laneView(pair.runwave, pair.configs.runwave, pair.tick);
  const none = buildPreviewModel({ view, config: pair.configs.runwave });
  const some = buildPreviewModel({
    view,
    config: pair.configs.runwave,
    sensors: { speedMps: { text: '3.1' }, cadenceSpm: { text: '170' }, heartRateBpm: { text: '188' } },
  });
  assert.equal(none.target.bpm, pair.runwave.targetBpm);
  assert.equal(none.target.mode, pair.runwave.mode);
  assert.equal(none.target.signal.color, view.signal.color);
  assert.equal(none.core.bpm, pair.runwave.bpm);
  assert.ok(Math.abs(none.core.speedMps - (0.8 * pair.runwave.bpm) / 60) < 1e-12);
  assert.deepEqual(some.target, none.target, '模擬値は目標値を変えない');
  assert.deepEqual(some.core, none.core, '模擬値は core の推定値を変えない');
  // 未入力の模擬値は null（0 ではない）
  assert.equal(none.measured.speed.value, null);
  assert.equal(none.measured.heartRate.value, null);
  assert.equal(none.measured.pace.available, false);
  assert.equal(none.measured.simulated, true);
  assert.equal(some.measured.heartRate.value, 188);
  assert.equal(some.measured.pace.text, formatPace(1000 / 3.1));
});

test('表示モデル: 待機中は bpm=0・推定速度 0・ペースは算出不能。ゴール後も 0', () => {
  const config = getFixedScenario('A').config;
  let pair = createPair(config);
  while (pair.normal.phase !== 'waiting') pair = stepPair(pair);
  const view = laneView(pair.normal, pair.configs.normal, pair.tick);
  const m = buildPreviewModel({ view, config: pair.configs.normal });
  assert.equal(m.target.waiting, true);
  assert.equal(m.core.bpm, 0);
  assert.equal(m.core.speedMps, 0);
  assert.equal(m.core.pace.text, UNAVAILABLE);

  while (!pair.normal.finished) pair = stepPair(pair);
  const done = buildPreviewModel({ view: laneView(pair.normal, pair.configs.normal, pair.tick), config: pair.configs.normal });
  assert.equal(done.core.speedMps, 0);
  assert.equal(done.core.pace.available, false);
});
