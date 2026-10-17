// 通しデモ: B（テンポ調整）→ A（減速調整）→ W（早歩き）を自動で続けて再生する（DOM 非依存）。
// 各区間は t=0 から「横断地点を通過して x ≥ crossingX + crossingM + 10m」になった tick まで。終了 tick・解説の tick は
// どちらも core を逐次 step して求める（手書きしない）。倍率は「区間の sim 秒 ÷ 7 秒」。解説中は時計を止める（区間の 7 秒に含めない）。
import { core } from './core-ns.js';
import { SCENARIO_LIST } from './scenarios.js';
import { MAX_TICKS, TPS } from './simulation.js';
import { FULL_STAGES, SHORT_STAGES, stagesDurationS, startExplanation, tickExplanation, resetDemo } from './explanation-controller.js';

export const PLAY_S = 7; // 1 シナリオの実時間（解説・タイトルを除く）
export const TITLE_MS = 800;
export const BEYOND_M = 10; // 横断地点＋横断長 より先まで走る距離

/** 区間の終了 tick: x ≥ crossingX + crossingM + 10m になった最初の tick（ゴールが先ならゴール） */
export function segmentEndTick(config) {
  const goalAt = config.route.crossingX + config.signal.crossingM + BEYOND_M;
  let s = core.createRun(config);
  while (!s.finished && s.tick < MAX_TICKS && s.x < goalAt) s = core.step(s, config);
  return s.tick;
}

/** 解説を入れる tick: 目標 BPM が通常値から最初に変わった tick（full）と、walking に入った tick（short。同じ tick なら full のみ） */
export function explainEvents(config, endTick) {
  const base = config.runner.baseBpm;
  let s = core.createRun(config);
  let targetTick = null;
  let walkTick = null;
  while (!s.finished && s.tick < endTick) {
    s = core.step(s, config);
    if (targetTick === null && Math.abs(s.targetBpm - base) > 1e-9) targetTick = s.tick;
    if (walkTick === null && s.mode === 'walking') walkTick = s.tick;
    if (targetTick !== null && walkTick !== null) break;
  }
  const events = [];
  if (targetTick !== null) events.push({ tick: targetTick, kind: 'full', why: 'target' });
  if (walkTick !== null && walkTick !== targetTick) events.push({ tick: walkTick, kind: 'short', why: 'walking' });
  return events.sort((a, b) => a.tick - b.tick);
}

/** タイトル。向きは core が最初に選んだ目標 BPM（通常との大小）から決める */
export function titleFor(id, config, endTick) {
  const ev = explainEvents(config, endTick);
  let s = core.createRun(config);
  const first = ev[0];
  while (first && s.tick < first.tick) s = core.step(s, config);
  const walks = ev.some((e) => e.why === 'walking');
  if (walks) return `${id}：走るだけでは難しい場面を早歩きでつなぐ`;
  if (first && s.targetBpm > config.runner.baseBpm) return `${id}：青に合わせて加速`;
  if (first && s.targetBpm < config.runner.baseBpm) return `${id}：青に合わせて減速`;
  return `${id}：通常ペース`;
}

export function buildTourPlan() {
  const segments = SCENARIO_LIST.map((sc) => {
    const endTick = segmentEndTick(sc.config);
    const events = explainEvents(sc.config, endTick);
    const simS = endTick / TPS;
    const multiplier = simS / PLAY_S;
    const explainS = events.reduce((a, e) => a + stagesDurationS(e.kind === 'full' ? FULL_STAGES : SHORT_STAGES), 0);
    return { id: sc.id, config: sc.config, endTick, simS, multiplier, events, explainS, title: titleFor(sc.id, sc.config, endTick) };
  });
  const totalS = segments.reduce((a, s) => a + TITLE_MS / 1000 + PLAY_S + s.explainS, 0);
  return { segments, totalS };
}

let cachedPlan = null;
export const tourPlan = () => (cachedPlan ??= buildTourPlan());

/**
 * phase: off / ready（B の頭で待機）/ title / play / done
 * 再生・一時停止はユーザー操作を優先する（一時停止・タブ非表示のあとは自動再開しない）。
 */
export function createTour({ session, explanation, plan = tourPlan(), onSegment = () => {} }) {
  let phase = 'off';
  let index = 0;
  let titleStart = 0;
  let evIdx = 0;
  let userPaused = false;
  let autoActive = false; // 通しデモが始めた解説が進行中

  const seg = () => plan.segments[index];
  const armBreak = () => {
    const ev = seg().events[evIdx];
    session.breakTick = ev ? ev.tick : seg().endTick;
  };
  const enterSegment = () => {
    const sg = seg();
    resetDemo(session, explanation, sg.config); // 人物・判定・端末・演出キューをまとめて初期化
    session.setCustomMultiplier(sg.multiplier);
    evIdx = 0;
    armBreak();
    phase = 'play';
    autoActive = false;
    onSegment(sg, index);
    if (!userPaused) session.play();
  };
  const beginTitle = (now) => {
    phase = 'title';
    titleStart = now;
    session.pause();
  };

  const api = {
    get phase() { return phase; },
    get active() { return phase !== 'off'; },
    get index() { return index; },
    get segment() { return phase === 'off' ? null : seg(); },
    get title() { return phase === 'title' ? seg().title : null; },
    get plan() { return plan; },
    /** 通しデモに入る（B の頭で待機。再生ボタンで始まる） */
    arm() {
      phase = 'ready';
      autoActive = false;
      index = 0;
      evIdx = 0;
      userPaused = false;
      resetDemo(session, explanation, seg().config);
      session.setCustomMultiplier(seg().multiplier);
      session.breakTick = Infinity;
      onSegment(seg(), 0);
    },
    stop() {
      phase = 'off';
      session.breakTick = Infinity;
      userPaused = false;
    },
    /** 再生ボタン */
    notePlay(now) {
      if (phase === 'off') return;
      userPaused = false;
      if (phase === 'done') api.arm();
      if (phase === 'ready') beginTitle(now);
      else if (phase === 'play') session.play();
    },
    /** 一時停止ボタン・タブ非表示 */
    notePause() {
      if (phase === 'off') return;
      userPaused = true;
    },
    /** 解説の中断（タブ非表示など）。通しデモが始めた解説なら、その解説は飛ばして次へ進める */
    interrupt() {
      if (phase === 'play' && autoActive) {
        autoActive = false;
        evIdx += 1;
        armBreak();
      }
    },
    /** 毎フレーム。解説の段（tickExplanation の結果）を返す */
    update(now) {
      const ex = tickExplanation(session, explanation, now);
      if (phase === 'off') return ex;
      if (phase === 'title') {
        if (now - titleStart >= TITLE_MS) enterSegment();
        return ex;
      }
      if (phase !== 'play') return ex;
      if (ex.finished && autoActive) {
        autoActive = false;
        evIdx += 1;
        armBreak();
        if (!userPaused) session.play();
        return ex;
      }
      if (explanation.active) return ex;
      const sg = seg();
      const ev = sg.events[evIdx];
      if (ev && session.tick >= ev.tick) {
        // 解説を始める（時計を止める）。終わったら次の break tick へ
        startExplanation(session, explanation, now, ev.kind === 'full' ? FULL_STAGES : SHORT_STAGES);
        autoActive = true;
        return explanation.update(now);
      }
      if (session.tick >= sg.endTick) {
        if (index + 1 < plan.segments.length) {
          index += 1;
          beginTitle(now);
        } else {
          phase = 'done';
          session.breakTick = Infinity;
        }
      }
      return ex;
    },
  };
  return api;
}
