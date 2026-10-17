import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from '../src/core-ns.js';
import { SCENARIO_LIST, getScenario, highlightsFor, findHighlights } from '../src/scenarios.js';
import { createSession, stateAtTick, planTicks, demoMultiplier, DEMO_SPEED, MAX_FRAME_MS, MAX_TICKS, TPS } from '../src/simulation.js';
import { buildFrame, footCycleS, footPxPerCycle, PX_PER_M, CYCLE_MIN_S, CYCLE_MAX_S } from '../src/demo-view-model.js';
import { createExplanation, startExplanation, tickExplanation, resetDemo, STAGES, FULL_STAGES, SHORT_STAGES, stagesDurationS } from '../src/explanation-controller.js';

const ids = ['B', 'A', 'W'];

function fullRun(config, onState) {
  let s = core.createRun(config);
  if (onState) onState(s);
  while (!s.finished && s.tick < MAX_TICKS) { s = core.step(s, config); if (onState) onState(s); }
  return s;
}

test('シナリオ: enabled=true・point・早歩き有効・余裕5秒が明示され、core の検証を通る', () => {
  assert.deepEqual(SCENARIO_LIST.map((s) => s.id), ids);
  for (const s of SCENARIO_LIST) {
    assert.equal(core.validateConfig(s.config), true);
    assert.equal(s.config.control.enabled, true);
    assert.equal(s.config.control.crossingModel, 'point');
    assert.equal(s.config.control.walk.enabled, true);
    assert.equal(s.config.control.endMarginS, 5);
  }
});

test('位置・信号・時計: 全フレームで表示値が state / signalAt / tick と一致する', () => {
  for (const id of ids) {
    const config = getScenario(id).config;
    fullRun(config, (s) => {
      const f = buildFrame(s, config, { speed: 1 });
      assert.equal(f.world.x, s.x);
      assert.equal(f.tick, s.tick);
      assert.ok(Math.abs(f.t - s.tick / TPS) < 1e-12);
      const sig = core.signalAt(config.signal, s.t);
      assert.equal(f.signal.color, sig.color);
      assert.equal(f.signal.remainingS, sig.remainingS);
      assert.equal(f.world.toCrossingM, Math.max(0, config.route.crossingX - s.x));
      assert.equal(f.world.crossingX, config.route.crossingX);
    });
  }
});

test('スマホと Watch の目標 BPM は同じ view-model から出て一致する（全シナリオ・全フレーム）', () => {
  for (const id of ids) {
    const config = getScenario(id).config;
    fullRun(config, (s) => {
      const f = buildFrame(s, config, { speed: 5 });
      assert.equal(f.watch.targetText, f.target.text);
      if (f.target.bpm != null) assert.ok(f.phone.targetText === f.target.text || f.phone.targetText === `目安 ${f.target.text} BPM`, f.phone.targetText);
      assert.equal(f.phone.bpmText, f.watch.bpmText);
      assert.equal(f.phone.bpmText, f.world.bpmText);
      assert.equal(f.inputs.find((i) => i.key === 'bpm').value, f.world.bpmText);
    });
  }
});

test('現在BPMと目標BPMは区別され、目標が変わった瞬間に現在BPMは飛ばない（B）', () => {
  const config = getScenario('B').config;
  let prev = null;
  let sawGap = false;
  fullRun(config, (s) => {
    if (prev && !s.finished && s.phase !== 'waiting') {
      assert.ok(Math.abs(s.bpm - prev.bpm) <= 2 + 1e-9, `BPM が飛んだ ${prev.bpm}→${s.bpm}`);
    }
    if (s.targetBpm !== s.bpm && s.mode === 'adjusting') sawGap = true;
    prev = s;
  });
  assert.ok(sawGap, '目標と現在が異なる区間がある');
});

