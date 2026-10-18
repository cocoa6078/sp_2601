// 画面から core の呼び出しを隠す層。
// 信号1件は既存の1交差点 core（createRun/step）、2件以上は route-core（createRouteRun/stepRoute）で計算する。
import { core, routeNs } from './core-ns.js';
import { toCoreSignal } from './phase.js';

export const TPS = 10;
export const DT = core.DT;                  // 0.1 秒固定
export const MAX_TIME_S = 1800;
export const MAX_TICKS = MAX_TIME_S * TPS;
export const WALK_STRIDE_DEFAULT_M = 0.75;  // core の DEFAULT_WALK_STRIDE_M と同じ【仮】（core 側は非公開定数）

export const isRouteConfig = (config) => Array.isArray(config?.signals);
export const versions = () => ({ coreVersion: core.CORE_VERSION, routeVersion: routeNs.ROUTE_VERSION });

/**
 * 計算に使うエンジンを選ぶ。
 * @returns {{kind:'single', config}|{kind:'unsupported', reason}|{kind:'none', reason}|{kind:'invalid', reason}}
 */
export function planFromMap({ route, adopted, runner, control, runStartUnixS = null }) {
  if (!route) return { kind: 'none', reason: '経路が確定していません' };
  if (adopted.length === 0) return { kind: 'none', reason: 'この経路に対応する信号なし' };
  // phaseS の基準を core 用（run-start）に直す。基準は信号自身の phaseReference、無ければ API 由来の apiMeta から
  let signals;
  try {
    signals = adopted.map((a) => toCoreSignal({ ...a.signal, phaseReference: a.signal.phaseReference ?? a.apiMeta?.phaseReference ?? undefined }, runStartUnixS));
  } catch (e) {
    return { kind: 'invalid', reason: `位相の換算に失敗: ${e.message}` };
  }
  if (adopted.length > 1) {
    // 複数信号: route-core（連続走行）。atM は経路の開始点から測り直した s、goalM は経路長。id は key（地域＋元ID）で一意にする
    const config = {
      runner: { ...runner },
      control: JSON.parse(JSON.stringify(control)),
      goalM: route.lengthM,
      signals: adopted.map((a, i) => ({ id: a.key, atM: a.s, signal: signals[i], meta: { signalId: a.signalId, origin: a.origin ?? null, note: a.note ?? null, isEstimated: true } })),
    };
    try {
      routeNs.validateRouteConfig(config);
    } catch (e) {
      return { kind: 'invalid', reason: `route-core が受け付けない条件: ${e.message}` };
    }
    return { kind: 'route', config };
  }
  const a = adopted[0];
  const config = {
    runner: { ...runner },
    signal: signals[0],
    route: { crossingX: a.s, goalX: route.lengthM },
    control: JSON.parse(JSON.stringify(control)),
  };
  try {
    core.validateConfig(config);
  } catch (e) {
    return { kind: 'invalid', reason: `core が受け付けない条件: ${e.message}` };
  }
  return { kind: 'single', config };
}

/** 通常（制御 OFF）と RUNWAVE（制御 ON）。差は control.enabled だけ。walk 設定は両方に同じ値を保持 */
export function pairConfigs(config) {
  const withEnabled = (enabled) => ({ ...config, control: { ...(config.control || {}), enabled } });
  return { normal: withEnabled(false), runwave: withEnabled(true) };
}

export function createPair(config) {
  const cfg = pairConfigs(config);
  const create = isRouteConfig(config) ? routeNs.createRouteRun : core.createRun;
  return {
    tick: 0,
    config,
    normal: { cfg: cfg.normal, state: create(cfg.normal) },
    runwave: { cfg: cfg.runwave, state: create(cfg.runwave) },
  };
}

/** 共通時計を 1 tick（0.1 秒）進める。ゴール済みの走行は core が同じ state を返す */
export function stepPair(pair) {
  const core_ = isRouteConfig(pair.config) ? { step: routeNs.stepRoute } : core;
  return {
    ...pair,
    tick: pair.tick + 1,
    normal: { ...pair.normal, state: core_.step(pair.normal.state, pair.normal.cfg) },
    runwave: { ...pair.runwave, state: core_.step(pair.runwave.state, pair.runwave.cfg) },
  };
}

