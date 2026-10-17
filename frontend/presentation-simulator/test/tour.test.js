import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../src/core-ns.js';
import { getScenario, highlightsFor } from '../src/scenarios.js';
import { createSession, stateAtTick, TPS } from '../src/simulation.js';
import { buildFrame, subtitleFor, describeDecision, PX_PER_M, footPxPerCycle, CYCLE_MIN_S } from '../src/demo-view-model.js';
import { createExplanation, resetDemo, FULL_STAGES, SHORT_STAGES } from '../src/explanation-controller.js';
import { buildTourPlan, createTour, segmentEndTick, explainEvents, PLAY_S, TITLE_MS } from '../src/tour.js';
import { zoomFor, zoomTransform, ZOOM_MIN, ZOOM_MAX } from '../src/zoom.js';

const ids = ['B', 'A', 'W'];
const plan = buildTourPlan();

function makeTour() {
  const session = createSession(getScenario('B').config);
  const explanation = createExplanation();
  const log = { segments: [], queueAtSegment: [], frameAtSegment: [] };
  const tour = createTour({
    session, explanation, plan,
    onSegment: (sg) => {
      log.segments.push(sg.id);
      log.queueAtSegment.push(explanation.queueLength);
      log.frameAtSegment.push(buildFrame(session.state, session.config, { speed: session.multiplier }));
    },
  });
  return { session, explanation, tour, log };
}

// 実時間を与えて通しデモを最後まで回す（60fps）
function driveTour({ session, explanation, tour }, { onFrame, maxS = 90 } = {}) {
  let now = 1000;
  tour.arm();
  tour.notePlay(now);
  const t0 = now;
  let frames = 0;
  while (tour.phase !== 'done' && (now - t0) / 1000 < maxS) {
    now += 1000 / 60;
    session.frame(now);
    const ex = tour.update(now);
    frames++;
    if (onFrame) onFrame({ now, ex, frames });
  }
  return (now - t0) / 1000;
}

test('区間の終了 tick は core の逐次 step と一致する（x ≥ crossingX + crossingM + 10m の最初の tick）', () => {
  for (const sg of plan.segments) {
    const c = sg.config;
    const goalAt = c.route.crossingX + c.signal.crossingM + 10;
    assert.equal(sg.endTick, segmentEndTick(c));
    const at = stateAtTick(c, sg.endTick);
    const before = stateAtTick(c, sg.endTick - 1);
    assert.ok(at.x >= goalAt, `${sg.id}: x=${at.x}`);
    assert.ok(before.x < goalAt);
    assert.equal(at.finished, false, 'ゴールまでは走らない');
    assert.ok(Math.abs(sg.multiplier - sg.simS / PLAY_S) < 1e-12);
    assert.equal(sg.simS, sg.endTick / TPS);
  }
});

test('解説の tick: 目標BPMが通常から最初に変わった tick と W の walking 入り（逐次 step で確認）', () => {
  for (const sg of plan.segments) {
    const c = sg.config;
    const base = c.runner.baseBpm;
    let s = core.createRun(c);
    let firstTarget = null; let firstWalk = null;
    while (s.tick < sg.endTick) {
      s = core.step(s, c);
      if (firstTarget === null && Math.abs(s.targetBpm - base) > 1e-9) firstTarget = s.tick;
      if (firstWalk === null && s.mode === 'walking') firstWalk = s.tick;
    }
    assert.deepEqual(explainEvents(c, sg.endTick), sg.events);
    assert.equal(sg.events[0].tick, firstTarget);
    assert.equal(sg.events[0].kind, 'full');
    if (sg.id === 'W') {
      assert.equal(sg.events.length, 2);
      assert.equal(sg.events[1].tick, firstWalk);
      assert.equal(sg.events[1].kind, 'short');
    } else {
      assert.equal(sg.events.length, 1);
    }
  }
});

