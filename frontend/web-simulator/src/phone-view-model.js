// iPhone 画面パネルに出す値を、RUNWAVE レーンの「同じ tick の core state」から作る（DOM・Leaflet 非依存）。
// 信号の判断・到着予測・目標 BPM の選択はここで作り直さない。core の state（mode / reason / gait / targetBpm / signalIndex）を読み、
// 文言に言い換えるだけ。文言は frontend/presentation-simulator/src/demo-view-model.js の describeDecision と同じ表を写している
// （vite の fs.allow と、あちらのモジュールが読み込む core-ns / simulation への依存を避けるため、import せず写した。文言を変えるときは両方を直す）。
//
// 画面の元になった実機アプリ（frontend/watch-app/Runwave/・読み取りのみ）:
//   ContentView.swift（走行中の画面: 目標ケイデンス「歩/分」・現在ケイデンス・案内カード・地図・信号カード・経過時間）
//   WorkoutRouteTracker.swift の WorkoutRouteMap（予定経路を水色、現在地、ゴール、信号の色つき印）
//   SimulatorSignalSystem.swift の SimulatorSignalCard（色・切替まで N 秒・「約 N m 先」・信号の名前）
//   RouteNavigation.swift の NavigationInstructionCard（案内文・「ゴールまで経路に沿って」）
import { core } from './core-ns.js';
import { runnerView } from './engine-adapter.js';

export const UNKNOWN = '状態を確認';
export const PHONE_DISCLAIMER = 'iPhone アプリの画面イメージ・ブラウザ内の模擬表示（本物の端末ではありません）';
export const SIGNAL_LABEL = { green: '青', flashing: '青点滅', red: '赤' };

const ceilS = (v) => Math.max(0, Math.ceil(v - 1e-9));
const r0 = (v) => Math.round(v);

/** 判定の短文と端末向けの行動。presentation-simulator の describeDecision と同じ表（core の mode / reason / gait の言い換え） */
export function describeDecision({ mode, reason, gait }, { direction }) {
  if (mode === 'finished') return { kind: 'done', phone: '完了', phoneSub: 'ゴール' };
  if (mode === 'waiting') return { kind: 'wait', phone: '信号待ち', phoneSub: '青になるまで待機' };
  if (mode === 'stopRecommended') return { kind: 'stopRec', phone: '停止推奨', phoneSub: '調整だけでは停止回避が難しい' };
  if (reason === 'passed') return { kind: 'passed', phone: '通常ペースへ', phoneSub: '横断地点を通過' };
  if (mode === 'walking') return { kind: 'walk', phone: '早歩き', phoneSub: '早歩きでつなぐ' };
  if (mode === 'adjusting' && reason === 'walkBridge') return { kind: 'prep', phone: 'ペース調整中', phoneSub: '早歩きへの切替に向けて' };
  if (mode === 'adjusting' && reason === 'signal') {
    const phoneSub = direction === 'up' ? '青に合わせて少しペースを上げる' : direction === 'down' ? '青に合わせて少しペースを下げる' : '今のペースで';
    return { kind: 'adjust', phone: 'ペース調整中', phoneSub };
  }
  if (mode === 'normal' && reason === 'noMargin') return { kind: 'normal', phone: '今のペースで', phoneSub: '通常ペースを維持' };
  if (mode === 'normal' && (reason === 'none' || reason === 'off')) return { kind: 'normal', phone: '今のペースで', phoneSub: '通常ペースを維持' };
  // core の reason 'uncertain'（推定の信号データなので加速は提案しない。要件 v2 SAFE-03）。presentation-simulator の表には無いのでこちらで補う
  if (mode === 'normal' && reason === 'uncertain') return { kind: 'normal', phone: '今のペースで', phoneSub: '通常ペースを維持（推定の信号のため加速は提案しません）' };
  return { kind: 'unknown', phone: UNKNOWN, phoneSub: `${mode} / ${reason}` };
}

/** 案内カードの記号（実機の instructionSymbol に相当する簡易版） */
const ICON = { done: '◎', wait: '■', stopRec: '!', walk: '»', prep: '↻', adjust: '↕', passed: '→', normal: '→', unknown: '?' };

/** mm:ss（経過時間） */
export const formatElapsed = (t) => {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * @param {object} p
 * @param {{state:object,cfg:object}} p.lane  RUNWAVE レーン（pair.runwave）
 * @param {number} p.t        共通時計の模擬時刻（s）。地図と同じ値を渡す
 * @param {object[]} p.adopted 採用信号（S.adopted。signalId / key / lat / lng / projPoint）
 * @param {number} [p.factor]  計算上の距離 → 経路上の距離（既定 1）
 */
export function buildPhoneFrame({ lane, t, adopted, factor = 1 }) {
  const { state, cfg } = lane;
  const v = runnerView(lane, t);
  const idle = v.waiting || v.finished;
  const baseBpm = cfg.runner.baseBpm;
  const target = idle ? null : state.targetBpm;
  const direction = target == null ? 'same' : target > baseBpm + 1e-9 ? 'up' : target < baseBpm - 1e-9 ? 'down' : 'same';
  const dec = describeDecision(state, { direction });

  const n = v.signalCount;
  const idx = Math.min(v.signalIndex, n - 1);            // 参照している信号（通過ごとに次へ進む）
  const allPassed = v.distToSignalM === null;            // 最後の信号まで通過済み
  const info = adopted[idx] ?? null;
  const remaining = ceilS(v.signal.remainingS);
  const signals = cfg.signals ? cfg.signals : [{ id: adopted[0]?.key, signal: cfg.signal }];
  const colors = {};
  for (const g of signals) colors[g.id] = core.signalAt(g.signal, t).color;

  const walking = v.walking && !idle;
  const targetText = target == null ? '—' : String(r0(target));
  return {
    t,
    kind: dec.kind,
    // 目標ケイデンスと現在ケイデンス（歩/分）
    targetBpm: target,
    targetText,
    targetNote: walking && target != null ? `目安 ${targetText} 歩/分` : null,
    currentText: String(r0(v.bpm)),
    // 案内カード
    icon: ICON[dec.kind] ?? ICON.unknown,
    headline: dec.phone,
    sub: dec.phoneSub,
    toSignalText: allPassed ? '信号は通過済み' : `約${r0(v.distToSignalM * factor)} m先`,
    goalRemainText: `ゴールまで経路に沿って ${v.finished ? '0 m' : `${r0(Math.max(0, v.goalX - v.x) * factor)} m`}`,
    // 信号カード
    signal: {
      index: idx,
      number: idx + 1,
      count: n,
      id: info?.signalId ?? null,
      title: `信号 ${idx + 1} / ${n}${info?.signalId ? `（${info.signalId}）` : ''}`,
      color: v.signal.color,
      label: SIGNAL_LABEL[v.signal.color] ?? v.signal.label,
      remainingS: remaining,
      switchText: `切替まで ${remaining}秒`,
      allPassed,
      colors,                                             // key → 色（地図の信号の印用）
    },
    // 状態・経過時間
    stateText: v.finished ? '完了' : v.waiting ? '信号待ち' : '走行中',
    elapsedText: formatElapsed(t),
    x: v.x,
  };
}
