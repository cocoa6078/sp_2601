import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../src/core-ns.js';
import { getScenario, highlightsFor } from '../src/scenarios.js';
import { createSession, stateAtTick, TPS } from '../src/simulation.js';
import { buildFrame, subtitleFor, describeDecision, PX_PER_M, footPxPerCycle, CYCLE_MIN_S } from '../src/demo-view-model.js';
import { createExplanation, resetDemo, FULL_STAGES, SHORT_STAGES } from '../src/explanation-controller.js';
import { buildTourPlan, createTour, segmentEndTick, explainEvents, buildWindows, approachTick, cutText, TITLE_MS, CUT_MS, WINDOW1_S, APPROACH_M, TOUR_MULTIPLIER } from '../src/tour.js';
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

test('窓の開始・終了 tick は core の逐次 step と一致する（窓1=目標変化から12秒、窓2=横断地点の30m手前→横断の先10m、W は窓2a=walking の2秒前〜6秒後も）', () => {
  for (const sg of plan.segments) {
    const c = sg.config;
    const end = segmentEndTick(c);
    const goalAt = c.route.crossingX + c.signal.crossingM + 10;
    assert.equal(sg.endTick, end);
    assert.ok(stateAtTick(c, end).x >= goalAt && stateAtTick(c, end - 1).x < goalAt);
    assert.equal(stateAtTick(c, end).finished, false, 'ゴールまでは走らない');
    // 独立に逐次 step して、目標変化・walking・40m手前の tick を数える
    const base = c.runner.baseBpm;
    let s = core.createRun(c);
    let tTarget = null; let tWalk = null; let t40 = null;
    while (s.tick < end) {
      s = core.step(s, c);
      if (tTarget === null && Math.abs(s.targetBpm - base) > 1e-9) tTarget = s.tick;
      if (tWalk === null && s.mode === 'walking') tWalk = s.tick;
      if (t40 === null && s.x >= c.route.crossingX - APPROACH_M) t40 = s.tick;
    }
    assert.equal(approachTick(c, end), t40);
    const w1 = sg.windows[0];
    const w2 = sg.windows.at(-1);
    assert.equal(w1.startTick, tTarget);
    assert.equal(w1.endTick, tTarget + WINDOW1_S * TPS);
    assert.equal(w2.startTick, t40);
    assert.equal(w2.endTick, end);
    if (tWalk !== null) {
      assert.equal(sg.windows.length, 3);
      assert.deepEqual(sg.windows[1], { startTick: tWalk - 20, endTick: tWalk + 60 });
    } else {
      assert.equal(sg.windows.length, 2);
    }
    for (let i = 1; i < sg.windows.length; i++) assert.ok(sg.windows[i].startTick > sg.windows[i - 1].endTick, '窓は重ならない（あいだはカット）');
    assert.deepEqual(buildWindows(c), sg.windows);
    const cutSum = sg.windows.slice(1).reduce((x, w, i) => x + (w.startTick - sg.windows[i].endTick) / TPS, 0);
    assert.ok(Math.abs(sg.cutSimS - cutSum) < 1e-12);
    // 解説（ズーム）は窓1の開始と、W の walking 開始だけ
    const tw = (e) => ({ tick: e.tick, why: e.why });
    assert.deepEqual(explainEvents(c, end).map(tw), sg.events.map(tw));
    assert.equal(sg.events[0].tick, w1.startTick);
    assert.equal(sg.events[0].kind, sg.id === 'A' ? 'short' : 'full'); // A は B で一度フルで見せているので短縮版
    assert.equal(sg.events.length, sg.id === 'W' ? 2 : 1);
    if (sg.id === 'W') { assert.equal(sg.events[1].tick, tWalk); assert.equal(sg.events[1].kind, 'short'); assert.ok(tWalk >= sg.windows[1].startTick && tWalk <= sg.windows[1].endTick); }
  }
  assert.equal(plan.multiplier, TOUR_MULTIPLIER);
  assert.equal(TOUR_MULTIPLIER, 5);
});