test('§5.2 の文言: B の調整・W の準備→早歩き・待機・ゴール', () => {
  const texts = new Map();
  for (const id of ids) {
    const config = getScenario(id).config;
    fullRun(config, (s) => {
      const f = buildFrame(s, config, { speed: 1 });
      texts.set(`${id}:${f.judge.kind}`, f);
    });
  }
  assert.equal(texts.get('B:adjust').judge.text, '青に合わせて歩調を調整');
  assert.match(texts.get('B:adjust').phone.sub, /^青に合わせて少しペースを(上げる|下げる)$/);
  assert.equal(texts.get('W:prep').judge.text, '早歩きへの切替に向けて調整');
  assert.equal(texts.get('W:prep').world.action, 'run');
  assert.equal(texts.get('W:walk').judge.text, '早歩きでつなぐ');
  assert.equal(texts.get('W:walk').world.action, 'walk');
  assert.equal(texts.get('W:walk').watch.icon, 'walk');
  assert.ok(texts.get('W:done') || texts.get('B:done'));
  assert.equal(texts.get('B:done').judge.text, 'ゴール');
  assert.equal(texts.get('B:done').phone.headline, '完了');
});

test('待機: 人物は停止・BPM と速度が 0・Watch のリングが止まる・停止推奨とは別表示', () => {
  const config = getScenario('B').config;
  // RUNWAVE 側が待機することは無い条件もあるので、通常走行（enabled=false）で待機状態を作って表示値を検証する
  const off = { ...config, control: { ...config.control, enabled: false } };
  let saw = false;
  fullRun(off, (s) => {
    const f = buildFrame(s, off, { speed: 1 });
    if (s.phase === 'waiting') {
      saw = true;
      assert.equal(f.world.action, 'wait');
      assert.equal(f.world.moving, false);
      assert.equal(f.world.bpm, 0);
      assert.equal(f.world.speedKmh, 0);
      assert.equal(f.watch.ringMode, 'stopped');
      assert.equal(f.watch.icon, 'wait');
      assert.equal(f.phone.headline, '信号待ち');
      assert.notEqual(f.phone.headline, '停止推奨');
    }
  });
  assert.ok(saw);
});

test('倍速(2/5)ではリングを点滅(beat)させず steady、1倍のみ beat', () => {
  const config = getScenario('B').config;
  const s = stateAtTick(config, 300);
  assert.equal(buildFrame(s, config, { speed: 1 }).watch.ringMode, 'beat');
  assert.equal(buildFrame(s, config, { speed: 2 }).watch.ringMode, 'steady');
  assert.equal(buildFrame(s, config, { speed: 5 }).watch.ringMode, 'steady');
});

test('見せ場: B/A/W で検出でき、逐次 step の state と場面ジャンプの state が一致する', () => {
  const report = {};
  for (const id of ids) {
    const config = getScenario(id).config;
    const hs = highlightsFor(id);
    report[id] = hs.map((h) => `${h.kind}@${h.tick}(${h.mode}/${h.reason})`);
    assert.ok(hs.length > 0, `${id}: 見せ場なし`);
    for (const h of hs) {
      const session = createSession(config);
      session.jumpTo(h.tick);
      const seq = stateAtTick(config, h.tick);
      assert.deepEqual(session.state, seq);
      assert.equal(session.state.tick, h.tick);
      assert.equal(session.state.mode, h.mode);
      // 独立に 1 tick ずつ core を回した結果とも一致
      let s = core.createRun(config);
      for (let i = 0; i < h.tick; i++) s = core.step(s, config);
      assert.deepEqual(session.state, s);
      assert.equal(session.status, 'paused');
    }
  }
  assert.ok(highlightsFor('W').some((h) => h.kind === 'prep'));
  assert.ok(highlightsFor('W').some((h) => h.kind === 'walk'));
  assert.ok(highlightsFor('B').some((h) => h.kind === 'adjust'));
  console.log('見せ場:', JSON.stringify(report));
});

test('見せ場が起きない条件では空（捏造しない）', () => {
  const base = getScenario('B').config;
  // 信号が常に青の条件では調整も待機も起きない
  const config = { ...base, signal: { ...base.signal, greenS: 120, yellowS: 0, redS: 0, cycleS: 120 } };
  assert.deepEqual(findHighlights(config), []);
});

