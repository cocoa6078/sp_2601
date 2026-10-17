import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, createRun } from '../../../core/runwave-core.js';
import {
  FIXED_SCENARIOS,
  MAX_TICKS,
  SPEEDS,
  advance,
  createPair,
  describeResult,
  displayStopTimeS,
  expectedFor,
  getFixedScenario,
  isPairDone,
  laneView,
  pairConfigs,
  pairSummary,
  planTicks,
  stepPair,
  verifyPair,
} from '../src/sim-engine.js';

const cfg = (id) => getFixedScenario(id).config;

/** 1 tick ずつ（画面の「1 ステップ」と同じ）ゴールまで進める */
function runBySingleSteps(config) {
  let pair = createPair(config);
  while (!isPairDone(pair)) pair = advance(pair, 1);
  return pair;
}

/** requestAnimationFrame を模したループ。frameMs の列に従って planTicks で進める。pauseFrom〜pauseTo 番目のフレームは一時停止 */
function runByFrames(config, { speed, frames, pause = null }) {
  let pair = createPair(config);
  let carry = 0;
  let i = 0;
  while (!isPairDone(pair)) {
    const ms = frames[i % frames.length];
    const paused = pause && i >= pause.from && i < pause.to;
    if (!paused) {
      const plan = planTicks({ carry, elapsedMs: ms, speed });
      carry = plan.carry;
      pair = advance(pair, plan.n);
    }
    i++;
    assert.ok(i < 2_000_000, 'ループが終わらない');
  }
  return pair;
}

test('3 シナリオ（A / B / B-length）と DEMO.sub: 逐次 step の最終結果が core.compare と一致する', () => {
  for (const sc of FIXED_SCENARIOS) {
    const pair = runBySingleSteps(sc.config);
    const v = verifyPair(pair);
    assert.equal(v.status, 'match', `${sc.id}: ${JSON.stringify(v.items.filter((x) => !x.ok))}`);
    assert.deepEqual(pairSummary(pair), compare(sc.config), `${sc.id}: summary が compare と同じ`);
    assert.deepEqual(expectedFor(sc.id), compare(sc.config));
  }
});

test('各シナリオの性質（A=減速で回避して遅い / B=加速で回避して早い / B-length=回避できない）', () => {
  const a = expectedFor('A');
  assert.equal(a.normal.stops, 1);
  assert.equal(a.runwave.stops, 0);
  assert.ok(a.runwave.totalTimeS > a.normal.totalTimeS, 'A は停止がなくなる代わりに遅くなる');

  const b = expectedFor('B');
  assert.equal(b.normal.stops, 1);
  assert.equal(b.runwave.stops, 0);
  assert.ok(b.runwave.totalTimeS < b.normal.totalTimeS);

  const bl = expectedFor('B-length');
  assert.equal(bl.normal.stops, 1);
  assert.equal(bl.runwave.stops, 1, 'length モデルでは回避できない');
  assert.equal(cfg('B-length').control.crossingModel, 'length');
  assert.equal(cfg('B-length').signal.crossingM, 20);
  assert.equal(cfg('A').signal.phaseS, 20);
  assert.equal(cfg('B').signal.phaseS, 100);
});

test('2 レーンの config の差は control.enabled だけ', () => {
  const { normal, runwave } = pairConfigs(cfg('B'));
  assert.equal(normal.control.enabled, false);
  assert.equal(runwave.control.enabled, true);
  const strip = (c) => ({ ...c, control: { ...c.control, enabled: undefined } });
  assert.deepEqual(strip(normal), strip(runwave));
  // 元の config は変更されない
  assert.equal(cfg('B').control.enabled, undefined);
});

test('表示速度 1/2/5 倍・フレーム間隔・途中の一時停止を変えても、最終結果と全 state が同じ', () => {
  for (const id of ['A', 'B', 'B-length']) {
    const config = cfg(id);
    const base = runBySingleSteps(config);
    const variants = [
      { speed: 1, frames: [16.7] },
      { speed: 2, frames: [16, 17, 50, 8] },
      { speed: 5, frames: [33, 100, 1, 250, 400] },
      { speed: 1, frames: [16.7], pause: { from: 100, to: 400 } }, // 途中で止めて再開
      { speed: 5, frames: [20, 20, 90], pause: { from: 7, to: 9 } },
    ];
    // B-length は 1 回の計算が重い（約 1 秒）ので、代表の 2 通りだけ確認する
    for (const v of id === 'B-length' ? [variants[2], variants[3]] : variants) {
      const pair = runByFrames(config, v);
      assert.equal(pair.tick, base.tick, `${id} ${JSON.stringify(v)}: 終了 tick`);
      assert.deepEqual(pair.normal, base.normal, `${id} ${JSON.stringify(v)}: 通常レーンの最終 state`);
      assert.deepEqual(pair.runwave, base.runwave, `${id} ${JSON.stringify(v)}: RUNWAVE レーンの最終 state`);
      assert.equal(verifyPair(pair).status, 'match');
    }
  }
});

test('1 ステップ = 0.1 秒（dt は速度に依存しない）。任意の途中で刻み方を変えても同じ tick なら同じ state', () => {
  const config = cfg('A');
  const a = advance(createPair(config), 123);
  let b = createPair(config);
  for (let i = 0; i < 123; i++) b = stepPair(b);
  assert.equal(a.tick, 123);
  assert.ok(Math.abs(a.tick / 10 - 12.3) < 1e-12);
  assert.deepEqual(a.normal, b.normal);
  assert.deepEqual(a.runwave, b.runwave);
  assert.equal(a.runwave.t, 12.3);
});