test('通し再生: カット表示の秒数＝ジャンプした sim 秒、ジャンプ先の state は逐次 step と一致、解説は B/A 各1回・W 2回、合計は計画と一致', () => {
  const ctx = makeTour();
  const { session, explanation, tour } = ctx;
  const starts = [];
  const cuts = [];
  let prevActive = false;
  let heldTick = null;
  let prevCut = null;
  let tickBeforeCut = null;
  let seenPhases = [];
  const titles = [];
  const real = driveTour(ctx, {
    onFrame: ({ ex }) => {
      if (tour.title && titles.at(-1) !== tour.title) titles.push(tour.title);
      if (seenPhases.at(-1) !== tour.phase) seenPhases.push(tour.phase);
      if (ex.active && !prevActive) { starts.push({ seg: tour.segment.id, tick: session.tick }); heldTick = session.tick; }
      if (ex.active) assert.equal(session.tick, heldTick, '解説中は tick が進まない');
      prevActive = ex.active;
      const cut = tour.cut;
      if (cut && !prevCut) { tickBeforeCut = session.tick; cuts.push({ seg: tour.segment.id, ...cut, from: tickBeforeCut, state: null }); }
      if (cut) assert.equal(session.tick, tickBeforeCut, 'カット表示中は動かない');
      if (!cut && prevCut) {
        // ジャンプ直後: 表示の秒数 = 実際に飛んだ sim 秒、state は逐次 step と一致
        const c = cuts.at(-1);
        const sg = tour.segment;
        const jumped = (session.tick - c.from) / TPS;
        assert.equal(c.text, cutText(jumped));
        assert.ok(Math.abs(c.skippedSimS - jumped) < 1e-9, `表示 ${c.skippedSimS} と飛んだ ${jumped}`);
        const ws = sg.windows[tour.windowIndex].startTick;
        assert.equal(session.tick, ws);
        assert.deepEqual(session.state, stateAtTick(sg.config, ws));
        let s = core.createRun(sg.config);
        while (s.tick < ws) s = core.step(s, sg.config);
        assert.deepEqual(session.state, s);
        assert.equal(explanation.queueLength, 0, 'カットで演出キューが空');
      }
      prevCut = cut;
    },
  });
  assert.equal(tour.phase, 'done');
  assert.equal(cuts.length, 4); // B 1・A 1・W 2
  assert.deepEqual(cuts.map((c) => c.seg), ['B', 'A', 'W', 'W']);
  assert.deepEqual(titles, plan.segments.map((s) => s.title));
  assert.deepEqual(starts.map((s) => s.seg), ['B', 'A', 'W', 'W']);
  assert.deepEqual(starts.map((s) => s.tick), plan.segments.flatMap((s) => s.events.map((e) => e.tick)));
  assert.equal(session.tick, plan.segments[2].endTick);
  assert.equal(session.running, false);
  assert.ok(Math.abs(real - plan.totalS) < 0.8, `計画 ${plan.totalS.toFixed(2)} と実測 ${real.toFixed(2)}`);
  console.log(`通しデモ 実測 ${real.toFixed(2)} 秒（計画 ${plan.totalS.toFixed(2)} 秒・倍率 ${plan.multiplier}）`);
  console.log(plan.segments.map((s) => `${s.id}: 窓 ${s.windows.map((w) => `${w.startTick}-${w.endTick}`).join(' / ')} カット${s.cutSimS}s 再生${s.playedSimS.toFixed(1)}s`).join(String.fromCharCode(10)));
  assert.ok(real >= 40 && real <= 45, `合計 ${real.toFixed(2)} 秒が 40〜45 秒に収まる`);
});

test('窓の実時間（タイトル・解説を除く）は sim 秒 ÷ 倍率。倍率・足の周期を確認', () => {
  const out = [];
  for (const sg of plan.segments) {
    for (const w of sg.windows) {
      const session = createSession(sg.config);
      session.jumpTo(w.startTick);
      session.setCustomMultiplier(sg.multiplier);
      session.breakTick = w.endTick;
      let now = 0;
      session.play(); session.frame(now);
      while (session.running) { now += 1000 / 60; session.frame(now); }
      assert.equal(session.tick, w.endTick);
      assert.ok(Math.abs(now / 1000 - (w.endTick - w.startTick) / TPS / sg.multiplier) < 0.2);
    }
    const f0 = buildFrame(stateAtTick(sg.config, sg.windows[0].startTick), sg.config, { speed: sg.multiplier });
    const ground = f0.world.speedMps * sg.multiplier * PX_PER_M;
    out.push(`${sg.id}: 倍率${sg.multiplier} 足周期${f0.world.cycleS.toFixed(3)}s 地面${ground.toFixed(0)}px/s 足${(footPxPerCycle('run') / f0.world.cycleS).toFixed(0)}px/s`);
    assert.ok(f0.world.cycleS >= CYCLE_MIN_S - 1e-9);
  }
  console.log(out.join(String.fromCharCode(10)));
});

test('シナリオ切替: 演出キュー・前の文言・ズームが残らない', () => {
  const { session, explanation, tour, log } = makeTour();
  explanation.addPulse('flow', 0); explanation.addPulse('haptic', 0);
  driveTour({ session, explanation, tour }, {});
  // 切替ごとにキューが空で、新しい区間の表示はそのシナリオの state だけ
  assert.deepEqual(log.queueAtSegment, log.segments.map(() => 0));
  const expectTicks = [0, ...plan.segments.map((s) => s.windows[0].startTick)];
  log.frameAtSegment.forEach((f, i) => {
    const cfg = getScenario(log.segments[i]).config;
    assert.equal(f.tick, expectTicks[i]);
    // 切替直後の表示は、そのシナリオを core で逐次 step した state だけから作られる（前のシナリオの値は残らない）
    assert.deepEqual(f, buildFrame(stateAtTick(cfg, f.tick), cfg, { speed: f.speed }));
    assert.equal(f.world.crossingX, cfg.route.crossingX);
  });
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
  assert.ok(session.tick - t <= Math.ceil(plan.multiplier * 10 * 1) + 1);
  // リセット = 通しデモの最初（B）へ
  tour.arm();
  assert.equal(tour.index, 0);
  assert.equal(tour.phase, 'ready');
  assert.equal(session.tick, 0);
  assert.equal(session.config, getScenario('B').config);
  assert.equal(explanation.queueLength, 0);
  assert.equal(TITLE_MS, 800);
  assert.equal(CUT_MS, 600);
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
