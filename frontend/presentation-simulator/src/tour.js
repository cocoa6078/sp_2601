// 通しデモ: B（テンポ調整）→ A（減速調整）→ W（早歩き）を自動で続けて再生する（DOM 非依存）。
// 各シナリオは「見せ場の窓」だけを約 4 倍速で再生し、窓と窓のあいだはカット（場面ジャンプ）する。
//   窓1: 最初に目標 BPM が変わった tick から sim 12 秒
//   窓2: 横断地点の 30m 手前に入る tick → x ≥ crossingX + crossingM + 10m の tick まで
//   W だけ窓2a: walking に入る tick の 2 秒前から 6 秒後（窓2bとのあいだもカット）
// 窓の tick・ジャンプ先の state はどちらも core を逐次 step して求める（手書きしない・途中の値の補間もしない）。
// ゴールまでは再生しない。解説中は時計を止める。
import { core } from './core-ns.js';
import { SCENARIO_LIST } from './scenarios.js';
import { MAX_TICKS, TPS } from './simulation.js';
import { FULL_STAGES, SHORT_STAGES, stagesDurationS, startExplanation, tickExplanation, resetDemo } from './explanation-controller.js';

export const TITLE_MS = 800;
export const CUT_MS = 600; // 「▶▶ 約○秒後」を出す時間
export const BEYOND_M = 10; // 横断地点＋横断長 より先まで走る距離
export const WINDOW1_S = 12; // 窓1の長さ（sim 秒）
export const APPROACH_M = 30; // 窓2の開始: 横断地点の何 m 手前か（40m だと合計が 45 秒を超えるため 30m）
export const WALK_LEAD_TICKS = 20; // 窓2a の開始: walking に入る何 tick 前か（2 秒）
export const WALK_TAIL_TICKS = 60; // 窓2a の終了: walking に入った何 tick 後か（6 秒）
export const TOUR_MULTIPLIER = 5; // 窓の倍率（これ以上上げない。尺は窓の短縮とカットで縮める）
export const TOTAL_TARGET_S = [40, 45]; // 合計の目標範囲（実時間）

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

/** 横断地点の 40m 手前に入った最初の tick（core を逐次 step。入らなければ null） */
export function approachTick(config, endTick) {
  const at = config.route.crossingX - APPROACH_M;
  let s = core.createRun(config);
  while (!s.finished && s.tick < endTick) {
    s = core.step(s, config);
    if (s.x >= at) return s.tick;
  }
  return null;
}

/** 見せ場の窓（昇順・重ならない）。重なる・隣り合う窓は 1 つにまとめる（カットしない） */
export function buildWindows(config, endTick = segmentEndTick(config), events = explainEvents(config, endTick)) {
  const target = events.find((e) => e.why === 'target');
  const walk = events.find((e) => e.why === 'walking');
  const w1Start = target ? target.tick : 0;
  const raw = [{ startTick: w1Start, endTick: Math.min(endTick, w1Start + Math.round(WINDOW1_S * TPS)) }];
  if (walk) raw.push({ startTick: Math.max(0, walk.tick - WALK_LEAD_TICKS), endTick: Math.min(endTick, walk.tick + WALK_TAIL_TICKS) });
  const t40 = approachTick(config, endTick);
  if (t40 !== null) raw.push({ startTick: t40, endTick });
  else raw.push({ startTick: raw.at(-1).endTick, endTick });
  raw.sort((x, y) => x.startTick - y.startTick);
  const out = [];
  for (const w of raw) {
    const last = out.at(-1);
    if (last && w.startTick <= last.endTick) last.endTick = Math.max(last.endTick, w.endTick);
    else out.push({ ...w });
  }
  return out;
}

/** タイトル。向きは core が最初に選んだ目標 BPM（通常との大小）から決める */
export function titleFor(id, config, endTick) {
  const ev = explainEvents(config, endTick);
  let s = core.createRun(config);
  const first = ev[0];
  while (first && s.tick < first.tick) s = core.step(s, config);
  if (ev.some((e) => e.why === 'walking')) return `${id}：走るだけでは難しい場面を早歩きでつなぐ`;
  if (first && s.targetBpm > config.runner.baseBpm) return `${id}：青に合わせて加速`;
  if (first && s.targetBpm < config.runner.baseBpm) return `${id}：青に合わせて減速`;
  return `${id}：通常ペース`;
}