export const pairDone = (pair) => (pair.normal.state.finished && pair.runwave.state.finished) || pair.tick >= MAX_TICKS;
export const pairTimeS = (pair) => pair.tick / TPS;

export const summaryOf = (lane) => (isRouteConfig(lane.cfg) ? routeNs.summarizeRoute(lane.state, lane.cfg) : core.summarize(lane.state, lane.cfg));

/** 一括計算（core.compare）。画面の数値の期待値。数値は直書きしない */
export function expectedFor(config) {
  const r = isRouteConfig(config) ? routeNs.compareRoute(config) : core.compare(config);
  return { normal: r.normal, runwave: r.runwave };
}

const same = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-6);
/** 走行の最終結果が一括計算と一致するか */
export function matchesExpected(pair, expected) {
  const diffs = [];
  for (const k of ['normal', 'runwave']) {
    const got = summaryOf(pair[k]);
    const exp = expected[k];
    for (const f of ['stops', 'stopTimeS', 'totalTimeS']) {
      if (!same(got[f], exp[f])) diffs.push(`${k}.${f}: 画面 ${got[f]} / core ${exp[f]}`);
    }
    if (got.signals) {
      got.signals.forEach((g, i) => {
        const e = exp.signals[i];
        for (const f of ['arriveT', 'crossStartT', 'crossEndT', 'waitS']) if (!same(g[f], e[f])) diffs.push(`${k}.signals[${i}].${f}: 画面 ${g[f]} / core ${e[f]}`);
        if (g.waited !== e.waited || g.passed !== e.passed) diffs.push(`${k}.signals[${i}] の通過/待機が不一致`);
      });
    }
  }
  return { ok: diffs.length === 0, diffs };
}

export const modeLabel = (mode) => core.MODE_LABELS?.[mode] ?? String(mode);

// 設計書 §5 の reason 表示。walkBridge でも gait=run の間は「早歩きに備えてテンポ調整」
export function reasonLabel(state) {
  const walking = state.gait === 'walk';
  switch (state.reason) {
    case 'none': return '調整不要';
    case 'signal': return '信号に合わせて調整中';
    case 'noMargin': return '余裕付きの計画なし・通常ペースで青に到着見込み';
    case 'walkBridge': return walking ? '早歩きでつないでいます' : '早歩きに備えてテンポ調整';
    case 'unavoidable': return 'この条件では待機見込み';
    case 'off': return '通常走行';
    case 'waiting': return '信号待ち';
    case 'passed': return '通過済み';
    default: return String(state.reason);
  }
}

/** 1 走行の表示用の値 */
export function runnerView(lane, commonT) {
  const { state, cfg } = lane;
  const route = isRouteConfig(cfg);
  const nSig = route ? cfg.signals.length : 1;
  const idx = route ? Math.min(state.signalIndex, nSig - 1) : 0;
  const curSignal = route ? cfg.signals[idx].signal : cfg.signal;
  const crossingX = route ? cfg.signals[idx].atM : cfg.route.crossingX;
  const goalX = route ? cfg.goalM : cfg.route.goalX;
  const sig = core.signalAt(curSignal, commonT);
  const walking = state.gait === 'walk';
  const waiting = state.phase === 'waiting';
  const finished = state.finished;
  let speedMps;
  if (waiting || finished) speedMps = 0;
  else if ('gait' in state) speedMps = state.speedMps;
  else speedMps = (cfg.runner.strideM * state.bpm) / 60;
  const strideM = walking ? (cfg.runner.walkStrideM ?? WALK_STRIDE_DEFAULT_M) : cfg.runner.strideM;
  const passed = route ? state.signalIndex >= nSig : state.phase === 'after' || state.phase === 'finished' || (state.phase === 'crossing' && state.x > crossingX);
  const sum = summaryOf(lane);
  return {
    x: state.x,
    mode: state.mode,
    modeText: modeLabel(state.mode),
    reasonText: reasonLabel(state),
    gait: state.gait ?? 'run',
    walking,
    bpm: waiting || finished ? 0 : state.bpm,
    targetBpm: state.targetBpm,
    speedMps,
    speedKmh: speedMps * 3.6,
    strideM,
    distToSignalM: passed ? null : Math.max(0, crossingX - state.x),
    signalIndex: route ? state.signalIndex : 0,
    signalCount: nSig,
    goalX,
    perSignal: sum.signals ?? null,
    signal: sig,
    stops: sum.stops,
    stopTimeS: sum.stopTimeS,
    totalTimeS: finished ? sum.totalTimeS : null,
    walkCount: sum.walkCount ?? 0,
    walkTimeS: sum.walkTimeS ?? 0,
    walkDistanceM: sum.walkDistanceM ?? 0,
    finished,
    waiting,
  };
}

