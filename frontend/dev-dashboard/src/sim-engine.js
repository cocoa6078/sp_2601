// 比較シミュレーターの計算部分（DOM 非依存。Node のテストと Vite の両方から同じファイルを使う）
// 計算は core の createRun / step / summarize / compare をそのまま呼ぶだけ。独自のアルゴリズムは持たない。
// 描画（requestAnimationFrame）と計算（tick）は分離する: 表示速度は「何 tick 進めるか」だけを変え、dt は常に 0.1 秒。
import { core, scenariosNs } from './core-ns.js';
import { buildScenarios, defaultScenarioId } from './core-compat.js';

export const TPS = 10; // 1 秒あたりの tick 数（core の DT=0.1 と対応）
export const MAX_TIME_S = 1800; // core.simulate / compare の既定 maxTimeS と同じ
export const MAX_TICKS = Math.ceil(MAX_TIME_S * TPS);
export const SPEEDS = [1, 2, 5];
export const TOLERANCE = 1e-6; // 小数の照合許容（core は round6 で丸めている）

// ---------- シナリオ（core/scenarios.js の SCENARIOS / DEMO の全キーから自動生成。期待値は core.compare で出す） ----------
function safeBuild() {
  try {
    return buildScenarios({
      SCENARIOS: scenariosNs.SCENARIOS,
      DEMO: scenariosNs.DEMO,
      withModel: scenariosNs.withModel,
      validate: core.validateConfig,
    });
  } catch (e) {
    return { scenarios: [], problems: [`シナリオの生成中に例外: ${e.message}`] };
  }
}
export const SCENARIO_BUILD = safeBuild();
export const FIXED_SCENARIOS = SCENARIO_BUILD.scenarios;
export const SCENARIO_PROBLEMS = SCENARIO_BUILD.problems;
export const DEFAULT_SCENARIO_ID = defaultScenarioId(FIXED_SCENARIOS);

export function getFixedScenario(id) {
  return FIXED_SCENARIOS.find((s) => s.id === id) ?? null;
}

/** モード名: core の MODE_LABELS にあればそれを、無ければ生のモード値をそのまま表示する */
export const modeLabel = (mode) => core.MODE_LABELS?.[mode] ?? String(mode);

const expectedCache = new Map();
/** 固定シナリオの期待値（core.compare の結果）。初回だけ計算してキャッシュする */
export function expectedFor(id) {
  const sc = getFixedScenario(id);
  if (!sc) throw new RangeError(`未知のシナリオ ID: ${id}`);
  if (!expectedCache.has(id)) expectedCache.set(id, core.compare(sc.config));
  return expectedCache.get(id);
}

// ---------- 比較ペア ----------
/** 2 つの config の差は control.enabled だけ（core.compare と同じ作り方） */
export function pairConfigs(config) {
  const withEnabled = (enabled) => ({ ...config, control: { ...(config.control || {}), enabled } });
  return { normal: withEnabled(false), runwave: withEnabled(true) };
}

/** 比較ペアを作る。config が不正なら createRun が RangeError を投げる（呼び出し側で表示する） */
export function createPair(config) {
  const configs = pairConfigs(config);
  return {
    config,
    configs,
    normal: core.createRun(configs.normal),
    runwave: core.createRun(configs.runwave),
    tick: 0, // 両レーン共通の時計
  };
}

export const pairTimeS = (pair) => pair.tick / TPS;

/** 両レーンがゴール済み、または maxTimeS に到達 */
export function isPairDone(pair) {
  return (pair.normal.finished && pair.runwave.finished) || pair.tick >= MAX_TICKS;
}

/** 共通の 1 tick（0.1 秒）を進める。ゴール済みのレーンは core が同じ state を返すので固定される */
export function stepPair(pair) {
  if (isPairDone(pair)) return pair;
  return {
    ...pair,
    normal: core.step(pair.normal, pair.configs.normal),
    runwave: core.step(pair.runwave, pair.configs.runwave),
    tick: pair.tick + 1,
  };
}

/** n tick 進める（両方ゴールか maxTimeS で止まる） */
export function advance(pair, n) {
  let p = pair;
  for (let i = 0; i < n && !isPairDone(p); i++) p = stepPair(p);
  return p;
}

/**
 * requestAnimationFrame 1 回ぶんで進める tick 数を決める（純粋関数）。
 * 実時間 1 秒 = 10 tick（等倍）。speed は 1/2/5 倍。端数は carry に持ち越す。
 * 長く止まった後（タブ非表示など）に一気に進まないよう、1 フレームの実時間は maxElapsedMs で頭打ちにする。
 * 上限を 1 秒にしているのは、ブラウザが描画を 1 秒に 1 回程度へ絞ったとき（省電力・裏のウィンドウなど）でも
 * 表示速度どおりに進めるため（250ms にすると 5 倍速が約 1.3 倍まで落ちることを実際の Chrome で確認）。
 */
export function planTicks({ carry = 0, elapsedMs, speed, maxElapsedMs = 1000 }) {
  if (!SPEEDS.includes(speed)) throw new RangeError(`表示速度は ${SPEEDS.join(' / ')} 倍のいずれか`);
  const ms = Math.min(Math.max(0, elapsedMs), maxElapsedMs);
  const total = carry + (ms / 1000) * TPS * speed;
  const n = Math.floor(total + 1e-9);
  return { n, carry: Math.max(0, total - n) };
}