test('通し再生: 実時間の合計が 35〜40 秒、各区間は終了 tick ちょうどで止まり、解説は各 1 回（W は 2 回）', () => {
  const ctx = makeTour();
  const { session, explanation, tour, log } = ctx;
  const starts = [];
  let prevActive = false;
  let heldTick = null;
  const titles = [];
  const real = driveTour(ctx, {
    onFrame: ({ ex }) => {
      if (tour.title && titles.at(-1) !== tour.title) titles.push(tour.title);
      if (ex.active && !prevActive) { starts.push({ seg: tour.segment.id, tick: session.tick, stages: ex.stage }); heldTick = session.tick; }
      if (ex.active) assert.equal(session.tick, heldTick, '解説中は tick が進まない');
      assert.ok(ex.active === session.hold || ex.finished || !ex.active);
      prevActive = ex.active;
    },
  });
  assert.equal(tour.phase, 'done');
  assert.ok(real >= 35 && real <= 40, `通しの実時間 ${real.toFixed(2)} 秒`);
  assert.ok(Math.abs(real - plan.totalS) < 0.6, `計画 ${plan.totalS} と実測 ${real}`);
  assert.deepEqual(log.segments, ['B', 'B', 'A', 'W']); // 先頭は arm（待機）での初期化
  assert.deepEqual(titles, plan.segments.map((s) => s.title));
  assert.equal(starts.length, 4); // B, A, W×2
  assert.deepEqual(starts.map((s) => s.seg), ['B', 'A', 'W', 'W']);
  assert.deepEqual(starts.map((s) => s.tick), plan.segments.flatMap((s) => s.events.map((e) => e.tick)));
  // 最後の区間は終了 tick で止まる
  assert.equal(session.tick, plan.segments[2].endTick);
  assert.equal(session.running, false);
  console.log(`通しデモ実測 ${real.toFixed(2)} 秒（計画 ${plan.totalS.toFixed(2)} 秒）`);
});

test('各区間の実時間（タイトル・解説を除く）は約 7 秒。倍率と足の周期を確認', () => {
  const out = [];
  for (const sg of plan.segments) {
    const session = createSession(sg.config);
    session.setCustomMultiplier(sg.multiplier);
    session.breakTick = sg.endTick;
    let now = 0;
    session.play(); session.frame(now);
    while (session.running) { now += 1000 / 60; session.frame(now); }
    assert.equal(session.tick, sg.endTick);
    assert.ok(Math.abs(now / 1000 - PLAY_S) < 0.2, `${sg.id}: ${now / 1000}`);
    // 足の周期（先頭と区間内の最小・最大）
    const f0 = buildFrame(stateAtTick(sg.config, 1), sg.config, { speed: sg.multiplier });
    let min = Infinity;
    for (let t = 1; t <= sg.endTick; t += 10) {
      const f = buildFrame(stateAtTick(sg.config, t), sg.config, { speed: sg.multiplier });
      if (f.world.cycleS !== null) min = Math.min(min, f.world.cycleS);
    }
    const ground = f0.world.speedMps * sg.multiplier * PX_PER_M;
    out.push(`${sg.id}: 区間${sg.simS.toFixed(1)}s 倍率${sg.multiplier.toFixed(2)} 足周期${f0.world.cycleS.toFixed(3)}s(最小${min.toFixed(3)}) 地面${ground.toFixed(0)}px/s 足${(footPxPerCycle('run') / f0.world.cycleS).toFixed(0)}px/s`);
    assert.ok(f0.world.cycleS >= CYCLE_MIN_S - 1e-9);
  }
  console.log(out.join('\n'));
});

