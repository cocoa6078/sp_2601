// 共通の state と config から、人物・入力・判定・スマートフォン・Watch の表示値を 1 回で作る（DOM 非依存）。
// 同じフレームの全表示がこの 1 つの結果から出るので、スマホと Watch の目標 BPM は必ず一致する。
// 判定の文言は「core が選んだ結果（mode / reason / gait）の言い換え」だけ。到着予測や安全余裕の数値は作らない。
import { core } from './core-ns.js';
import { TPS } from './simulation.js';

export const DEFAULT_WALK_STRIDE_M = 0.75; // runner.walkStrideM 未指定時の表示用（core の早歩き歩幅の既定と同値）
export const UNKNOWN = '状態を確認';

// ---------- 足の周期（画面上で地面が流れる速さから決める） ----------
export const PX_PER_M = 12; // 1m = 12px（世界の縮尺。world-view と共通）
export const RUNNER_SCALE = 3; // 人物の拡大率（world-view と共通）
export const LEG_LEN = 22; // 脚の長さ（人物座標）
export const SWING_DEG = { run: 44, walk: 24 }; // 脚の振り幅（CSS の --amp と同じ値）
export const CYCLE_MIN_S = 0.35;
export const CYCLE_MAX_S = 1.2;
/** 1 往復（左右 2 歩）で足が地面を進む画面上の px */
export function footPxPerCycle(action) {
  const amp = ((SWING_DEG[action] ?? SWING_DEG.run) * Math.PI) / 180;
  return 2 * 2 * LEG_LEN * Math.sin(amp) * RUNNER_SCALE;
}
/** 足の 1 往復の秒数 = 1 往復で足が進む px ÷ 地面の流れ（speedMps × 実際の倍率 × PX_PER_M）。0.35〜1.2 秒に収める。止まるときは null */
export function footCycleS(action, speedMps, multiplier) {
  if (action !== 'run' && action !== 'walk') return null;
  const groundPxS = speedMps * multiplier * PX_PER_M;
  if (!(groundPxS > 0)) return null;
  return Math.min(CYCLE_MAX_S, Math.max(CYCLE_MIN_S, footPxPerCycle(action) / groundPxS));
}

const ceilS = (v) => Math.max(0, Math.ceil(v - 1e-9));
const r0 = (v) => Math.round(v);

/** 判定部の短文と端末向けの行動（§5.2 の表）。不明な組み合わせは「状態を確認」 */
export function describeDecision({ mode, reason, gait }, { direction }) {
  if (mode === 'finished') return { kind: 'done', judge: 'ゴール', phone: '完了', phoneSub: 'ゴール', person: 'done' };
  if (mode === 'waiting') return { kind: 'wait', judge: '青になるまで待機', phone: '信号待ち', phoneSub: '青になるまで待機', person: 'wait' };
  if (mode === 'stopRecommended') return { kind: 'stopRec', judge: '調整だけでは停止回避が難しい', phone: '停止推奨', phoneSub: '調整だけでは停止回避が難しい', person: 'run' };
  if (reason === 'passed') return { kind: 'passed', judge: '横断地点を通過／通常ペースへ', phone: '通常ペースへ', phoneSub: '横断地点を通過', person: gait === 'walk' ? 'walk' : 'run' };
  if (mode === 'walking') return { kind: 'walk', judge: '早歩きでつなぐ', phone: '早歩き', phoneSub: '早歩きでつなぐ', person: 'walk' };
  if (mode === 'adjusting' && reason === 'walkBridge') return { kind: 'prep', judge: '早歩きへの切替に向けて調整', phone: 'ペース調整中', phoneSub: '早歩きへの切替に向けて', person: 'run' };
  if (mode === 'adjusting' && reason === 'signal') {
    const phoneSub = direction === 'up' ? '青に合わせて少しペースを上げる' : direction === 'down' ? '青に合わせて少しペースを下げる' : '今のペースで';
    return { kind: 'adjust', judge: '青に合わせて歩調を調整', phone: 'ペース調整中', phoneSub, person: 'run' };
  }
  if (mode === 'normal' && reason === 'noMargin') return { kind: 'normal', judge: '通常ペースを維持（余裕条件を満たす計画なし）', phone: '今のペースで', phoneSub: '通常ペースを維持', person: 'run' };
  if (mode === 'normal' && (reason === 'none' || reason === 'off')) return { kind: 'normal', judge: '通常ペースを維持', phone: '今のペースで', phoneSub: '通常ペースを維持', person: 'run' };
  return { kind: 'unknown', judge: UNKNOWN, phone: UNKNOWN, phoneSub: `${mode} / ${reason}`, person: gait === 'walk' ? 'walk' : 'run' };
}

