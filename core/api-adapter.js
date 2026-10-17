// バックエンドAPIの応答を core の config に変換する（DOM・通信に依存しない純粋関数）
// 形は バックエンド・API連携ガイド（10/17版） に合わせる:
//   GET /api/signals     → { "ステータス": "成功", "データ": [ { signalId, cycleS, greenS, yellowS, redS, phaseS, crossingM, note } ] }
//   POST /api/calibration ← { "歩幅": 0.85, "通常BPM": 160 }
//   POST /api/logs        ← { "シナリオ", "停止回数", "総所要時間" }
// GET /api/calibration の応答形はガイドに無いため、POST と同じ日本語キー（包みは「データ」も可）を想定。英語キー strideM/baseBpm も受け付ける。

export const SIGNAL_FIELDS = ['cycleS', 'greenS', 'yellowS', 'redS', 'phaseS', 'crossingM'];
export const RUNNER_FIELDS = ['strideM', 'baseBpm'];
// API の日本語キー → core のキー（ガイド記載）
const RUNNER_KEYS = { strideM: ['歩幅', 'strideM'], baseBpm: ['通常BPM', 'baseBpm'] };

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
    const signal = problems.length ? null : Object.fromEntries(SIGNAL_FIELDS.map((k) => [k, src[k]]));
    return { index, id: src?.signalId ?? null, note: src?.note ?? null, signal, problems };
  });
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
  return { runner: problems.length ? null : runner, problems };
}

// core の runner → POST /api/calibration の body
export const toCalibrationBody = ({ strideM, baseBpm }) => ({ '歩幅': strideM, '通常BPM': baseBpm });

// core の比較結果（summary）→ POST /api/logs の body
export const toLogBody = (scenario, summary) => ({ 'シナリオ': scenario, '停止回数': summary.stops, '総所要時間': summary.totalTimeS });