test('シナリオ切替: 演出キュー・前の文言・ズームが残らない', () => {
  const { session, explanation, tour, log } = makeTour();
  explanation.addPulse('flow', 0); explanation.addPulse('haptic', 0);
  driveTour({ session, explanation, tour }, {});
  // 切替ごとにキューが空で、新しい区間は tick 0・通常ペースの字幕
  assert.deepEqual(log.queueAtSegment, log.segments.map(() => 0));
  for (const f of log.frameAtSegment) {
    assert.equal(f.tick, 0);
    assert.equal(f.judge.kind, 'normal');
    assert.equal(subtitleFor(null, f), `通常ペース：現在${f.world.bpmText}BPM`);
  }
  // 切替直前に積まれた演出も、切替で空になる
  const s2 = makeTour();
  s2.tour.arm();
  s2.explanation.addPulse('flow', 0);
  s2.explanation.addPulse('glow', 0);
  resetDemo(s2.session, s2.explanation, getScenario('W').config);
  assert.equal(s2.explanation.queueLength, 0);
  assert.equal(s2.explanation.update(10).active, false);
});

test('ズーム中は tick が進まず、ズームと字幕はリセットで初期化される（表示だけの演出）', () => {
  const config = getScenario('B').config;
  const session = createSession(config);
  const ex = createExplanation();
  const rects = { world: { x: 100, y: 100, w: 1300, h: 500 }, input: { x: 16, y: 700, w: 360, h: 290 }, judge: { x: 460, y: 700, w: 720, h: 290 }, output: { x: 1260, y: 700, w: 640, h: 290 } };
  session.jumpTo(300);
  const tick0 = session.tick;
  const stateBefore = session.state;
  session.setHold(true);
  ex.start(0, FULL_STAGES);
  let now = 0;
  const seen = [];
  for (let i = 0; i < 100; i++) {
    now += 50;
    session.frame(now); // 呼ばれても進まない
    const r = ex.update(now);
    if (r.active) {
      const z = zoomFor(r.stage, true, rects);
      seen.push({ stage: r.stage, scale: z?.s ?? null });
      if (['world', 'input', 'judge', 'output'].includes(r.stage)) assert.ok(z.s >= ZOOM_MIN - 1e-9 && z.s <= ZOOM_MAX + 1e-9);
      else assert.equal(z, null); // return は全体へ
      assert.equal(zoomFor(r.stage, false, rects), null); // OFF なら拡大しない
      assert.equal(session.tick, tick0);
      assert.equal(session.state, stateBefore, 'state は同一参照のまま');
    }
  }
  assert.deepEqual([...new Set(seen.map((s) => s.stage))], ['world', 'input', 'judge', 'output', 'return']);
  // リセット: 解説・演出が消え、ズームは全体（null）、字幕は新しい状態の通常表示
  ex.start(now, SHORT_STAGES);
  ex.addPulse('flow', now);
  resetDemo(session, ex, getScenario('A').config);
  const r = ex.update(now + 10);
  assert.equal(r.active, false);
  assert.equal(zoomFor(r.active ? r.stage : null, true, rects), null);
  const f = buildFrame(session.state, session.config, { speed: session.multiplier });
  assert.equal(subtitleFor(r.active ? r.stage : null, f), `通常ペース：現在${f.world.bpmText}BPM`);
  assert.equal(ex.queueLength, 0);
  assert.equal(session.tick, 0);
});

test('字幕の数値は同じ tick の view-model と一致する（手書きの数字なし）', () => {
  for (const id of ids) {
    const config = getScenario(id).config;
    for (const tick of [1, 100, 800, 1500, 1700]) {
      const state = stateAtTick(config, tick);
      const f = buildFrame(state, config, { speed: 10 });
      const world = subtitleFor('world', f);
      assert.ok(world.includes(f.signal.label) && world.includes(f.signal.remainingText), world);
      assert.ok(world.includes(f.world.distanceText) || f.world.passed);
      assert.equal(subtitleFor('input', f), '距離・歩調・信号を判定へ');
      const judge = subtitleFor('judge', f);
      assert.ok(judge.includes(f.judge.text));
      if (f.target.bpm != null && ['adjust', 'prep', 'walk'].includes(f.judge.kind)) assert.ok(judge.includes(`${f.target.text}BPM`));
      const out = subtitleFor('output', f);
      assert.ok(out.startsWith('スマホとWatchに同時に通知'));
      if (f.target.bpm != null) assert.ok(out.includes(`${f.target.text}BPM`));
      // 字幕の目標は、スマホ・Watch の目標と同じ値
      assert.equal(f.watch.targetText, f.target.text);
      const idle = subtitleFor(null, f);
      if (f.judge.kind === 'adjust') assert.equal(idle, `テンポ調整中：${f.target.text}BPMへ`);
    }
  }
});

