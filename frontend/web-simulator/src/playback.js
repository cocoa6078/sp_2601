// 固定刻みの共通時計（DOM 非依存）。実時間差分 × 倍率を accumulator にため、0.1 秒ごとに両走行を 1 tick 進める。
// 計算結果はフレームの刻み・倍率・一時停止の有無に依存しない（tick の数だけで決まる）。
import { DT, createPair, detectCrossing, isRouteConfig, pairDone, sampleLane, stepPair } from './engine-adapter.js';

export const SPEEDS = [1, 2, 4, 5];
export const MAX_TICKS_PER_FRAME = 50;     // 1 フレームの計算量の上限（超えた分は次フレームへ持ち越す）
export const MAX_WALL_DELTA_S = 0.5;       // 1 フレームで受け取る実時間の上限（隠れていた時間をまとめて計算しない）

export class Playback {
  constructor(config, { maxTicksPerFrame = MAX_TICKS_PER_FRAME, signalId = null } = {}) {
    this.config = config;
    this.signalId = signalId;
    this.maxTicksPerFrame = maxTicksPerFrame;
    this.speed = 1;
    this.reset();
  }

  reset() {
    this.pair = createPair(this.config);
    this.acc = 0;
    this.events = [];
    this.series = [];               // 時系列（CSV 用）。tick ごとに両走行 1 行ずつ
    this.recordSeries();
    this.status = 'ready';          // ready | playing | paused | completed
    this.lagging = false;           // 固定刻みを消化し切れていない（「計算中」表示用）
    return this;
  }

  setSpeed(v) { this.speed = v; }
  play() { if (this.status === 'ready' || this.status === 'paused') this.status = 'playing'; }
  pause() { if (this.status === 'playing') this.status = 'paused'; }
  get timeS() { return this.pair.tick / 10; }

  recordSeries() {
    const t = this.timeS;
    for (const lane of ['normal', 'runwave']) this.series.push({ lane, tS: t, ...sampleLane(this.pair[lane], t) });
  }

  /** 1 tick 進める（イベント記録つき） */
  tick() {
    const prev = this.pair;
    this.pair = stepPair(prev);
    for (const lane of ['normal', 'runwave']) {
      if (isRouteConfig(this.config)) {
        // 複数信号: イベントは route-core の state.events が正（arrive / waitStart / waitEnd / crossStart / crossEnd）
        const a = prev[lane].state.events;
        const b = this.pair[lane].state.events;
        for (let i = a.length; i < b.length; i++) this.events.push({ lane, ...b[i] });
        continue;
      }
      const ev = detectCrossing(prev[lane].state, this.pair[lane].state, this.pair[lane].cfg, lane, this.signalId);
      if (ev) this.events.push(ev);
    }
    this.recordSeries();
    if (pairDone(this.pair)) this.status = 'completed';
  }

  /** wallDeltaS = 前フレームからの実時間（秒）。進めた tick 数を返す */
  frame(wallDeltaS) {
    if (this.status !== 'playing') return 0;
    this.acc += Math.min(Math.max(wallDeltaS, 0), MAX_WALL_DELTA_S) * this.speed;
    let n = 0;
    while (this.acc >= DT - 1e-9 && n < this.maxTicksPerFrame && this.status === 'playing') {
      this.tick();
      this.acc -= DT;
      n++;
    }
    this.lagging = this.status === 'playing' && this.acc >= DT - 1e-9;
    if (this.status === 'completed') this.acc = 0;
    return n;
  }

  /** 時間切れで終わったか（どちらかが未ゴール） */
  get timedOut() {
    return this.status === 'completed' && !(this.pair.normal.state.finished && this.pair.runwave.state.finished);
  }
}
