// 設定フォーム ↔ core の config、入力検証（DOM 非依存）
// フォームの値はすべて文字列で持つ（空欄・"abc"・"Infinity" も入力として扱い、項目名つきのエラーにする）。
// 最後に core の validateConfig を必ず通す。例外は握りつぶさずメッセージにして返す（白画面にしない）。
import { core } from './core-ns.js';

const CROSSING_MODELS = Array.isArray(core.CROSSING_MODELS) ? core.CROSSING_MODELS : ['point', 'length']; // 新しい横断モデルが core に増えたら選択肢に自動で出る

/** kind: pos=0 より大きい / nonneg=0 以上 / any=有限の数なら何でも */
export const FIELDS = [
  { id: 'strideM', label: '歩幅', unit: 'm/歩', group: 'main', path: ['runner', 'strideM'], kind: 'pos', step: 0.01 },
  { id: 'baseBpm', label: '通常ケイデンス', unit: '歩/分', group: 'main', path: ['runner', 'baseBpm'], kind: 'pos', step: 1 },
  { id: 'crossingX', label: '横断地点までの距離', unit: 'm', group: 'main', path: ['route', 'crossingX'], kind: 'pos', step: 1, help: 'スタートから横断地点まで（route.crossingX）' },
  { id: 'goalX', label: 'ゴール距離', unit: 'm', group: 'main', path: ['route', 'goalX'], kind: 'pos', step: 1, help: 'スタートからゴールまで（route.goalX）' },
  { id: 'cycleS', label: '信号周期', unit: '秒', group: 'signal', path: ['signal', 'cycleS'], kind: 'pos', step: 1 },
  { id: 'greenS', label: '青', unit: '秒', group: 'signal', path: ['signal', 'greenS'], kind: 'nonneg', step: 1 },
  { id: 'yellowS', label: '青点滅', unit: '秒', group: 'signal', path: ['signal', 'yellowS'], kind: 'nonneg', step: 1, help: 'core の yellowS（歩行者信号の青点滅）' },
  { id: 'redS', label: '赤', unit: '秒', group: 'signal', path: ['signal', 'redS'], kind: 'nonneg', step: 1 },
  { id: 'phaseS', label: '位相 phaseS', unit: '秒', group: 'signal', path: ['signal', 'phaseS'], kind: 'any', step: 1, help: 't=0 で周期の何秒目か（負の値も可）' },
  { id: 'crossingModel', label: '横断モデル', unit: '', group: 'signal', path: ['control', 'crossingModel'], kind: 'select', options: CROSSING_MODELS },
  { id: 'crossingM', label: '横断幅', unit: 'm', group: 'signal', path: ['signal', 'crossingM'], kind: 'nonneg', step: 1, help: '横断歩道の長さ。length モデルのときだけ使う（API の crossingM もここ）' },
  { id: 'startMarginS', label: '青開始後の余裕', unit: '秒', group: 'advanced', path: ['control', 'startMarginS'], kind: 'nonneg', step: 1 },
  { id: 'endMarginS', label: '青終了前の余裕', unit: '秒', group: 'advanced', path: ['control', 'endMarginS'], kind: 'nonneg', step: 1 },
  { id: 'maxDeltaBpm', label: '調整上限（通常±）', unit: '歩/分', group: 'advanced', path: ['control', 'maxDeltaBpm'], kind: 'nonneg', step: 1 },
  { id: 'stepBpm', label: '1 回の変更量', unit: '歩/分', group: 'advanced', path: ['control', 'stepBpm'], kind: 'pos', step: 1 },
  { id: 'stepIntervalS', label: '変更周期', unit: '秒', group: 'advanced', path: ['control', 'stepIntervalS'], kind: 'pos', step: 0.1, help: '0.1 秒の倍数' },
  { id: 'targetIntervalS', label: '目標再計算周期', unit: '秒', group: 'advanced', path: ['control', 'targetIntervalS'], kind: 'pos', step: 0.1, help: '0.1 秒の倍数' },
  { id: 'horizonS', label: '先読み時間', unit: '秒', group: 'advanced', path: ['control', 'horizonS'], kind: 'pos', step: 10 },
];

export const FIELD_IDS = FIELDS.map((f) => f.id);

export const MODEL_HELP = {
  point: 'point: 横断地点に着いた時刻の信号色だけで判定します（青なら通過、青点滅・赤なら止まる）。横断幅は使いません。',
  length: 'length: 横断幅を渡り切れるだけの青が残っているときだけ進入します。横断中に信号が変わっても止まりません。',
};