test('ズーム変換: 画面外が見えない範囲に収まり、1.3〜1.8 倍', () => {
  const z = zoomTransform({ x: 1260, y: 700, w: 640, h: 290 });
  assert.ok(z.s >= 1.3 && z.s <= 1.8);
  assert.ok(z.tx <= 0 && z.tx >= 1920 - 1920 * z.s);
  assert.ok(z.ty <= 0 && z.ty >= 1080 - 1080 * z.s);
  const wide = zoomTransform({ x: 0, y: 0, w: 1900, h: 500 });
  assert.equal(wide.s, ZOOM_MIN);
});

test('タブ非表示・一時停止・リセット: 通しデモの停止と先頭復帰', () => {
  const { session, explanation, tour } = makeTour();
  let now = 1000;
  tour.arm();
  tour.notePlay(now);
  for (let i = 0; i < 120; i++) { now += 1000 / 60; session.frame(now); tour.update(now); }
  assert.equal(tour.phase, 'play');
  for (let i = 0; i < 60; i++) { now += 1000 / 60; session.frame(now); tour.update(now); }
  // 非表示（main の visibilitychange と同じ手順）
  explanation.cancel(); session.setHold(false); tour.interrupt(); session.hide(); tour.notePause();
  const t = session.tick;
  now += 600000;
  for (let i = 0; i < 30; i++) { now += 1000 / 60; session.frame(now); tour.update(now); }
  assert.equal(session.tick, t, '復帰しても停止を維持');
  // 再生すれば進み、飛ばない（1 フレームの上限 1 秒）
  tour.notePlay(now);
  now += 600000;
  session.frame(now); now += 1000; session.frame(now);
  assert.ok(session.tick - t <= Math.ceil(plan.segments[0].multiplier * 10 * 1) + 1);
  // リセット = 通しデモの最初（B）へ
  tour.arm();
  assert.equal(tour.index, 0);
  assert.equal(tour.phase, 'ready');
  assert.equal(session.tick, 0);
  assert.equal(session.config, getScenario('B').config);
  assert.equal(explanation.queueLength, 0);
  assert.equal(TITLE_MS, 800);
});

test('waiting / stopRecommended は B/A/W の RUNWAVE 走行で出るか（出ないなら表示を作らない）', () => {
  const found = {};
  for (const id of ids) {
    const kinds = new Set(highlightsFor(id).map((h) => h.kind));
    // highlightsFor は全走行を走査して最初に起きた tick を集める。無ければ起きていない
    found[id] = { waiting: kinds.has('wait'), stopRecommended: kinds.has('stopRec') };
  }
  console.log('RUNWAVE 走行での出現:', JSON.stringify(found));
  for (const id of ids) {
    assert.equal(found[id].waiting, false, `${id}: 信号待ちが出た`);
    assert.equal(found[id].stopRecommended, false, `${id}: 停止推奨が出た`);
  }
  // 表示の対応表だけは用意してある（出た場合に §5.2 の文言で表示される）
  const d = describeDecision({ mode: 'stopRecommended', reason: 'unavoidable', gait: 'run' }, { direction: 'same' });
  assert.equal(d.judge, '調整だけでは停止回避が難しい');
  assert.equal(d.phone, '停止推奨');
});