export function buildFrame(state, config, { speed = 1, status = 'paused' } = {}) {
  const { runner, route } = config;
  const t = state.tick / TPS;
  const signal = core.signalAt(config.signal, state.t);
  const finished = state.finished || state.phase === 'finished';
  const waiting = state.phase === 'waiting' && !finished;
  const idle = waiting || finished;
  const baseBpm = runner.baseBpm;

  const bpm = idle ? 0 : state.bpm;
  const target = idle ? null : state.targetBpm;
  const direction = target == null ? 'same' : target > baseBpm + 1e-9 ? 'up' : target < baseBpm - 1e-9 ? 'down' : 'same';
  const dec = describeDecision(state, { direction });

  const speedKmh = idle ? 0 : Number.isFinite(state.speedMps) ? state.speedMps * 3.6 : core.speedOf(runner.strideM, state.bpm) * 3.6;
  const walking = state.gait === 'walk' && !idle;
  const strideM = state.gait === 'walk' ? (runner.walkStrideM ?? DEFAULT_WALK_STRIDE_M) : runner.strideM;
  const toCrossingM = route.crossingX - state.x;
  const passed = toCrossingM <= 1e-9;

  // 信号（残りは現在の色が終わるまで。端数切り上げ）
  const remaining = ceilS(signal.remainingS);
  const signalText = `${signal.label}（残り${remaining}秒）`;

  const distanceText = passed ? '通過済み' : `${r0(toCrossingM)} m`;
  const bpmText = String(r0(bpm));
  const targetText = target == null ? '—' : String(r0(target));

  // 人物の動作（見た目）。待機・ゴールは足を止める
  const action = finished ? 'done' : waiting ? 'wait' : walking ? 'walk' : 'run';

  const worldLabel = finished ? 'ゴール' : waiting ? '信号待ち' : null;
  const stateLabel = finished ? 'ゴール' : waiting ? '信号待ち' : walking ? '早歩き' : dec.kind === 'adjust' || dec.kind === 'prep' ? 'テンポ調整中' : dec.kind === 'stopRec' ? '停止推奨' : dec.kind === 'unknown' ? UNKNOWN : '通常ペース';

  const ringMode = idle ? 'stopped' : speed > 1 ? 'steady' : 'beat'; // 倍速では点滅させない。待機・完了で止める
  const watchIcon = finished ? 'done' : waiting ? 'wait' : walking ? 'walk' : 'run';
  const watchLine = finished ? '完了' : waiting ? '待機' : walking ? '早歩き' : dec.kind === 'stopRec' ? '停止推奨' : dec.kind === 'adjust' || dec.kind === 'prep' ? `目標 ${targetText}` : 'ペース維持';

  const phoneTargetNote = walking && target != null ? `目安 ${targetText} BPM` : target == null ? '—' : `${targetText}`;

  return {
    tick: state.tick,
    t,
    status,
    speed,
    decisionKey: [state.mode, state.reason, state.gait ?? 'run', target == null ? 'x' : r0(target)].join('|'),
    unknown: dec.kind === 'unknown' ? { mode: state.mode, reason: state.reason } : null,
    signal: { color: signal.color, label: signal.label, remainingS: signal.remainingS, remainingText: `${remaining}秒`, text: signalText, cycleProgress: signal.cycleProgress },
    // 人物（位置は state.x そのまま）
    world: {
      x: state.x, goalX: route.goalX, crossingX: route.crossingX, crossingM: config.signal.crossingM,
      action, moving: !idle, bpm, bpmText, targetBpm: target, targetText,
      stateLabel, worldLabel, toCrossingM: Math.max(0, toCrossingM), distanceText, passed, speedKmh,
      speedText: speedKmh.toFixed(1), speedMps: speedKmh / 3.6, multiplier: speed,
      cycleS: footCycleS(action, speedKmh / 3.6, speed), // 足の 1 往復の秒数（地面の流れに合わせる）
    },
    // ① 状態入力
    inputs: [
      { key: 'distance', label: '横断地点まで', value: distanceText },
      { key: 'bpm', label: '現在BPM', value: `${bpmText}` , unit: '歩/分' },
      { key: 'stride', label: '歩幅', value: strideM.toFixed(2), unit: 'm/歩' },
      { key: 'signal', label: '信号', value: signalText },
    ],
    // ② 判定
    judge: {
      kind: dec.kind,
      activeStep: ['adjust', 'prep', 'walk', 'stopRec'].includes(dec.kind) ? 'decide' : 'match', // 解説で強調する段
      text: dec.judge,
      steps: [
        { key: 'predict', title: '到着を予測', body: '現在のペースで横断地点へ' },
        { key: 'match', title: '青の時間帯と照合', body: signalText },
        { key: 'decide', title: '目標を決定', body: target == null ? dec.judge : `目標 ${targetText} BPM／${dec.judge}` },
      ],
    },
    // ③ フィードバック（スマホと Watch は同じ target を参照する）
    target: { bpm: target, text: targetText, direction },
    phone: {
      bpmText, targetText: phoneTargetNote, headline: dec.phone, sub: dec.phoneSub, distanceText,
      kind: dec.kind, waiting, finished, stopRec: dec.kind === 'stopRec',
    },
    watch: {
      bpmText, line: watchLine, icon: watchIcon, ringMode, periodS: bpm > 0 ? 60 / bpm : null, targetText,
    },
  };
}

