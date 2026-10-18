// SIM-02: 倍率（1/2/4/5）や壁時計の刻みを変えても、同じシミュレーション時刻の状態は同じになる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Playback, SPEEDS } from '../src/playback.js';
import { runnerView } from '../src/engine-adapter.js';
import { getDemo } from '../src/scenarios.js';

const TARGET_TICKS = 240; // 24.0 秒時点で比べる（4 の倍数なので x4・0.1 秒刻み＝1 フレーム 4 tick でも丁度止まる）

/** speed 倍で、壁時計を wallStepS ずつ進めて targetTicks に到達させる */
function runTo(config, speed, wallStepS, targetTicks) {
  const pb = new Playback(config);
  pb.setSpeed(speed);
  pb.play();
  let guard = 0;
  while (pb.pair.tick < targetTicks && guard++ < 100000) pb.frame(wallStepS);
  return pb;
}

const snapshot = (pb) => {
  const t = pb.timeS;
  const views = ['normal', 'runwave'].map((k) => {
    const v = runnerView(pb.pair[k], t);
    return { x: v.x, bpm: v.bpm, targetBpm: v.targetBpm, color: v.signal.color, remainingS: v.signal.remainingS, waiting: v.waiting };
  });
  return { tick: pb.pair.tick, timeS: t, views, series: pb.series.slice(-2) };
};

test('SPEEDS に x4 が入っている', () => {
  assert.deepEqual(SPEEDS, [1, 2, 4, 5]);
});

for (const id of ['B', 'W']) {
  test(`デモ ${id}: x1/x2/x4 と壁時計の刻み違いで、同じ模擬時刻の位置・時刻・信号位相が一致`, () => {
    const config = getDemo(id).config;
    // 基準: x1・0.1 秒刻み（1 フレーム 1 tick）
    const base = snapshot(runTo(config, 1, 0.1, TARGET_TICKS));
    assert.equal(base.tick, TARGET_TICKS);
    const variants = [
      [1, 0.05], [1, 0.2],
      [2, 0.05], [2, 0.1],
      [4, 0.025], [4, 0.05], [4, 0.1],
    ];
    for (const [speed, step] of variants) {
      const got = snapshot(runTo(config, speed, step, TARGET_TICKS));
      assert.equal(got.tick, TARGET_TICKS, `x${speed}/${step}s: tick`);
      assert.deepEqual(got, base, `x${speed} 壁時計 ${step}s 刻みで状態が違う`);
    }
  });
}

test('完走まで回した最終結果・イベント・時系列が倍率によらず同じ', () => {
  const config = getDemo('W').config;
  const finish = (speed, step) => {
    const pb = new Playback(config);
    pb.setSpeed(speed);
    pb.play();
    let guard = 0;
    while (pb.status === 'playing' && guard++ < 1e6) pb.frame(step);
    return { tick: pb.pair.tick, events: pb.events, series: pb.series };
  };
  const base = finish(1, 0.1);
  for (const [speed, step] of [[2, 0.1], [4, 0.1], [5, 0.1], [4, 0.025]]) {
    assert.deepEqual(finish(speed, step), base, `x${speed}/${step}s`);
  }
});
