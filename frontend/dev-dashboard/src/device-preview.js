// P1: 端末風プレビューの表示モデル（DOM 非依存の純粋関数）
// - 表示元は比較シミュレーターの core state（laneView の結果）。別のタイマーも別の計算も持たない
// - 模擬センサー値（速度・実測ケイデンス・心拍）は「表示確認だけ」。core には渡さず、制御にも使わない
//   （CONTRACT-ext.md は設計のみで未実装。心拍の閾値や自動減速は作らない）
// - 未計測・欠測は null（0 にしない）。停止中・速度不明のペースは「算出不能」
import { speedOf } from '../../../core/runwave-core.js';

export const SENSOR_FIELDS = [
  { id: 'speedMps', label: '速度', unit: 'm/s' },
  { id: 'cadenceSpm', label: '実測ケイデンス', unit: '歩/分' },
  { id: 'heartRateBpm', label: '心拍', unit: '拍/分' },
];

export const UNMEASURED = '未計測';
export const MISSING = '欠測';
export const UNAVAILABLE = '算出不能';

/**
 * 入力欄 1 つ分を解釈する。
 * 戻り値 { state, value, message }: state は 'value'（数値あり）/ 'missing'（欠測チェック）/ 'unmeasured'（空欄）/ 'invalid'（読めない・負）
 * value は state==='value' のときだけ数値、それ以外は null（0 にしない）
 */
export function parseSensorInput({ text = '', missing = false } = {}) {
  if (missing) return { state: 'missing', value: null, message: null };
  const t = String(text ?? '').trim();
  if (t === '') return { state: 'unmeasured', value: null, message: null };
  const v = Number(t);
  if (!Number.isFinite(v)) return { state: 'invalid', value: null, message: `数値として読めません（入力: "${t}"）` };
  if (v < 0) return { state: 'invalid', value: null, message: `負の値は使えません（入力: ${t}）` };
  return { state: 'value', value: v, message: null };
}

/** 秒/km → "分:秒/km"（四捨五入で 60 秒にならないよう、秒の合計で丸めてから分に分ける） */
export function formatPace(secPerKm) {
  const total = Math.round(secPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}/km`;
}

/** ペース = 1000 / 速度(m/s)。速度が 0・負・未計測・非数なら算出不能 */
export function paceFromSpeed(speedMps) {
  if (typeof speedMps !== 'number' || !Number.isFinite(speedMps) || speedMps <= 0) {
    return { available: false, secPerKm: null, text: UNAVAILABLE };
  }
  const secPerKm = 1000 / speedMps;
  return { available: true, secPerKm, text: formatPace(secPerKm) };
}

/** 表示用の文字列（未計測・欠測は 0 ではなく文言） */
export function sensorText(parsed, unit, digits = 1) {
  if (parsed.state === 'value') return `${Number(parsed.value.toFixed(digits))} ${unit}`;
  if (parsed.state === 'missing') return MISSING;
  if (parsed.state === 'invalid') return `${UNMEASURED}（入力エラー）`;
  return UNMEASURED;
}

/**
 * core の推定速度 m/s = speedOf(strideM, bpm)。待機中・ゴール後は 0（bpm が 0 でなくても 0 にする）
 * view は sim-engine.laneView の結果
 */
export function coreSpeedMps(view, config) {
  if (view.waiting || view.finished) return 0;
  return speedOf(config.runner.strideM, view.bpm);
}

/**
 * プレビューの表示モデル。入力:
 *   view    … laneView(state, config, tick)（core state から作った 1 レーン分の値）
 *   config  … そのレーンの config
 *   sensors … { speedMps:{text,missing}, cadenceSpm:{...}, heartRateBpm:{...} }（模擬入力）
 * 3 種類を分けて返す: target（目標値）／core（core の推定値）／measured（模擬実測値）
 */
export function buildPreviewModel({ view, config, sensors = {} }) {
  const speedMps = coreSpeedMps(view, config);
  const parsed = Object.fromEntries(SENSOR_FIELDS.map((f) => [f.id, parseSensorInput(sensors[f.id] ?? {})]));
  return {
    target: {
      bpm: view.targetBpm,
      mode: view.mode,
      waiting: view.waiting,
      finished: view.finished,
      signal: { color: view.signal.color, label: view.signal.label, remainingS: view.signal.remainingS },
    },
    core: {
      bpm: view.bpm, // 待機中は core が 0 を返す
      speedMps,
      pace: paceFromSpeed(speedMps),
    },
    measured: {
      simulated: true,
      speed: parsed.speedMps,
      cadence: parsed.cadenceSpm,
      heartRate: parsed.heartRateBpm,
      pace: paceFromSpeed(parsed.speedMps.value), // 未計測・0 は算出不能
    },
  };
}