// ---------- 表示用の値 ----------
const round6 = (v) => Math.round(v * 1e6) / 1e6;

/** 停止時間（待機中の経過も含む）。core v0.2.0 の stopTimeS は終了した待機の合計なので、待機中は t − stoppedAtT を足す */
export function displayStopTimeS(state) {
  const ongoing = state.phase === 'waiting' && state.stoppedAtT !== null ? state.t - state.stoppedAtT : 0;
  return round6(state.stopTimeS + ongoing);
}

/** 画面に出す 1 レーン分の値 */
export function laneView(state, config, commonTick) {
  const waiting = state.phase === 'waiting';
  return {
    elapsedS: commonTick / TPS,
    laneTimeS: state.t,
    x: state.x,
    bpm: state.bpm, // 待機中は core が 0 を返す
    targetBpm: state.targetBpm,
    mode: state.mode,
    phase: state.phase,
    waiting,
    signal: core.signalAt(config.signal, commonTick / TPS), // 共通の時計での信号（両レーンで同じ）
    stops: state.stops,
    stopTimeS: displayStopTimeS(state),
    finished: state.finished,
    finishTimeS: state.finishTimeS,
  };
}

export function pairSummary(pair) {
  return {
    normal: core.summarize(pair.normal, pair.configs.normal),
    runwave: core.summarize(pair.runwave, pair.configs.runwave),
  };
}

/** 数値は許容誤差つき、配列・オブジェクトは中身を再帰的に比較する（新しい集計が増えても比べられるように） */
export function sameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b) ? true : Math.abs(a - b) <= TOLERANCE;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (Array.isArray(a) !== Array.isArray(b) || ka.length !== kb.length) return false;
    return ka.every((k) => k in b && sameValue(a[k], b[k]));
  }
  return a === b;
}

/**
 * 逐次 step の最終結果と core.compare(config) を項目ごとに照合する。
 * 比べる項目は summary の全キー（既知のものに限らない。片方にしかないキーは不一致になる）。
 * 終わっていない間は status='pending'（照合待ち）。
 */
export function verifyPair(pair) {
  if (!isPairDone(pair)) return { status: 'pending', items: [] };
  const sequential = pairSummary(pair);
  const reference = core.compare(pair.config, { maxTimeS: MAX_TIME_S });
  const items = [];
  for (const lane of ['normal', 'runwave']) {
    const keys = [...new Set([...Object.keys(sequential[lane] ?? {}), ...Object.keys(reference[lane] ?? {})])];
    for (const key of keys) {
      items.push({
        lane,
        key,
        sequential: sequential[lane][key],
        reference: reference[lane][key],
        ok: sameValue(sequential[lane][key], reference[lane][key]),
      });
    }
  }
  return { status: items.every((i) => i.ok) ? 'match' : 'mismatch', items, sequential, reference };
}

const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

/**
 * 結果の読み方。「停止回避」と「所要時間の差」を別々に書く。遅くなったケースもそのまま示す。
 */
export function describeResult(summary) {
  const { normal, runwave } = summary;
  if (!normal.finished || !runwave.finished) {
    return {
      stopLine: '停止回数: ゴール前のため未確定',
      timeLine: '所要時間: ゴール前のため未確定',
      avoided: null,
      timeDiffS: null,
    };
  }
  let stopLine;
  let avoided;
  if (runwave.stops < normal.stops) {
    avoided = true;
    stopLine = `停止回避: 通常 ${normal.stops} 回 → RUNWAVE ${runwave.stops} 回（${normal.stops - runwave.stops} 回の停止を避けた。停止時間 ${fmt1(normal.stopTimeS)} 秒 → ${fmt1(runwave.stopTimeS)} 秒）`;
  } else if (runwave.stops === normal.stops) {
    avoided = false;
    stopLine = `停止回避なし: 通常 ${normal.stops} 回・RUNWAVE ${runwave.stops} 回で停止回数は変わらない`;
  } else {
    avoided = false;
    stopLine = `停止が増えた: 通常 ${normal.stops} 回 → RUNWAVE ${runwave.stops} 回`;
  }
  const diff = round6(runwave.totalTimeS - normal.totalTimeS);
  let timeLine;
  if (Math.abs(diff) < TOLERANCE) {
    timeLine = `所要時間: 通常 ${fmt1(normal.totalTimeS)} 秒・RUNWAVE ${fmt1(runwave.totalTimeS)} 秒（差なし）`;
  } else if (diff < 0) {
    timeLine = `所要時間: 通常 ${fmt1(normal.totalTimeS)} 秒 → RUNWAVE ${fmt1(runwave.totalTimeS)} 秒（${fmt1(-diff)} 秒短縮）`;
  } else {
    timeLine = `所要時間: 通常 ${fmt1(normal.totalTimeS)} 秒 → RUNWAVE ${fmt1(runwave.totalTimeS)} 秒（+${fmt1(diff)} 秒・遅い）`;
  }
  return { stopLine, timeLine, avoided, timeDiffS: diff };
}

