// バックエンドAPIの応答を core の config に変換する（DOM・通信に依存しない純粋関数）
// 形は バックエンド・API連携ガイド（10/17版） に合わせる:
//   GET /api/signals     → { "ステータス": "成功", "データ": [ { signalId, cycleS, greenS, yellowS, redS, phaseS, crossingM, note } ] }
//   POST /api/calibration ← { "歩幅": 0.85, "通常BPM": 160 }
//   POST /api/logs        ← { "シナリオ", "停止回数", "総所要時間" }
// GET /api/calibration の応答形はガイドに無いため、POST と同じ日本語キー（包みは「データ」も可）を想定。英語キー strideM/baseBpm も受け付ける。

import { phaseAtRunStart, PHASE_REFERENCES } from './signal-input.js';

export const SIGNAL_FIELDS = ['cycleS', 'greenS', 'yellowS', 'redS', 'phaseS', 'crossingM'];
// 信号の品質・位相の基準（API の項目名のまま信号に残す）。落とすと core が推定データと分からず加速していた
//（要件 v2 SAFE-03 が Web の1信号で効かなかった）。品質の項目が1つも無い信号は推定として扱う（欠損は加速しない側に倒す）
const QUALITY_FIELDS = ['isEstimated', 'phaseBasis', 'phaseReference'];
export const RUNNER_FIELDS = ['strideM', 'baseBpm'];
// API の日本語キー → core のキー（ガイド記載）
// NormalBPM：バックエンドは保存（POST）後にこの名前で返す（9e35713 時点）。保存前は 通常BPM
const RUNNER_KEYS = { strideM: ['歩幅', 'strideM'], baseBpm: ['通常BPM', 'NormalBPM', 'baseBpm'] };
// 任意項目（無ければ core の既定値を使う）。早歩きの歩幅
const OPTIONAL_RUNNER_KEYS = { walkStrideM: ['walkStrideM', '早歩き歩幅'] };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// 応答の包み（{ ステータス, データ }）を外す。ステータスが「成功」以外なら問題として返す
export function unwrap(json) {
  if (isObj(json) && 'データ' in json) {
    const problems = json['ステータス'] !== undefined && json['ステータス'] !== '成功' ? [`ステータスが「${json['ステータス']}」`] : [];
    return { data: json['データ'], problems };
  }
  return { data: json, problems: [] };
}

// 信号データの各要素が F-02 の形かどうかを調べる
// 戻り値: [{ index, id, note, signal | null, problems: [...] }]
export function extractSignals(json) {
  const { data, problems: top } = unwrap(json);
  const list = Array.isArray(data) ? data
    : Array.isArray(data?.signals) ? data.signals
    : isObj(data) ? [data]
    : [];
  if (list.length === 0) return [{ index: -1, id: null, note: null, signal: null, problems: [...top, '信号データが空、または読めない形'] }];
  return list.map((src, index) => {
    const problems = [...top];
    for (const k of SIGNAL_FIELDS) {
      if (!(k in (src || {}))) problems.push(`${k} がない`);
      else if (!isNum(src[k])) problems.push(`${k} が数値でない（${JSON.stringify(src[k])}）`);
    }
    if (problems.length === 0 && Math.abs(src.greenS + src.yellowS + src.redS - src.cycleS) > 1e-9) {
      problems.push(`greenS+yellowS+redS（${src.greenS + src.yellowS + src.redS}）が cycleS（${src.cycleS}）と一致しない`);
    }
    if (problems.length === 0 && src.phaseReference !== undefined && !PHASE_REFERENCES.includes(src.phaseReference)) {
      problems.push(`phaseReference が不明（${JSON.stringify(src.phaseReference)}。${PHASE_REFERENCES.join(' / ')}）`);
    }
    let signal = problems.length ? null : Object.fromEntries(SIGNAL_FIELDS.map((k) => [k, src[k]]));
    if (signal) {
      for (const k of QUALITY_FIELDS) if (src[k] !== undefined && src[k] !== null) signal[k] = src[k];
      if (signal.isEstimated === undefined && signal.phaseBasis === undefined) signal.isEstimated = true;
    }
    // 座標（API と同じ名前 lat / lon）。数値でなければ null。信号の判定には使わない（地図の表示用）
    const coord = (v) => (isNum(v) ? v : null);
    return { index, id: src?.signalId ?? null, note: src?.note ?? null, lat: coord(src?.lat), lon: coord(src?.lon), signal, problems };
  });
}

// API の phaseS を core の phaseS（走行開始 t=0 の時点で周期の何秒目か）に換算する（Web の phase.js がこの名前を探す）。
// signal.phaseReference が無ければ 'run-start'（そのまま）、'unix-epoch' なら runStartUnixS を足して mod cycleS。不明なら RangeError
export function toCorePhaseS(signal, runStartUnixS) {
  return phaseAtRunStart({ phaseS: signal?.phaseS, cycleS: signal?.cycleS, phaseReference: signal?.phaseReference ?? 'run-start' }, runStartUnixS);
}

// キャリブレーション応答から runner を取り出す
export function extractRunner(json) {
  const { data, problems } = unwrap(json);
  const src = isObj(data?.calibration) ? data.calibration : data;
  const runner = {};
  for (const [key, names] of Object.entries(RUNNER_KEYS)) {
    const name = names.find((n) => isObj(src) && n in src);
    if (!name) problems.push(`${names[0]} がない`);
    else if (!isNum(src[name]) || src[name] <= 0) problems.push(`${name} が正の数値でない（${JSON.stringify(src[name])}）`);
    else runner[key] = src[name];
  }
  for (const [key, names] of Object.entries(OPTIONAL_RUNNER_KEYS)) {
    const name = names.find((n) => isObj(src) && n in src);
    if (!name) continue;
    if (!isNum(src[name]) || src[name] <= 0) problems.push(`${name} が正の数値でない（${JSON.stringify(src[name])}）`);
    else runner[key] = src[name];
  }
  return { runner: problems.length ? null : runner, problems };
}

// core の runner → POST /api/calibration の body
export const toCalibrationBody = ({ strideM, baseBpm }) => ({ '歩幅': strideM, '通常BPM': baseBpm });

// core の比較結果（summary）→ POST /api/logs の body
// 停止時間と早歩きの記録は、要約にあるときだけ送る（バックエンドは walkCount・walkTimeS・walkDistanceM を検証して受け取る。改善ループ c09m）
export const toLogBody = (scenario, summary) => ({
  'シナリオ': scenario, '停止回数': summary.stops, '総所要時間': summary.totalTimeS,
  ...(summary.stopTimeS !== undefined ? { '停止時間': summary.stopTimeS } : {}),
  ...(summary.walkCount !== undefined ? { walkCount: summary.walkCount, walkTimeS: summary.walkTimeS, walkDistanceM: summary.walkDistanceM } : {}),
});
