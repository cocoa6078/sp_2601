import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSignals, toCorePhaseS } from './api-adapter.js';
import { simulate } from './runwave-core.js';
import { SCENARIOS } from './scenarios.js';

const B = SCENARIOS.B.signal;

test('extractSignals: 推定フラグ（isEstimated・phaseBasis）と phaseReference を信号に残し、推定データでは加速しない', () => {
  for (const flag of [{ isEstimated: true }, { phaseBasis: 'estimated' }]) {
    const sig = extractSignals([{ signalId: 'x', ...B, ...flag }])[0].signal;
    for (const [k, v] of Object.entries(flag)) assert.equal(sig[k], v);
    // 以前は数値6項目だけになり、推定データでも 164 BPM まで加速していた
    assert.equal(simulate({ ...SCENARIOS.B, signal: sig }).summary.maxBpm, SCENARIOS.B.runner.baseBpm);
  }
  assert.equal(extractSignals([{ ...B, phaseReference: 'unix-epoch', phaseBasis: 'estimated' }])[0].signal.phaseReference, 'unix-epoch');
});

test('extractSignals: 品質の項目が無い信号は推定として扱う（欠損は加速しない側）。測定済みと明示されたものだけ加速できる', () => {
  assert.equal(extractSignals([{ ...B }])[0].signal.isEstimated, true);
  const measured = extractSignals([{ ...B, phaseBasis: 'measured', isEstimated: false }])[0].signal;
  assert.equal(measured.isEstimated, false);
  assert.ok(simulate({ ...SCENARIOS.B, signal: measured }).summary.maxBpm > SCENARIOS.B.runner.baseBpm);
});

test('extractSignals: phaseReference が不明な信号は使わない（位相を読み違えない）', () => {
  const r = extractSignals([{ ...B, phaseReference: 'local-time' }])[0];
  assert.equal(r.signal, null);
  assert.ok(r.problems.some((p) => /phaseReference/.test(p)));
});

test('toCorePhaseS: Web の phase.js が探す名前。phaseReference が無ければ run-start、unix-epoch は UNIX 秒を足して mod', () => {
  assert.equal(toCorePhaseS({ phaseS: 30, cycleS: 100 }, 1760000005), 30);
  assert.equal(toCorePhaseS({ phaseS: 30, cycleS: 100, phaseReference: 'run-start' }, 1760000005), 30);
  assert.equal(toCorePhaseS({ phaseS: 30, cycleS: 100, phaseReference: 'unix-epoch' }, 1760000005), 35);
  assert.throws(() => toCorePhaseS({ phaseS: 30, cycleS: 100, phaseReference: 'unix-epoch' }), RangeError);
  assert.throws(() => toCorePhaseS({ phaseS: 30, cycleS: 100, phaseReference: 'x' }, 0), RangeError);
});
