// core の初期化・固定時計・再生制御・場面ジャンプ（DOM 非依存。Node のテストと Vite の両方から同じファイルを使う）
// 計算は core の createRun / step / summarize をそのまま呼ぶだけ。到着判定や目標 BPM の選択は UI 側で一切行わない。
// 時計: state.tick（1 tick = 0.1 秒固定）。表示倍率は「何 tick 進めるか」だけを変え、dt は変えない。
import { core } from './core-ns.js';

export const TPS = 10;
export const MAX_TIME_S = 1800; // 計算上限（シミュレーション時間）
export const MAX_TICKS = Math.ceil(MAX_TIME_S * TPS);
export const SPEEDS = [1, 2, 5];
export const DEMO_SPEED = 'demo'; // 「30秒デモ」: スタートからゴールまでを実時間で約 30 秒にする倍率
export const DEMO_SECONDS = 30;
export const SPEED_KEYS = [DEMO_SPEED, ...SPEEDS];
export const CUSTOM_SPEED = 'custom'; // 通しデモ: シナリオごとの倍率を呼び出し側が指定する
export const DEFAULT_SPEED = DEMO_SPEED;
export const MAX_FRAME_MS = 1000; // 1 フレームで取り込む実時間の上限

/** 初期状態から n tick だけ core を逐次 step した state（場面ジャンプと検証に使う。手書きの state は作らない） */
export function stateAtTick(config, tick) {
  let s = core.createRun(config);
  while (!s.finished && s.tick < tick) s = core.step(s, config);
  return s;
}

const demoCache = new WeakMap();
/**
 * 30 秒デモの倍率 = 同じ config を core で最後まで逐次 step した所要時間 ÷ 30。
 * 設定値・dt・信号周期は変えず、時計の進め方だけを変える。ゴールしない条件では計算上限 ÷ 30。
 */
export function demoMultiplier(config) {
  if (!demoCache.has(config)) {
    let s = core.createRun(config);
    while (!s.finished && s.tick < MAX_TICKS) s = core.step(s, config);
    const total = s.finished ? s.finishTimeS : MAX_TIME_S;
    demoCache.set(config, total / DEMO_SECONDS);
  }
  return demoCache.get(config);
}

export function speedLabel(key, multiplier) {
  const m = (Math.round(multiplier * 10) / 10).toFixed(1);
  if (key === DEMO_SPEED) return `約${m}倍速（30秒デモ）`;
  if (key === CUSTOM_SPEED) return `約${m}倍速（通しデモ）`;
  return `${key}倍速`;
}

/**
 * requestAnimationFrame 1 回ぶんで進める tick 数（純粋関数）。実時間 1 秒 = 10 tick（等倍）。
 * 端数は carry に持ち越し、tick は飛ばさない。1 フレームの実時間は maxElapsedMs（1 秒）で頭打ち。
 */
export function planTicks({ carry = 0, elapsedMs, speed, maxElapsedMs = MAX_FRAME_MS }) {
  if (!Number.isFinite(speed) || speed <= 0) throw new RangeError('倍率は正の数');
  const ms = Math.min(Math.max(0, elapsedMs), maxElapsedMs);
  const total = carry + (ms / 1000) * TPS * speed;
  const n = Math.floor(total + 1e-9);
  return { n, carry: Math.max(0, total - n) };
}

/**
 * status: ready（準備）/ playing（再生中）/ paused（一時停止）/ explaining（解説中）/ done（完了）/ limit（計算上限）/ error（エラー）
 * ループは呼び出し側が 1 本だけ回し、毎フレーム frame(nowMs) を呼ぶ。play() の連打で速くはならない。
 */
export function createSession(config, { speed = DEFAULT_SPEED } = {}) {
  let cfg = config;
  let state = core.createRun(cfg);
  let running = false;
  let hold = false; // 解説中: 時計を止める
  let carry = 0;
  let last = null;
  let error = null;
  let curSpeed = speed;
  let customMult = 1;
  let breakTick = Infinity; // この tick で止める（通しデモの区間終了・自動解説の位置を tick 単位で正確に）
  const resetClock = () => { carry = 0; last = null; };

  const api = {
    get config() { return cfg; },
    get state() { return state; },
    get tick() { return state.tick; },
    get timeS() { return state.tick / TPS; },
    get speed() { return curSpeed; },
    /** 実際の倍率（30 秒デモはシナリオごとに決まる） */
    get multiplier() { return curSpeed === DEMO_SPEED ? demoMultiplier(cfg) : curSpeed === CUSTOM_SPEED ? customMult : curSpeed; },
    get breakTick() { return breakTick; },
    set breakTick(v) { breakTick = v; },
    setCustomMultiplier(m) {
      if (!Number.isFinite(m) || m <= 0) throw new RangeError('倍率は正の数');
      customMult = m;
      curSpeed = CUSTOM_SPEED;
    },
    get speedLabel() { return speedLabel(curSpeed, api.multiplier); },
    get running() { return running; },
    get hold() { return hold; },
    get error() { return error; },
    get done() { return state.finished || state.tick >= MAX_TICKS; },
    get status() {
      if (error) return 'error';
      if (hold) return 'explaining';
      if (state.finished) return 'done';
      if (state.tick >= MAX_TICKS) return 'limit';
      if (running) return 'playing';
      return state.tick === 0 ? 'ready' : 'paused';
    },
    play() {
      if (error || hold || api.done) return false;
      if (!running) { running = true; resetClock(); }
      return true;
    },
    pause() { running = false; resetClock(); },
    /** タブ非表示。一時停止にして、復帰しても停止を維持する（裏の時間は加算しない） */
    hide() { api.pause(); },
    setHold(v) { hold = Boolean(v); if (hold) api.pause(); },
    setSpeed(s) {
      if (!SPEED_KEYS.includes(s)) throw new RangeError(`表示速度は ${SPEED_KEYS.join(' / ')} のいずれか`);
      curSpeed = s;
    },
    /** 新しい条件（省略時は現在の条件）で t=0 に戻して停止。不正なら例外を投げ、現在の状態は変えない */
    reset(nextConfig = cfg) {
      const next = core.createRun(nextConfig);
      cfg = nextConfig;
      state = next;
      running = false;
      hold = false;
      breakTick = Infinity;
      error = null;
      resetClock();
    },
    /** 場面ジャンプ: 初期状態から core を逐次 step して得た state へ移動し、停止する */
    jumpTo(tick) {
      state = stateAtTick(cfg, tick);
      running = false;
      resetClock();
      return state;
    },
    /** 毎フレーム。進めた tick 数を返す（停止・解説中は 0） */
    frame(nowMs) {
      if (!running || hold) return 0;
      if (last === null) { last = nowMs; return 0; }
      const elapsedMs = nowMs - last;
      last = nowMs;
      try {
        const plan = planTicks({ carry, elapsedMs, speed: api.multiplier });
        carry = plan.carry;
        const before = state.tick;
        let s = state;
        for (let i = 0; i < plan.n && !s.finished && s.tick < MAX_TICKS && s.tick < breakTick; i++) s = core.step(s, cfg);
        state = s;
        if (s.tick >= breakTick) { running = false; resetClock(); }
        if (api.done) { running = false; resetClock(); }
        return state.tick - before;
      } catch (e) {
        error = e.message || String(e);
        running = false;
        resetClock();
        return 0;
      }
    },
    summary() { return core.summarize(state, cfg); },
  };
  return api;
}
