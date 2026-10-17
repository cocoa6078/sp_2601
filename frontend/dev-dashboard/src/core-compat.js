// core の変更に強くするための純粋関数群（DOM 非依存・core を直接 import しない）
// - buildScenarios: core/scenarios.js の SCENARIOS / DEMO の全キーからシナリオ一覧を作る
// - checkCoreContract: ダッシュボードが使う export・state/summary の項目がそろっているかを確認する
// - describeExports / stateRows / extraSummaryRows: core に増えたものを自動で表示に出すための整形

// ---------- 既知の名前（ダッシュボードが専用の扱いを持つもの） ----------
/** 機能ごとに「無いと動かない」export */
export const REQUIRED_EXPORTS = {
  sim: ['createRun', 'step', 'summarize', 'compare', 'signalAt'],
  form: ['validateConfig'],
  preview: ['speedOf'],
  api: ['validateSignal', 'validateConfig'],
};
/** 無くても動く（既定値・簡易表示になる）export */
export const OPTIONAL_EXPORTS = ['DT', 'CORE_VERSION', 'MODE_LABELS', 'CROSSING_MODELS', 'DEFAULT_CONTROL'];
export const REQUIRED_ADAPTER_EXPORTS = ['extractSignals', 'extractRunner', 'unwrap'];
/** ダッシュボードが使っている core の export（一覧で「使用中」にする） */
export const USED_CORE_EXPORTS = [...new Set([...Object.values(REQUIRED_EXPORTS).flat(), ...OPTIONAL_EXPORTS])];
/** v0.2.0 時点で存在するが、ダッシュボードは使っていない export（新規ではない未使用） */
export const KNOWN_UNUSED_CORE_EXPORTS = ['calibrate', 'canEnter', 'chooseTarget', 'limitRate', 'requiredBpm', 'safeGreenWindows', 'simulate', 'MODES', 'COLOR_LABELS'];

/** createRun / step の state に必要な項目 */
export const REQUIRED_STATE_KEYS = ['tick', 't', 'x', 'bpm', 'targetBpm', 'mode', 'phase', 'stops', 'stopTimeS', 'stoppedAtT', 'finished', 'finishTimeS'];
/** ダッシュボードが意味を知っている state の項目（これ以外は「新しい項目」） */
export const KNOWN_STATE_KEYS = [...REQUIRED_STATE_KEYS, 'signal', 'minBpm', 'maxBpm', 'totalBpmChange', 'history'];
/** summarize の結果に必要な項目 */
export const REQUIRED_SUMMARY_KEYS = ['finished', 'stops', 'stopTimeS', 'totalTimeS'];
/** ダッシュボードが意味を知っている summary の項目（これ以外は「その他の集計」） */
export const KNOWN_SUMMARY_KEYS = ['enabled', 'crossingModel', 'finished', 'termination', 'stops', 'stopTimeS', 'totalTimeS', 'minBpm', 'maxBpm', 'totalBpmChange', 'baseBpm'];

