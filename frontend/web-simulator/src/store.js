// アプリ状態。確定した設定（plan / pb）と編集中の設定（draft・候補・許容距離など）を分けて持つ。
// 画面状態: editing / ready / playing / paused / completed / error
import { DEFAULT_API_BASE } from './api.js';
import { DEFAULT_DEMO_ID } from './scenarios.js';
import { FIXTURE_SIGNALS } from './fixtures.js';
import { DEFAULT_TOLERANCE_M } from './route-builder.js';

export function initialState() {
  return {
    // --- 編集中の設定 ---
    view: 'run',                     // setup | run
    rec: false,                      // 収録モード
    courseKind: 'demo',              // demo | map
    demoId: DEFAULT_DEMO_ID,
    editTool: null,                  // start | end | via | null
    draft: { start: null, end: null, via: [] },
    confirmed: false,                // 地図コースの経路確定済みか
    candidates: FIXTURE_SIGNALS,
    candidatesOrigin: 'fixture',     // fixture | api
    toleranceM: DEFAULT_TOLERANCE_M,
    manualExclude: new Set(),
    phaseS: null,                    // 位相の模擬条件編集（null = 元のまま）
    runnerOverride: null,            // API 校正値（適用したときだけ）
    api: { base: DEFAULT_API_BASE, message: '', at: null, ok: null, calib: null },
    // --- 確定した設定（recompute の結果）---
    route: null,
    routeErrors: [],
    match: null,                     // matchSignals の結果（地図コース）
    adopted: [],                     // 画面用の採用信号（デモでは模式信号 1 件）
    plan: { kind: 'none', reason: '' },
    expected: null,                  // core.compare（単信号のとき）
    factor: 1,                       // 計算上の距離 → 経路上の距離
    pb: null,                        // Playback
    // --- 画面 ---
    tileFailed: false,
    error: null,
    autoPaused: false,
    initialPhaseS: null,
    overlapShift: false,
  };
}

export function statusOf(S) {
  if (S.error) return 'error';
  if (!S.pb) return 'editing';
  return S.pb.status;                // ready | playing | paused | completed
}

export const STATUS_LABEL = { editing: '編集中', ready: '準備完了', playing: '再生中', paused: '一時停止', completed: '完了', error: 'エラー' };
