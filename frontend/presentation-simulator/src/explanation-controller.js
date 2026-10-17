// 解説中の停止と段階（ズーム・強調）、演出（発光・振動イメージ）の管理（DOM 非依存）。時刻は呼び出し側が渡す（performance.now など）。
// 解説中はシミュレーション時計を止める（session.setHold(true)）。終了後も停止状態を保ち、再生は操作者（または通しデモ）が行う。
// 段階の順番は概念の演出であり、実際のサーバー応答時間ではない。

/** 全編: a 人物と信号 → b ①状態入力 → c ②判定 → d ③スマホ・Watch → e 全体に戻る（合計 3.95 秒） */
export const FULL_STAGES = [
  { id: 'world', ms: 800 },
  { id: 'input', ms: 800 },
  { id: 'judge', ms: 1000 },
  { id: 'output', ms: 1000 },
  { id: 'return', ms: 350 },
];
/** 短縮版（W の 2 回目）: a と d だけ（合計 1.8 秒） */
export const SHORT_STAGES = [
  { id: 'world', ms: 800 },
  { id: 'output', ms: 1000 },
];
export const STAGES = FULL_STAGES.map((s) => s.id);
export const PULSE_MS = 900;

export const stagesDurationS = (stages) => stages.reduce((a, s) => a + s.ms, 0) / 1000;

export function createExplanation() {
  let startedAt = null;
  let stages = FULL_STAGES;
  let pulses = [];
  const api = {
    get active() { return startedAt !== null; },
    get queueLength() { return pulses.length; },
    start(nowMs, useStages = FULL_STAGES) {
      if (startedAt !== null) return false;
      startedAt = nowMs;
      stages = useStages;
      return true;
    },
    /** 現在の段。終了したら { active:false, finished:true } を 1 回返して片付ける */
    update(nowMs) {
      if (startedAt === null) return { active: false, stage: null, index: -1, finished: false };
      let t = Math.max(0, nowMs - startedAt);
      for (let i = 0; i < stages.length; i++) {
        if (t < stages[i].ms) return { active: true, stage: stages[i].id, index: i, finished: false };
        t -= stages[i].ms;
      }
      startedAt = null;
      return { active: false, stage: null, index: -1, finished: true };
    },
    cancel() { startedAt = null; },
    addPulse(kind, nowMs, durationMs = PULSE_MS) {
      pulses.push({ kind, startedAt: nowMs, until: nowMs + durationMs });
    },
    /** いま光らせる演出の種別一覧。期限切れは捨てる */
    activePulses(nowMs) {
      pulses = pulses.filter((p) => p.until > nowMs);
      return [...new Set(pulses.map((p) => p.kind))];
    },
    clear() { pulses = []; },
  };
  return api;
}

/** 解説を始める: 時計を止めて段階を開始。再生中でも止める */
export function startExplanation(session, explanation, nowMs, stages = FULL_STAGES) {
  if (explanation.active) return false;
  session.setHold(true);
  return explanation.start(nowMs, stages);
}

/** 毎フレーム。解説が終わったら hold を解除する（再生はしない＝停止状態を保つ） */
export function tickExplanation(session, explanation, nowMs) {
  const r = explanation.update(nowMs);
  if (r.finished && session.hold) session.setHold(false);
  return r;
}

/** シナリオ切替・リセット: 人物・判定・端末・演出キューをまとめて初期化する */
export function resetDemo(session, explanation, nextConfig) {
  session.reset(nextConfig); // 不正なら例外（演出はそのまま）
  explanation.cancel();
  explanation.clear();
}
