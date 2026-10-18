import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phaseAtRunStart, runLowBpm, isEstimatedSignal, MIN_RUN_BPM } from './signal-input.js';

test('位相の換算: unix-epoch は (走行開始の UNIX 秒 + phaseS) mod cycleS', () => {
  assert.equal(phaseAtRunStart({ phaseS: 30, cycleS: 100, phaseReference: 'unix-epoch' }, 1760000005), 35);   // 1760000005 mod 100 = 5
  assert.equal(phaseAtRunStart({ phaseS: 0, cycleS: 110, phaseReference: 'unix-epoch' }, 1760000000), 1760000000 % 110);
  assert.equal(phaseAtRunStart({ phaseS: -10, cycleS: 100, phaseReference: 'unix-epoch' }, 0), 90);   // 負でも 0 以上 cycleS 未満
  assert.throws(() => phaseAtRunStart({ phaseS: 0, cycleS: 100, phaseReference: 'unix-epoch' }), RangeError);   // UNIX 秒が必要
});

test('位相の換算: run-start は値をそのまま使い、UNIX 秒を足さない', () => {
  assert.equal(phaseAtRunStart({ phaseS: 30, cycleS: 100, phaseReference: 'run-start' }, 1760000005), 30);
  assert.equal(phaseAtRunStart({ phaseS: 30, cycleS: 100, phaseReference: 'run-start' }), 30);
});

test('位相の換算: phaseReference が無い・不明なら RangeError（読み方を取り違えない）', () => {
  for (const ref of [undefined, '', 'epoch']) assert.throws(() => phaseAtRunStart({ phaseS: 0, cycleS: 100, phaseReference: ref }, 0), RangeError);
});

test('走りの下限 max(80, 通常−20) と推定データの判定', () => {
  assert.equal(MIN_RUN_BPM, 80);
  assert.deepEqual([runLowBpm(150, 20), runLowBpm(100, 20), runLowBpm(90, 20), runLowBpm(75, 20)], [130, 80, 80, 75]);
  assert.equal(isEstimatedSignal({ isEstimated: true }), true);
  assert.equal(isEstimatedSignal({ phaseBasis: 'estimated' }), true);
  assert.equal(isEstimatedSignal({ phaseBasis: 'measured', isEstimated: false }), false);
  assert.equal(isEstimatedSignal(undefined), false);
});