test('解説中は tick が進まず、各段のデータは同じ時点（同じ state）から出る。終了後も停止を保つ', () => {
  const config = getScenario('B').config;
  const session = createSession(config, { speed: 5 });
  const ex = createExplanation();
  let now = 0;
  session.play(); session.frame(now);
  for (let i = 0; i < 30; i++) { now += 100; session.frame(now); }
  assert.equal(session.status, 'playing');
  assert.ok(session.tick > 0);
  const tick0 = session.tick;
  const f0 = buildFrame(session.state, config, { speed: 5 });

  assert.equal(startExplanation(session, ex, now), true);
  assert.equal(session.status, 'explaining');
  assert.equal(session.running, false);
  const seenStages = [];
  for (let i = 0; i < 60; i++) {
    now += 100;
    session.frame(now); // 呼ばれても進まない
    assert.equal(session.tick, tick0);
    if (ex.active) assert.equal(session.play(), false); // 解説中は再生できない
    const r = tickExplanation(session, ex, now);
    if (r.active) {
      if (seenStages.at(-1) !== r.stage) seenStages.push(r.stage);
      assert.deepEqual(buildFrame(session.state, config, { speed: 5 }), f0); // 各段で同じ時点のデータ
    }
  }
  assert.deepEqual(seenStages, STAGES);
  assert.equal(ex.active, false);
  assert.equal(session.hold, false);
  assert.equal(session.running, false, '終了後も停止状態');
  assert.equal(session.status, 'paused');
  assert.equal(session.tick, tick0);
  assert.ok(Math.abs(stagesDurationS(FULL_STAGES) - 3.95) < 1e-9);
  assert.ok(Math.abs(stagesDurationS(SHORT_STAGES) - 1.8) < 1e-9);
  // 操作者が再生すれば進む
  session.play(); session.frame(now); session.frame(now + 500);
  assert.ok(session.tick > tick0);
});

test('リセット・シナリオ切替で演出キューと解説が空になる', () => {
  const session = createSession(getScenario('B').config);
  const ex = createExplanation();
  ex.addPulse('flow', 0); ex.addPulse('haptic', 0);
  assert.equal(ex.queueLength, 2);
  startExplanation(session, ex, 0);
  assert.equal(ex.active, true);
  resetDemo(session, ex, getScenario('W').config);
  assert.equal(ex.queueLength, 0);
  assert.equal(ex.active, false);
  assert.deepEqual(ex.activePulses(1), []);
  assert.equal(session.hold, false);
  assert.equal(session.tick, 0);
  assert.equal(session.status, 'ready');
  assert.equal(session.config, getScenario('W').config);
  // 期限切れの演出は捨てられる
  ex.addPulse('flow', 0, 900);
  assert.deepEqual(ex.activePulses(500), ['flow']);
  assert.deepEqual(ex.activePulses(1000), []);
  assert.equal(ex.queueLength, 0);
});

test('1 フレームの取り込みは 1 秒まで（巨大な追いつきをしない）', () => {
  assert.equal(MAX_FRAME_MS, 1000);
  assert.equal(planTicks({ elapsedMs: 3_600_000, speed: 5 }).n, 50);
  const s = createSession(getScenario('B').config, { speed: 5 });
  s.play(); s.frame(0);
  s.frame(10 * 60 * 1000);
  assert.equal(s.tick, 50);
  assert.throws(() => planTicks({ elapsedMs: 10, speed: 0 }), RangeError);
});

test('端数は carry に持ち越され、tick は飛ばない', () => {
  let carry = 0; let total = 0;
  for (let i = 0; i < 100; i++) { const r = planTicks({ carry, elapsedMs: 16.7, speed: 1 }); carry = r.carry; total += r.n; }
  assert.equal(total, Math.floor((100 * 16.7) / 100 + 1e-9));
});

test('タブ非表示で自動停止し、復帰しても停止を維持して時間が飛ばない。play 多重でも速くならない', () => {
  const config = getScenario('B').config;
  const s = createSession(config, { speed: 5 });
  s.play(); s.frame(0); s.frame(500);
  const t = s.tick;
  s.hide();
  assert.equal(s.status, 'paused');
  s.frame(600000);
  assert.equal(s.tick, t);
  // 復帰（visible）しても自動再開しない。play すると基準時刻をリセットして飛ばない
  s.play(); s.frame(600000); s.frame(600100);
  assert.equal(s.tick, t + 5);
  const one = createSession(config, { speed: 1 });
  const many = createSession(config, { speed: 1 });
  one.play(); one.frame(0);
  for (let i = 0; i < 20; i++) many.play();
  many.frame(0);
  for (let x = 100; x <= 1000; x += 100) { one.frame(x); many.frame(x); }
  assert.equal(many.tick, one.tick);
  assert.equal(one.tick, 10);
});

