// 受け入れ証跡: 倍率 x1/x2/x4 で同じ模擬時刻の「位置・時刻・信号位相・BPM」が一致するかを確かめ、結果を JSON に残す。
// 実行: npm run acceptance（node scripts/acceptance-speed.js）。不一致があれば終了コード 1。
// 出力: （リポジトリ直下）docs/acceptance/YYYYMMDD/web-speed-consistency.json（同日に再実行すると上書き。別名で残したいときは先に退避）
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/core-ns.js';
import { runnerView } from '../src/engine-adapter.js';
import { Playback } from '../src/playback.js';
import { getDemo } from '../src/scenarios.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMOS = ['B', 'W'];
const SPEEDS = [1, 2, 4];
const WALL_STEP_S = 0.1;      // 壁時計の刻み（x4 で 1 フレーム 4 tick）
const COMPARE_EVERY = 4;      // 4 tick（0.4 秒）ごとに全倍率で比べる（x4 の 1 フレームが 4 tick のため）
const SAMPLE_KEEP = 8;        // JSON に残す代表サンプル数（全比較の件数は別に記録）

const git = (...args) => {
  try { return execFileSync('git', args, { cwd: appDir, encoding: 'utf8' }).trim(); } catch { return null; }
};

const snap = (pb) => {
  const t = pb.timeS;
  const lanes = {};
  for (const k of ['normal', 'runwave']) {
    const v = runnerView(pb.pair[k], t);
    lanes[k] = { x: v.x, bpm: v.bpm, targetBpm: v.targetBpm, signalColor: v.signal.color, signalRemainingS: v.signal.remainingS, waiting: v.waiting };
  }
  return { tick: pb.pair.tick, timeS: t, lanes };
};

/** speed 倍で最後まで再生し、COMPARE_EVERY tick ごとのスナップショットと最終結果を返す */
function runDemo(config, speed) {
  const pb = new Playback(config);
  pb.setSpeed(speed);
  pb.play();
  const snaps = new Map([[0, snap(pb)]]);
  let guard = 0;
  while (pb.status === 'playing' && guard++ < 1e6) {
    pb.frame(WALL_STEP_S);
    if (pb.pair.tick % COMPARE_EVERY === 0) snaps.set(pb.pair.tick, snap(pb));
  }
  const final = snap(pb);
  return { snaps, final, status: pb.status, events: pb.events.length };
}

const results = [];
let allOk = true;
for (const id of DEMOS) {
  const config = getDemo(id).config;
  const runs = Object.fromEntries(SPEEDS.map((s) => [s, runDemo(config, s)]));
  const base = runs[1];
  const speeds = [];
  for (const s of SPEEDS) {
    const r = runs[s];
    const mismatches = [];
    let compared = 0;
    for (const [tick, a] of base.snaps) {
      const b = r.snaps.get(tick);
      if (!b) continue; // 倍率側が先に終了した tick（終了 tick は final で比べる）
      compared++;
      if (JSON.stringify(a) !== JSON.stringify(b) && mismatches.length < 20) mismatches.push({ tick, base: a, got: b });
    }
    const finalMatch = JSON.stringify(base.final) === JSON.stringify(r.final);
    const ok = mismatches.length === 0 && finalMatch && r.status === 'completed' && r.events === base.events;
    if (!ok) allOk = false;
    const keys = [...base.snaps.keys()];
    const pick = Array.from({ length: SAMPLE_KEEP }, (_, i) => keys[Math.round((i * (keys.length - 1)) / (SAMPLE_KEEP - 1))]);
    speeds.push({
      speed: s,
      ok,
      comparedTicks: compared,
      mismatchCount: mismatches.length,
      mismatches,
      finalTick: r.final.tick,
      finalMatchesX1: finalMatch,
      eventCount: r.events,
      samples: [...new Set(pick)].map((t) => r.snaps.get(t)).filter(Boolean),
    });
  }
  results.push({ demo: id, baseline: 'x1', wallStepS: WALL_STEP_S, compareEveryTicks: COMPARE_EVERY, speeds });
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
const out = {
  item: 'web-speed-consistency',
  description: 'x1/x2/x4 で同じ模擬時刻の位置・時刻・信号位相・BPM が一致するか（デモ B/W）。模擬経路・模擬信号によるシミュレーション',
  ok: allOk,
  executedAt: now.toISOString(),
  git: { sha: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain', '--', '.') ?? '').length > 0 },
  coreVersion: core.CORE_VERSION,
  node: process.version,
  results,
};

const dir = join(appDir, '..', '..', 'docs', 'acceptance', ymd);
mkdirSync(dir, { recursive: true });
const file = join(dir, 'web-speed-consistency.json');
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`${allOk ? 'OK' : 'NG'}: ${file}`);
for (const r of results) for (const s of r.speeds) console.log(`  デモ${r.demo} x${s.speed}: ${s.ok ? '一致' : '不一致'}（比較 ${s.comparedTicks} 点・終了 tick ${s.finalTick}）`);
process.exit(allOk ? 0 : 1);