test('planTicks: 速度は何 tick 進めるかだけを変える。分割しても合計は同じ', () => {
  assert.deepEqual(SPEEDS, [1, 2, 5]);
  // 実時間 1 秒 = 10 tick（等倍）
  for (const speed of SPEEDS) {
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const p = planTicks({ carry, elapsedMs: 10, speed });
      carry = p.carry;
      total += p.n;
    }
    assert.ok(Math.abs(total - 10 * speed) <= 1, `速度 ${speed}: 合計 ${total}`);
  }
  // 長い停止（タブ非表示など）の後でも一気に進まない
  assert.equal(planTicks({ elapsedMs: 60_000, speed: 1 }).n, 10); // 1000ms 上限 → 10 tick
  // 描画が 1 秒に 1 回へ絞られても、表示速度どおり進む
  assert.equal(planTicks({ elapsedMs: 1000, speed: 5 }).n, 50);
  assert.throws(() => planTicks({ elapsedMs: 16, speed: 3 }), RangeError);
});

test('リセット: 作り直した pair は初期状態と同じで、途中結果を引きずらない', () => {
  const config = cfg('B');
  const fresh = createPair(config);
  const moved = advance(createPair(config), 500);
  assert.notDeepEqual(moved.runwave, fresh.runwave);
  const reset = createPair(moved.config);
  assert.equal(reset.tick, 0);
  assert.deepEqual(reset.normal, fresh.normal);
  assert.deepEqual(reset.runwave, fresh.runwave);
  assert.deepEqual(reset.normal, createRun(reset.configs.normal));
  assert.equal(verifyPair(reset).status, 'pending');
});

test('待機中の停止時間: core の stopTimeS（終了した待機の合計）に t − stoppedAtT を足して表示する', () => {
  // A の通常走行は 20 秒待つ。待機中を 1 tick ずつ確認する
  let pair = createPair(cfg('A'));
  const waits = [];
  while (!isPairDone(pair)) {
    pair = stepPair(pair);
    if (pair.normal.phase === 'waiting') waits.push(pair.normal);
  }
  assert.ok(waits.length > 100, '待機中の state が複数ある');
  let prev = -1;
  for (const s of waits) {
    assert.equal(s.bpm, 0, '待機中は bpm=0');
    assert.equal(s.mode, 'waiting');
    assert.equal(s.stopTimeS, 0, 'core の stopTimeS は待機中はまだ加算されない');
    const shown = displayStopTimeS(s);
    assert.ok(Math.abs(shown - (s.t - s.stoppedAtT)) < 1e-6);
    assert.ok(shown >= prev, '待機中の表示は増え続ける');
    prev = shown;
  }
  assert.ok(prev > 15, `待機の終わり近くでは 20 秒に近い値（${prev}）`);
  // 待機が終わった後は core の stopTimeS と一致する
  assert.equal(displayStopTimeS(pair.normal), pairSummary(pair).normal.stopTimeS);
  assert.ok(Math.abs(displayStopTimeS(pair.normal) - 20) < 0.11);
  // ゴール前（待機中）の画面用 view も同じ値を使う
  const mid = waits[Math.floor(waits.length / 2)];
  assert.equal(laneView(mid, cfg('A'), mid.tick).stopTimeS, displayStopTimeS(mid));
  assert.equal(laneView(mid, cfg('A'), mid.tick).waiting, true);
});

test('先にゴールしたレーンは固定され、もう片方だけが進む。共通の時計は止まらない', () => {
  let pair = createPair(cfg('B')); // RUNWAVE の方が早い
  while (!pair.runwave.finished) pair = stepPair(pair);
  const frozen = pair.runwave;
  const tickAtFinish = pair.tick;
  pair = advance(pair, 50);
  assert.deepEqual(pair.runwave, frozen, 'ゴール済みレーンは変わらない');
  assert.equal(pair.tick, tickAtFinish + 50, '共通の時計は進む');
  assert.equal(pair.normal.tick, pair.tick, '未ゴールのレーンは共通の時計と同期');
  assert.equal(isPairDone(pair), false);
});

test('不正な config では createPair が RangeError を投げる（呼び出し側で表示する）', () => {
  const bad = { ...cfg('B'), signal: { ...cfg('B').signal, cycleS: 100 } };
  assert.throws(() => createPair(bad), RangeError);
});

test('結果の読み方: 停止回避と所要時間の差を別々に示し、遅くなったケースもそのまま書く', () => {
  const a = describeResult(expectedFor('A'));
  assert.equal(a.avoided, true);
  assert.match(a.stopLine, /停止回避/);
  assert.match(a.timeLine, /\+5\.0 秒・遅い/);
  const b = describeResult(expectedFor('B'));
  assert.equal(b.avoided, true);
  assert.match(b.timeLine, /短縮/);
  const bl = describeResult(expectedFor('B-length'));
  assert.equal(bl.avoided, false);
  assert.match(bl.stopLine, /停止回避なし/);
  assert.match(bl.timeLine, /差なし/);
  const pending = describeResult(pairSummary(createPair(cfg('B'))));
  assert.equal(pending.avoided, null);
});

test('最大時間（maxTimeS）に達した場合も、逐次と compare が一致し termination=timeLimit を示す', () => {
  // ゴールを遠くして 1800 秒以内に着かないようにする（通常 150 歩/分 × 0.8m = 2 m/s → 3600m で 1800 秒）
  const far = { ...cfg('B'), route: { crossingX: 400, goalX: 5000 } };
  const pair = advance(createPair(far), MAX_TICKS + 10);
  assert.equal(pair.tick, MAX_TICKS);
  assert.ok(isPairDone(pair));
  const v = verifyPair(pair);
  assert.equal(v.status, 'match');
  assert.equal(pairSummary(pair).runwave.termination, 'timeLimit');
});