test('倍率 1/2/5・不規則フレームでも最終 state は core の逐次 step と一致する', () => {
  const config = getScenario('B').config;
  const ref = fullRun(config);
  const jitter = [16.7, 33.4, 8, 120, 16.7, 250, 16.7];
  for (const speed of [1, 2, 5]) {
    const s = createSession(config, { speed });
    let now = 0;
    s.play(); s.frame(now);
    for (let i = 0; i < 200000 && s.running; i++) { now += speed === 1 ? 400 + jitter[i % 7] : 300 + jitter[i % 7]; s.frame(now); }
    assert.equal(s.status, 'done');
    assert.deepEqual(core.summarize(s.state, config), core.summarize(ref, config));
  }
});

test('計算上限: 1800 秒で未完了なら limit（到達不能と断定しない）', () => {
  const base = getScenario('B').config;
  const config = { ...base, route: { crossingX: 9000, goalX: 10000 } };
  const s = createSession(config);
  s.play(); let now = 0; s.frame(now);
  for (let i = 0; i < 100000 && s.running; i++) { now += 1000; s.frame(now); }
  assert.equal(s.tick, MAX_TICKS);
  assert.equal(s.status, 'limit');
  assert.equal(s.summary().termination, 'timeLimit');
  assert.equal(s.play(), false);
});

test('不正な条件のリセットは例外を投げ、現在の状態と演出を保つ', () => {
  const s = createSession(getScenario('B').config);
  const ex = createExplanation();
  ex.addPulse('flow', 0);
  s.play(); s.frame(0); s.frame(500);
  const before = s.state;
  assert.throws(() => resetDemo(s, ex, { ...s.config, runner: { strideM: -1, baseBpm: 150 } }), RangeError);
  assert.equal(s.state, before);
  assert.equal(ex.queueLength, 1);
});

test('完了時: 停止回数・停止時間の結果が core の summarize から得られる', () => {
  const config = getScenario('B').config;
  const s = createSession(config);
  s.jumpTo(MAX_TICKS);
  assert.equal(s.status, 'done');
  const sum = s.summary();
  assert.equal(sum.finished, true);
  assert.equal(sum.stops, 0);
});

// ---------- 30 秒デモ ----------
const realSecondsToFinish = (config, key) => {
  const s = createSession(config, { speed: key });
  s.setSpeed(key);
  let now = 0;
  s.play(); s.frame(now);
  let frames = 0;
  while (s.running && frames < 1000000) { now += 1000 / 60; s.frame(now); frames++; }
  return { real: now / 1000, session: s };
};

test('30秒デモが既定。倍率は「最後まで逐次 step した所要時間 ÷ 30」で、表示に実倍率が出る', () => {
  const s = createSession(getScenario('B').config);
  assert.equal(s.speed, DEMO_SPEED);
  const ref = fullRun(getScenario('B').config);
  assert.ok(Math.abs(s.multiplier - ref.finishTimeS / 30) < 1e-9);
  assert.match(s.speedLabel, /^約[0-9]+.[0-9]倍速（30秒デモ）$/);
  assert.ok(Math.abs(s.multiplier - 9.47) < 0.05, String(s.multiplier));
  const mult = {};
  for (const id of ids) mult[id] = Math.round(demoMultiplier(getScenario(id).config) * 100) / 100;
  console.log('30秒デモ倍率:', JSON.stringify(mult));
});

for (const id of ids) {
  test(`${id}: 30秒デモで実時間 30±1 秒で完了し、最終 summary は 1 倍・逐次 step と一致する`, () => {
    const config = getScenario(id).config;
    const { real, session } = realSecondsToFinish(config, DEMO_SPEED);
    assert.equal(session.status, 'done');
    assert.ok(Math.abs(real - 30) <= 1, `${id}: 実時間 ${real} 秒`);
    // 不規則なフレーム間隔でも tick は飛ばず、結果は同じ
    const ref = core.summarize(fullRun(config), config);
    assert.deepEqual(session.summary(), ref);
    const one = realSecondsToFinish(config, 1);
    assert.equal(one.session.status, 'done');
    assert.deepEqual(one.session.summary(), session.summary());
    assert.ok(one.real > 100, '1倍は実時間で数分かかる');
  });
}