// ---------- 字幕（同じ時点の frame から作る。数値の手書きはしない） ----------
/** stage: 解説の段（world/input/judge/output）。null や return は「いまの行動」を短く出す */
export function subtitleFor(stage, frame) {
  const w = frame.world;
  const j = frame.judge;
  const t = frame.target;
  switch (stage) {
    case 'world':
      return `信号は${frame.signal.label}・残り${frame.signal.remainingText}／${w.passed ? '横断地点を通過' : `横断地点まで${w.distanceText}`}`;
    case 'input':
      return '距離・歩調・信号を判定へ';
    case 'judge':
      if (t.bpm != null && j.kind === 'walk') return `${j.text} → 目安${t.text}BPM`;
      if (t.bpm != null && (j.kind === 'adjust' || j.kind === 'prep')) return `${j.text} → 目標${t.text}BPMへ`;
      return j.text;
    case 'output':
      return t.bpm != null ? `スマホとWatchに同時に通知（${j.kind === 'walk' ? '目安' : '目標'}${t.text}BPM）` : 'スマホとWatchに同時に通知';
    default:
      switch (j.kind) {
        case 'adjust': return `テンポ調整中：${t.text}BPMへ`;
        case 'prep': return 'テンポ調整中：早歩きへの切替に向けて';
        case 'walk': return `早歩き：目安${t.text}BPM`;
        case 'wait': return '信号待ち：青になるまで待機';
        case 'stopRec': return '停止推奨：調整だけでは停止回避が難しい';
        case 'done': return 'ゴール';
        case 'passed': return '横断地点を通過／通常ペースへ';
        case 'normal': return `通常ペース：現在${w.bpmText}BPM`;
        default: return UNKNOWN;
      }
  }
}
