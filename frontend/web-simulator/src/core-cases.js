// 共通ケース（core/cases/core-cases.json）の読み取りを 1 か所に集める（Node 専用・DOM 非依存）。
// ファイルの形式は未確定。形式が違っていたら、直す場所はこのファイルだけ。
//
// 【仮】想定形式（core 改訂で確定したらここを合わせる）:
// {
//   "coreVersion": "0.5.0",                     // 必須・文字列
//   "cases": [                                  // 必須・配列
//     {
//       "id": "B-basic",                        // 必須・文字列（重複不可）
//       "description": "任意の説明",
//       "config": { ... },                      // 必須。1交差点 { runner, signal, route, control } か
//                                               //       複数信号 { runner, signals:[{id,atM,signal}], goalM, control }
//       "runStartUnixS": 1760000000             // 任意。signal.phaseReference が "unix-epoch" のときの走行開始 Unix 秒
//     }
//   ]
// }
// 期待値（expected）は読まない。比較は「web の engine-adapter 経由」と「core 直呼び」の一致だけで行う。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core, routeNs } from './core-ns.js';
import { TPS, isRouteConfig, pairDone } from './engine-adapter.js';
import { toCoreSignal } from './phase.js';
import { Playback } from './playback.js';

const here = dirname(fileURLToPath(import.meta.url));
export const CORE_CASES_PATH = resolve(here, '../../../core/cases/core-cases.json');
export const coreCasesExist = (path = CORE_CASES_PATH) => existsSync(path);