/** 時系列 1 行分（CSV 用）。位置 m・信号色・目標/現在 BPM・速度・状態。式は持たず core の state を読むだけ */
export function sampleLane(lane, commonT) {
  const { state, cfg } = lane;
  const route = isRouteConfig(cfg);
  const nSig = route ? cfg.signals.length : 1;
  const idx = route ? Math.min(state.signalIndex, nSig - 1) : 0;
  const curSignal = route ? cfg.signals[idx].signal : cfg.signal;
  const waiting = state.phase === 'waiting';
  const finished = !!state.finished;
  let speedMps;
  if (waiting || finished) speedMps = 0;
  else if ('gait' in state) speedMps = state.speedMps;
  else speedMps = (cfg.runner.strideM * state.bpm) / 60;
  const passed = route ? state.signalIndex >= nSig : state.phase === 'after' || state.phase === 'finished';
  let st = 'approach';
  if (finished) st = 'finished';
  else if (waiting) st = 'stopped';
  else if (state.phase === 'crossing') st = 'crossing';
  else if (passed) st = 'passed';
  return {
    xM: state.x,
    signalColor: core.signalAt(curSignal, commonT).color,
    targetBpm: state.targetBpm ?? null,
    bpm: waiting || finished ? 0 : state.bpm,
    speedMps,
    state: st,
  };
}

/** 次の青までの秒数（青なら 0、青点滅なら点滅残り＋赤、赤なら残り）。青区間が無ければ null。設計書 §5 */
export function secondsToGreen(signal, t) {
  if (!(signal.greenS > 0)) return null;
  const s = core.signalAt(signal, t);
  if (s.color === 'green') return 0;
  if (s.color === 'flashing') return s.remainingS + signal.redS;
  return s.remainingS;
}

/** 表示用の信号色と state.signal の整合（走行中の state について、同じ時刻の色が一致するか） */
export function signalConsistent(lane) {
  const st = lane.state;
  return core.signalAt(lane.cfg.signal, st.t).color === st.signal.color;
}

/** 前後の state の差から交差点到達イベントを作る（停止は到着時刻が正確、通過は tick 精度）。なければ null */
export function detectCrossing(prev, next, cfg, laneName, signalId = null) {
  if (prev.phase !== 'approach') return null;
  const stopped = next.stops > prev.stops;
  const entered = !stopped && ['crossing', 'after', 'finished'].includes(next.phase);
  if (!stopped && !entered) return null;
  const base = { lane: laneName, signalId, gait: next.gait ?? 'run' };
  if (stopped) {
    const t = next.stoppedAtT ?? next.t;
    return { ...base, tS: t, color: core.signalAt(cfg.signal, t).color, entered: false, stopTimeS: next.stopTimeS, speedMps: 0, x: cfg.route.crossingX, precision: next.stoppedAtT != null ? 'exact' : 'tick' };
  }
  return { ...base, tS: next.t, color: core.signalAt(cfg.signal, next.t).color, entered: true, stopTimeS: next.stopTimeS, speedMps: next.speedMps ?? null, x: next.x, precision: 'tick' };
}