function planTotalS(segments, multiplier) {
  return segments.reduce((a, sg) => {
    const play = sg.windows.reduce((x, w) => x + (w.endTick - w.startTick) / TPS, 0) / multiplier;
    return a + TITLE_MS / 1000 + play + (sg.windows.length - 1) * (CUT_MS / 1000) + sg.explainS;
  }, 0);
}

export function buildTourPlan() {
  const segments = SCENARIO_LIST.map((sc) => {
    const endTick = segmentEndTick(sc.config);
    const events = explainEvents(sc.config, endTick);
    const windows = buildWindows(sc.config, endTick, events);
    // 解説（ズーム）: B は全編。A は B で一度見せているので窓1は短縮版。W の窓1は全編、walking 開始は短縮版
    if (events[0] && sc.id === 'A') events[0].kind = 'short';
    const explainS = events.reduce((a, e) => a + stagesDurationS(e.kind === 'full' ? FULL_STAGES : SHORT_STAGES), 0);
    const cutSimS = windows.slice(1).reduce((x, w, i) => x + (w.startTick - windows[i].endTick) / TPS, 0);
    return { id: sc.id, config: sc.config, endTick, windows, events, explainS, cutSimS, title: titleFor(sc.id, sc.config, endTick) };
  });
  const multiplier = TOUR_MULTIPLIER;
  for (const sg of segments) {
    sg.multiplier = multiplier;
    sg.playedSimS = sg.windows.reduce((x, w) => x + (w.endTick - w.startTick) / TPS, 0);
  }
  return { segments, multiplier, totalS: planTotalS(segments, multiplier) };
}

let cachedPlan = null;
export const tourPlan = () => (cachedPlan ??= buildTourPlan());

export const cutText = (skippedSimS) => `▶▶ 約${Math.round(skippedSimS)}秒後`;

/**
 * phase: off / ready（B の頭で待機）/ title / play / cut / done
 * 再生・一時停止はユーザー操作を優先する（一時停止・タブ非表示のあとは自動再開しない）。
 */
export function createTour({ session, explanation, plan = tourPlan(), onSegment = () => {}, onCut = () => {} }) {
  let phase = 'off';
  let index = 0;
  let winIdx = 0;
  let titleStart = 0;
  let cutStart = 0;
  let evIdx = 0;
  let userPaused = false;
  let autoActive = false; // 通しデモが始めた解説が進行中

  const seg = () => plan.segments[index];
  const win = () => seg().windows[winIdx];
  const armBreak = () => {
    const ev = seg().events[evIdx];
    session.breakTick = ev && ev.tick >= win().startTick && ev.tick <= win().endTick ? ev.tick : win().endTick;
  };
  const enterSegment = () => {
    const sg = seg();
    resetDemo(session, explanation, sg.config); // 人物・判定・端末・演出キューをまとめて初期化
    session.setCustomMultiplier(sg.multiplier);
    winIdx = 0;
    evIdx = 0;
    // 窓1の頭へ（core を逐次 step して得た state。最初に目標が変わる tick なのでごく手前）
    if (win().startTick > 0) session.jumpTo(win().startTick);
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
    get windowIndex() { return winIdx; },
    get segment() { return phase === 'off' ? null : seg(); },
    get title() { return phase === 'title' ? seg().title : null; },
    /** カット中の表示。skippedSimS はこれからジャンプする sim 秒 */
    get cut() {
      if (phase !== 'cut') return null;
      const skippedSimS = (seg().windows[winIdx + 1].startTick - win().endTick) / TPS;
      return { skippedSimS, text: cutText(skippedSimS) };
    },
    get plan() { return plan; },
    /** 通しデモに入る（B の頭で待機。再生ボタンで始まる） */
    arm() {
      phase = 'ready';
      autoActive = false;
      index = 0;
      winIdx = 0;
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
      if (phase === 'cut') {
        if (now - cutStart >= CUT_MS) {
          winIdx += 1;
          session.jumpTo(win().startTick); // core を逐次 step して得た state へそのまま切り替える（補間しない）
          armBreak();
          phase = 'play';
          onCut(win().startTick);
          if (!userPaused) session.play();
        }
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
      if (ev && ev.tick >= win().startTick && ev.tick <= win().endTick && session.tick >= ev.tick) {
        startExplanation(session, explanation, now, ev.kind === 'full' ? FULL_STAGES : SHORT_STAGES);
        autoActive = true;
        return explanation.update(now);
      }
      if (session.tick >= win().endTick) {
        if (winIdx + 1 < sg.windows.length) {
          phase = 'cut';
          cutStart = now;
          session.pause();
        } else if (index + 1 < plan.segments.length) {
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