// 契約チェックで createRun / step を試すときの最小の config（シナリオが取れなかったときだけ使う）
const PROBE_CONFIG = {
  signal: { cycleS: 120, greenS: 50, yellowS: 5, redS: 65, phaseS: 100, crossingM: 20 },
  runner: { strideM: 0.8, baseBpm: 150 },
  route: { crossingX: 400, goalX: 600 },
  control: { crossingModel: 'point' },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (ns, name) => ns != null && ns[name] !== undefined;

// ---------- シナリオの自動生成 ----------
const EXPECT_NOTES = {
  A: '減速して停止を回避するケース（停止はなくなるが所要時間は長くなる）',
  B: '加速して停止を回避し、通常走行より早くゴールするケース',
  'B-length': '横断幅も考慮すると回避できないケース（RUNWAVE でも止まる）',
  'DEMO.sub': '減速して停止を回避するケース（core の DEMO.sub）',
};
export const UNKNOWN_SCENARIO_NOTE = 'core/scenarios.js で追加されたシナリオ';

const looksLikeConfig = (c) => isObj(c) && isObj(c.signal) && isObj(c.runner) && isObj(c.route);

function withModelSafe(withModel, config, model) {
  if (typeof withModel === 'function') {
    try {
      const r = withModel(config, model);
      if (looksLikeConfig(r)) return r;
    } catch { /* 下の手作りにフォールバック */ }
  }
  return { ...config, control: { ...(config.control || {}), crossingModel: model } };
}

function scenarioTitle(id, config) {
  const model = config.control?.crossingModel ?? 'point';
  const len = model === 'length' ? `・横断${config.signal.crossingM ?? '?'}m` : '';
  return `${id}（phaseS=${config.signal.phaseS ?? '?'}・${model}${len}）`;
}

/**
 * SCENARIOS / DEMO の全キーからシナリオ一覧を作る（純粋関数）。
 * 引数: { SCENARIOS, DEMO, withModel, validate }（validate は core の validateConfig。無ければ検査しない）
 * 戻り値: { scenarios: [{ id, title, config, expectNote, known }], problems: [文字列] }（例外は投げない）
 */
export function buildScenarios({ SCENARIOS, DEMO, withModel, validate } = {}) {
  const scenarios = [];
  const problems = [];
  const seen = new Set(); // 同一オブジェクトの重複除去用（DEMO.main === SCENARIOS.B など）

  const add = (id, raw, { fromDemo = false } = {}) => {
    if (!looksLikeConfig(raw)) {
      problems.push(`${fromDemo ? id : `SCENARIOS.${id}`}: config の形が不正（signal / runner / route が必要）`);
      return null;
    }
    if (seen.has(raw)) return null;
    // 横断モデルは config の指定を尊重。指定なしは point
    const config = raw.control?.crossingModel ? raw : withModelSafe(withModel, raw, 'point');
    if (typeof validate === 'function') {
      try {
        validate(config);
      } catch (e) {
        problems.push(`${id}: core の検証に通らないため除外（${e.message}）`);
        return null;
      }
    }
    seen.add(raw);
    const known = Object.hasOwn(EXPECT_NOTES, id);
    const sc = { id, title: scenarioTitle(id, config), config, expectNote: known ? EXPECT_NOTES[id] : UNKNOWN_SCENARIO_NOTE, known };
    scenarios.push(sc);
    return sc;
  };

  if (!isObj(SCENARIOS)) {
    problems.push('core/scenarios.js の SCENARIOS が見つからない、またはオブジェクトではない');
  } else {
    for (const key of Object.keys(SCENARIOS)) {
      const sc = add(key, SCENARIOS[key]);
      // 回避不可のデモ: B の length 版（B が存在し、B 自体が length でないときだけ）
      if (sc && key === 'B' && sc.config.control?.crossingModel !== 'length') {
        const lengthConfig = withModelSafe(withModel, sc.config, 'length');
        if (typeof validate !== 'function' || tryValidate(validate, lengthConfig)) {
          scenarios.push({ id: 'B-length', title: scenarioTitle('B-length', lengthConfig), config: lengthConfig, expectNote: EXPECT_NOTES['B-length'], known: true });
        }
      }
    }
  }
  if (DEMO === undefined) {
    // DEMO は任意。無ければ何も足さない
  } else if (!isObj(DEMO)) {
    problems.push('core/scenarios.js の DEMO がオブジェクトではない');
  } else {
    for (const key of Object.keys(DEMO)) add(`DEMO.${key}`, DEMO[key], { fromDemo: true });
  }
  return { scenarios, problems };
}

function tryValidate(validate, config) {
  try {
    validate(config);
    return true;
  } catch {
    return false;
  }
}

/** 既定で開くシナリオ: B があれば B、なければ先頭 */
export function defaultScenarioId(scenarios) {
  return scenarios.find((s) => s.id === 'B')?.id ?? scenarios[0]?.id ?? null;
}

// ---------- 契約チェック ----------
/**
 * core の名前空間が、ダッシュボードの前提を満たしているか確認する（純粋関数・例外を投げない）。
 * extra: { adapter, scenarios, probeConfig }（api-adapter / scenarios の名前空間。省略可）
 * 戻り値: { ok, features:{sim,form,preview,api,scenarios}, missing:[…], warnings:[…], problems:[…] }
 *   missing … 画面の赤い帯に出す「不足」（export 名、state.xxx、summary.xxx など）
 *   warnings … 無くても動くが表示が簡易になるもの
 */
export function checkCoreContract(ns, extra = {}) {
  const missing = [];
  const warnings = [];
  const problems = [];
  const features = { sim: true, form: true, preview: true, api: true, scenarios: true };
  const off = (feature, why) => {
    features[feature] = false;
    missing.push(why);
  };

  if (ns == null || typeof ns !== 'object') {
    for (const f of Object.keys(features)) features[f] = false;
    return { ok: false, features, missing: ['core の名前空間'], warnings, problems: ['core/runwave-core.js を読み込めていません'] };
  }

  const isFn = (name) => typeof ns[name] === 'function';
  for (const [feature, names] of Object.entries(REQUIRED_EXPORTS)) {
    for (const name of names) {
      if (!isFn(name)) off(feature, `${name}（関数）`);
    }
  }
  for (const name of OPTIONAL_EXPORTS) {
    if (!has(ns, name)) warnings.push(`${name} が見つからない（既定の表示になります）`);
  }
  if (has(ns, 'DT') && ns.DT !== 0.1) {
    off('sim', `DT（0.1 秒前提が変わった: ${ns.DT}）`);
  }

  // adapter / scenarios
  const adapter = extra.adapter;
  if (adapter !== undefined) {
    for (const name of REQUIRED_ADAPTER_EXPORTS) if (typeof adapter?.[name] !== 'function') off('api', `api-adapter の ${name}`);
  }
  if (extra.scenarios !== undefined && !isObj(extra.scenarios?.SCENARIOS)) off('scenarios', 'scenarios.js の SCENARIOS');

  // state / summary の項目（実際に createRun / step / summarize を 1 回ずつ試す）
  if (features.sim) {
    const probe = extra.probeConfig ?? PROBE_CONFIG;
    try {
      const s0 = ns.createRun(probe);
      const miss0 = REQUIRED_STATE_KEYS.filter((k) => !isObj(s0) || !(k in s0));
      if (miss0.length) {
        features.sim = false;
        missing.push(...miss0.map((k) => `state.${k}`));
      } else {
        const s1 = ns.step(s0, probe);
        const miss1 = REQUIRED_STATE_KEYS.filter((k) => !isObj(s1) || !(k in s1));
        if (miss1.length) {
          features.sim = false;
          missing.push(...miss1.map((k) => `step の結果の state.${k}`));
        }
        const sum = ns.summarize(s1, probe);
        const missS = REQUIRED_SUMMARY_KEYS.filter((k) => !isObj(sum) || !(k in sum));
        if (missS.length) {
          features.sim = false;
          missing.push(...missS.map((k) => `summary.${k}`));
        }
      }
    } catch (e) {
      features.sim = false;
      problems.push(`createRun / step / summarize の試行で例外: ${e.message}`);
      missing.push('createRun / step / summarize が試行設定で動かない');
    }
  }

  const ok = missing.length === 0 && problems.length === 0;
  return { ok, features, missing, warnings, problems };
}

// ---------- 自動表示用の整形 ----------
/** ns の全 export を使用中／未使用に分ける。関数は引数の数（fn.length）つき */
export function describeExports(ns, used = USED_CORE_EXPORTS, knownUnused = KNOWN_UNUSED_CORE_EXPORTS) {
  if (ns == null) return { used: [], unused: [] };
  const rows = Object.keys(ns).sort().map((name) => {
    const v = ns[name];
    const kind = typeof v === 'function' ? 'function' : Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    return {
      name,
      kind,
      arity: typeof v === 'function' ? v.length : null,
      used: used.includes(name),
      possiblyNew: !used.includes(name) && !knownUnused.includes(name),
    };
  });
  return { used: rows.filter((r) => r.used), unused: rows.filter((r) => !r.used) };
}

/** 既知の項目に含まれないキー（history などの除外指定つき） */
export function unknownKeys(obj, known, ignore = []) {
  if (!isObj(obj)) return [];
  return Object.keys(obj).filter((k) => !known.includes(k) && !ignore.includes(k));
}

/** 値を 1 行の文字列にする（オブジェクトは JSON 1 行。長すぎるものは省略） */
export function formatValue(v, maxLen = 120) {
  if (v === undefined) return '（なし）';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'object') {
    let s;
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  }
  return String(v);
}

/** core state の全項目（history 除く）の表の行。両レーンのキーの和集合 */
export function stateRows(normal, runwave, { known = KNOWN_STATE_KEYS, ignore = ['history'] } = {}) {
  const keys = [];
  for (const o of [normal, runwave]) for (const k of Object.keys(o || {})) if (!keys.includes(k) && !ignore.includes(k)) keys.push(k);
  return keys.map((key) => ({
    key,
    known: known.includes(key),
    normal: formatValue(normal?.[key]),
    runwave: formatValue(runwave?.[key]),
  }));
}

/** summary のうち、ダッシュボードが意味を知らない集計（「その他の集計」） */
export function extraSummaryRows(summary) {
  if (!summary) return [];
  const keys = [...new Set([...unknownKeys(summary.normal, KNOWN_SUMMARY_KEYS), ...unknownKeys(summary.runwave, KNOWN_SUMMARY_KEYS)])];
  return keys.map((key) => ({ key, normal: formatValue(summary.normal?.[key]), runwave: formatValue(summary.runwave?.[key]) }));
}