export class CoreCasesFormatError extends Error {
  constructor(msg) { super(`形式が想定と違う: ${msg}`); this.name = 'CoreCasesFormatError'; }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** JSON 文字列またはオブジェクトを検証して { coreVersion, cases } にする。形式違いは CoreCasesFormatError */
export function parseCoreCases(input, label = 'core-cases.json') {
  let json = input;
  if (typeof input === 'string') {
    try { json = JSON.parse(input); } catch (e) { throw new CoreCasesFormatError(`${label} が JSON として読めない（${e.message}）`); }
  }
  if (!isObj(json)) throw new CoreCasesFormatError(`${label} の最上位がオブジェクトではない`);
  if (typeof json.coreVersion !== 'string' || json.coreVersion === '') throw new CoreCasesFormatError('coreVersion（文字列）がない');
  if (!Array.isArray(json.cases)) throw new CoreCasesFormatError('cases が配列ではない');
  const seen = new Set();
  const cases = json.cases.map((c, i) => {
    if (!isObj(c)) throw new CoreCasesFormatError(`cases[${i}] がオブジェクトではない`);
    if (typeof c.id !== 'string' || c.id === '') throw new CoreCasesFormatError(`cases[${i}].id（文字列）がない`);
    if (seen.has(c.id)) throw new CoreCasesFormatError(`cases[${i}].id が重複: ${c.id}`);
    seen.add(c.id);
    if (!isObj(c.config)) throw new CoreCasesFormatError(`${c.id}: config がオブジェクトではない`);
    const route = Array.isArray(c.config.signals);
    if (route ? c.config.signals.length === 0 : !isObj(c.config.signal)) throw new CoreCasesFormatError(`${c.id}: config.signal か config.signals（1 件以上）がない`);
    if (c.runStartUnixS !== undefined && !Number.isFinite(c.runStartUnixS)) throw new CoreCasesFormatError(`${c.id}: runStartUnixS が数ではない`);
    return { id: c.id, description: c.description ?? null, config: c.config, runStartUnixS: c.runStartUnixS ?? null };
  });
  return { coreVersion: json.coreVersion, cases };
}

export function loadCoreCases(path = CORE_CASES_PATH) {
  return parseCoreCases(readFileSync(path, 'utf-8'), path);
}

/** phaseReference を run-start に直した core 用 config。入力は変更しない */
export function toCoreConfig(config, runStartUnixS = null) {
  if (isRouteConfig(config)) return { ...config, signals: config.signals.map((s) => ({ ...s, signal: toCoreSignal(s.signal, runStartUnixS) })) };
  return { ...config, signal: toCoreSignal(config.signal, runStartUnixS) };
}

// ---- 走行の記録（比較用）。判断は core の state を読むだけで、ここでは何も決めない ----
const sample = (lane, state) => ({ lane, t: state.t, mode: state.mode, reason: state.reason, targetBpm: state.targetBpm ?? null, bpm: state.bpm, x: state.x });

/** 到達イベントを「種類@時刻:色:信号」の文字列にそろえる */
const evKey = (e) => (e.type
  ? `${e.type}@${e.t}:${e.color}:${e.signalId ?? ''}`
  : `${e.entered ? 'pass' : 'stop'}@${e.tS}:${e.color}`);

/** web の engine-adapter（createPair/stepPair + Playback のイベント検出）で走らせる */
export function runViaAdapter(config) {
  const pb = new Playback(config);
  const samples = [];
  const rec = () => { for (const lane of ['normal', 'runwave']) samples.push(sample(lane, pb.pair[lane].state)); };
  rec();
  while (!pairDone(pb.pair)) { pb.tick(); rec(); }
  return { ticks: pb.pair.tick, samples, events: pb.events.map((e) => `${e.lane}:${evKey(e)}`) };
}

/** core 直呼び（createRun/step、複数信号は route-core）。adapter と同じ 2 走行・同じ刻みで回す */
export function runDirect(config) {
  const route = isRouteConfig(config);
  const mk = (enabled) => ({ ...config, control: { ...(config.control || {}), enabled } });
  const cfg = { normal: mk(false), runwave: mk(true) };
  const create = route ? routeNs.createRouteRun : core.createRun;
  const step = route ? routeNs.stepRoute : core.step;
  let st = { normal: create(cfg.normal), runwave: create(cfg.runwave) };
  const samples = [];
  const events = [];
  const rec = () => { for (const lane of ['normal', 'runwave']) samples.push(sample(lane, st[lane])); };
  rec();
  let tick = 0;
  const maxTicks = 1800 * TPS;
  while (!((st.normal.finished && st.runwave.finished) || tick >= maxTicks)) {
    const prev = st;
    st = { normal: step(prev.normal, cfg.normal), runwave: step(prev.runwave, cfg.runwave) };
    tick++;
    for (const lane of ['normal', 'runwave']) {
      const a = prev[lane];
      const b = st[lane];
      if (route) {
        for (let i = a.events.length; i < b.events.length; i++) events.push(`${lane}:${evKey(b.events[i])}`);
      } else if (a.phase === 'approach') {
        const stopped = b.stops > a.stops;
        const entered = !stopped && ['crossing', 'after', 'finished'].includes(b.phase);
        if (stopped) {
          const t = b.stoppedAtT ?? b.t;
          events.push(`${lane}:${evKey({ entered: false, tS: t, color: core.signalAt(cfg[lane].signal, t).color })}`);
        } else if (entered) {
          events.push(`${lane}:${evKey({ entered: true, tS: b.t, color: core.signalAt(cfg[lane].signal, b.t).color })}`);
        }
      }
    }
    rec();
  }
  return { ticks: tick, samples, events };
}

/** adapter 経由と core 直呼びを比べる。差分は人が読める文字列で返す（最大 10 件） */
export function compareCase(c) {
  const config = toCoreConfig(c.config, c.runStartUnixS);
  const a = runViaAdapter(config);
  const d = runDirect(config);
  const diffs = [];
  if (a.ticks !== d.ticks) diffs.push(`終了 tick: web ${a.ticks} / core ${d.ticks}`);
  const n = Math.min(a.samples.length, d.samples.length);
  for (let i = 0; i < n && diffs.length < 10; i++) {
    const x = a.samples[i];
    const y = d.samples[i];
    for (const k of ['mode', 'reason', 'targetBpm', 'bpm', 'x']) {
      if (x[k] !== y[k]) diffs.push(`t=${x.t} ${x.lane}.${k}: web ${x[k]} / core ${y[k]}`);
    }
  }
  if (JSON.stringify(a.events) !== JSON.stringify(d.events)) diffs.push(`通過/停止・進入色の列が不一致: web ${JSON.stringify(a.events)} / core ${JSON.stringify(d.events)}`);
  return { id: c.id, ok: diffs.length === 0, diffs: diffs.slice(0, 10), ticks: a.ticks };
}