test('30秒デモ: 解説中（一時停止扱い）の時間は 30 秒に含まれない', () => {
  const config = getScenario('B').config;
  const s = createSession(config);
  const ex = createExplanation();
  let now = 0;
  s.play(); s.frame(now);
  let real = 0;
  const run = (sec) => { for (let i = 0; i < sec * 60; i++) { now += 1000 / 60; real += 1 / 60; s.frame(now); } };
  run(10);
  const tick0 = s.tick;
  startExplanation(s, ex, now);
  for (let i = 0; i < 300; i++) { now += 1000 / 60; s.frame(now); tickExplanation(s, ex, now); }
  assert.equal(s.tick, tick0);
  s.play(); s.frame(now);
  let playedAfter = 0;
  while (s.running) { now += 1000 / 60; s.frame(now); playedAfter += 1 / 60; }
  assert.ok(Math.abs(real + playedAfter - 30) <= 1, `再生した実時間 ${real + playedAfter}`);
});

test('30秒デモ: 倍率が高くても tick は飛ばず（1 フレーム数 tick）、Watch は点滅させない', () => {
  const config = getScenario('B').config;
  const s = createSession(config);
  s.play(); s.frame(0);
  let prev = s.tick;
  for (let i = 1; i <= 200; i++) {
    s.frame(i * (1000 / 60));
    assert.ok(s.tick - prev >= 0 && s.tick - prev <= 3);
    prev = s.tick;
  }
  assert.equal(s.state.tick, s.tick);
  assert.equal(buildFrame(s.state, config, { speed: s.multiplier }).watch.ringMode, 'steady');
});

test('足の周期: 30秒デモ・150BPM で、足が示す地面速度と実際の地面の流れ(px/s)の差が 10% 以内', () => {
  const config = getScenario('B').config;
  const s = createSession(config); // 既定 = 30秒デモ
  const f = buildFrame(s.state, config, { speed: s.multiplier });
  assert.equal(f.world.action, 'run');
  assert.equal(PX_PER_M, 12);
  const groundPxS = s.state.speedMps * s.multiplier * PX_PER_M; // 画面上で地面が流れる速さ
  const footPxS = footPxPerCycle('run') / f.world.cycleS; // 足の動きが示す速さ
  console.log(`B 30秒デモ: 足の周期 ${f.world.cycleS.toFixed(3)}秒、地面 ${groundPxS.toFixed(1)}px/s、足 ${footPxS.toFixed(1)}px/s`);
  assert.ok(Math.abs(footPxS - groundPxS) / groundPxS <= 0.1);
  assert.equal(f.world.multiplier, s.multiplier);
});

test('足の周期: 0.35〜1.2 秒に収まり、歩行も同じ式、止まる動作では null', () => {
  assert.equal(footCycleS('wait', 2, 5), null);
  assert.equal(footCycleS('done', 2, 5), null);
  assert.equal(footCycleS('run', 0, 5), null);
  assert.equal(footCycleS('run', 2, 1000), CYCLE_MIN_S); // 速すぎる → 下限
  assert.equal(footCycleS('run', 2, 1), CYCLE_MAX_S); // 1 倍 → 上限（足が地面より速くなるのは許容）
  const walk = footCycleS('walk', 5.5 / 3.6, 11.36);
  assert.ok(walk >= CYCLE_MIN_S && walk <= CYCLE_MAX_S);
  const ideal = footPxPerCycle('walk') / ((5.5 / 3.6) * 11.36 * PX_PER_M);
  if (ideal >= CYCLE_MIN_S && ideal <= CYCLE_MAX_S) assert.ok(Math.abs(walk - ideal) < 1e-9);
  // 全シナリオ・全フレームで範囲内、待機・ゴールでは null
  for (const id of ids) {
    const config = getScenario(id).config;
    const mult = createSession(config).multiplier;
    fullRun(config, (st) => {
      const fr = buildFrame(st, config, { speed: mult });
      if (fr.world.moving) assert.ok(fr.world.cycleS >= CYCLE_MIN_S - 1e-9 && fr.world.cycleS <= CYCLE_MAX_S + 1e-9);
      else assert.equal(fr.world.cycleS, null);
    });
  }
});