const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** core の config → フォームの値（文字列）。control の省略値は core の既定値で補う */
export function configToForm(config) {
  const full = { ...config, control: { ...(core.DEFAULT_CONTROL || {}), ...(config.control || {}) } };
  const form = {};
  for (const f of FIELDS) form[f.id] = String(getPath(full, f.path));
  return form;
}

export function formsEqual(a, b) {
  return FIELD_IDS.every((id) => a[id] === b[id]);
}

function parseNumber(raw, field) {
  const text = String(raw ?? '').trim();
  const name = `${field.label}（${field.unit}）`;
  if (text === '') return { error: `${name}: 空欄です。数値を入力してください` };
  const v = Number(text);
  if (Number.isNaN(v)) return { error: `${name}: 数値として読めません（入力: "${text}"）` };
  if (!Number.isFinite(v)) return { error: `${name}: 有限の数ではありません（入力: "${text}"。Infinity は使えません）` };
  if (field.kind !== 'any' && v < 0) return { error: `${name}: 負の値は使えません（入力: ${text}）` };
  if (field.kind === 'pos' && v === 0) return { error: `${name}: 0 より大きい値にしてください` };
  return { value: v };
}

function setPath(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]] ??= {};
  o[path[path.length - 1]] = value;
}

/**
 * フォーム → config。
 * 戻り値 { config, errors }: errors は [{ field, message }]（field は項目 ID、core の検証メッセージは null）。
 * errors が 1 つでもあれば config は null。
 */
export function parseForm(form, base = null) {
  const errors = [];
  const values = {};
  for (const f of FIELDS) {
    if (f.kind === 'select') {
      if (!f.options.includes(form[f.id])) {
        errors.push({ field: f.id, message: `${f.label}: ${f.options.join(' / ')} のどちらかを選んでください` });
      } else {
        values[f.id] = form[f.id];
      }
      continue;
    }
    const r = parseNumber(form[f.id], f);
    if (r.error) errors.push({ field: f.id, message: r.error });
    else values[f.id] = r.value;
  }
  if (errors.length) return { config: null, errors };

  // 信号の合計（core のメッセージより具体的に出す）
  const sum = values.greenS + values.yellowS + values.redS;
  if (Math.abs(sum - values.cycleS) >= 1e-9) {
    errors.push({
      field: 'cycleS',
      message: `信号周期: 青(${values.greenS}) + 青点滅(${values.yellowS}) + 赤(${values.redS}) = ${round(sum)} 秒が、信号周期 ${values.cycleS} 秒と一致しません`,
    });
    return { config: null, errors };
  }

  // base（現在の config）があれば、フォームにない項目（core に増えた設定など）をそのまま引き継ぐ。enabled は 2 レーン側で決める
  const config = base ? cloneConfig(base) : { signal: {}, runner: {}, route: {}, control: {} };
  for (const k of ['signal', 'runner', 'route', 'control']) config[k] ??= {};
  for (const f of FIELDS) setPath(config, f.path, values[f.id]);

  try {
    if (typeof core.validateConfig !== 'function') throw new Error('core の validateConfig が見つかりません（core の契約が変わった可能性）');
    core.validateConfig(config);
  } catch (e) {
    errors.push({ field: null, message: `core の検証: ${e.message}` });
    return { config: null, errors };
  }
  return { config, errors: [] };
}

function cloneConfig(base) {
  const c = JSON.parse(JSON.stringify(base));
  if (c.control) delete c.control.enabled;
  return c;
}

/**
 * フォームで編集できない設定項目（core の既定値・シナリオにあるが FIELDS にないもの）を [パス, 値] で返す。
 * 画面に「そのまま保持される項目」として出す。
 */
export function extraConfigEntries(config) {
  const covered = new Set(FIELDS.map((f) => f.path.join('.')));
  const full = { ...config, control: { ...(core.DEFAULT_CONTROL || {}), ...(config?.control || {}) } };
  const out = [];
  for (const [group, obj] of Object.entries(full)) {
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) {
        const path = `${group}.${k}`;
        if (!covered.has(path) && path !== 'control.enabled') out.push([path, v]);
      }
    } else if (obj !== undefined) {
      out.push([group, obj]);
    }
  }
  return out;
}

const round = (v) => Math.round(v * 1e6) / 1e6;
