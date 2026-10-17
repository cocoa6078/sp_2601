import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrate, requiredBpm, signalAt, safeGreenWindows, limitRate, chooseTarget,
  createRun, step, simulate, compare, validateConfig,
} from './runwave-core.js';
import { SCENARIOS, DEMO, withCrossing } from './scenarios.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const SIG = { cycleS: 120, greenS: 50, yellowS: 5, redS: 65, phaseS: 0, crossingM: 20 };

// 走行を最後まで回し、全 state を返す
function trace(config) {
  const out = [createRun(config)];
  while (!out.at(-1).finished && out.at(-1).tick < 18000) out.push(step(out.at(-1), config));
  return out;
}
const withPhase = (config, phaseS) => ({ ...config, signal: { ...config.signal, phaseS } });
const withEnabled = (config, enabled) => ({ ...config, control: { ...config.control, enabled } });

// 性質テストに使う条件の組み合わせ（位相・横断距離・制御ON/OFF）
const sweep = [];
for (let phaseS = 0; phaseS < 120; phaseS += 7)
  for (const crossingM of [0, 20])
    for (const enabled of [false, true])
      sweep.push(withEnabled(withPhase(withCrossing(SCENARIOS.A, crossingM), phaseS), enabled));

// ---------- 手計算との一致 ----------
test('calibrate: L=D/N, C0=60N/T, v0=L·C0/60', () => {
  const r = calibrate({ distanceM: 400, steps: 500, timeS: 200 });
  near(r.strideM, 0.8);
  near(r.baseBpm, 150);
  near(r.speedMps, 2);
});

test('requiredBpm: D400・L0.8・T188 → 159.6', () => {
  near(requiredBpm(400, 0.8, 188), 24000 / 150.4);
  assert.equal(requiredBpm(400, 0.8, 188).toFixed(1), '159.6');
});

test('不正な入力は RangeError', () => {
  assert.throws(() => calibrate({ distanceM: 0, steps: 10, timeS: 5 }), RangeError);
  assert.throws(() => validateConfig({ ...SCENARIOS.A, signal: { ...SIG, redS: 60 } }), RangeError);
  assert.throws(() => validateConfig({ ...SCENARIOS.A, runner: { strideM: 0.8, baseBpm: NaN } }), RangeError);
});

// ---------- 信号（位相・境界） ----------
test('signalAt: 青→青点滅→赤、境界は次の色（半開区間）', () => {
  assert.equal(signalAt(SIG, 0).color, 'green');
  near(signalAt(SIG, 0).remainingS, 50);
  assert.equal(signalAt(SIG, 49.9).color, 'green');
  assert.equal(signalAt(SIG, 50).color, 'flashing');
  assert.equal(signalAt(SIG, 50).label, '青点滅');
  assert.equal(signalAt(SIG, 54.9).color, 'flashing');
  assert.equal(signalAt(SIG, 55).color, 'red');
  near(signalAt(SIG, 55).remainingS, 65);
  assert.equal(signalAt(SIG, 120).color, 'green');
  near(signalAt(SIG, 30).cycleProgress, 0.25);
});

test('signalAt: phaseS は時刻0にサイクルの何秒目か。負や周期超えも正規化', () => {
  assert.equal(signalAt({ ...SIG, phaseS: 20 }, 100).color, 'green');   // 100+20=120 → 0秒目
  assert.equal(signalAt({ ...SIG, phaseS: 20 }, 99.9).color, 'red');
  assert.equal(signalAt({ ...SIG, phaseS: -10 }, 0).color, 'red');      // 110秒目
  assert.equal(signalAt({ ...SIG, phaseS: 250 }, 0).color, 'green');    // 10秒目
  // 0.1刻みを積み重ねても境界がずれない
  assert.equal(signalAt(SIG, 500 / 10).color, 'flashing');
});

test('safeGreenWindows: [青開始+3, 青終了−横断時間−5)', () => {
  const ws = safeGreenWindows({ ...SIG, phaseS: 20 }, 0, 300, { startMarginS: 3, endMarginS: 5, crossTimeS: 10 });
  // t=0 より前に始まった青（−20〜30秒）の窓は fromT で切り詰めて返す
  assert.deepEqual(ws, [{ startT: 0, endT: 15 }, { startT: 103, endT: 135 }, { startT: 223, endT: 255 }]);
  // 余裕で潰れる青は返さない
  assert.deepEqual(safeGreenWindows({ ...SIG, greenS: 10, redS: 105 }, 0, 100, { crossTimeS: 5 }), []);
});

// ---------- BPM制限 ----------
test('limitRate: t=0 と 4秒の倍数以外では変えない', () => {
  const cfg = SCENARIOS.A;
  assert.equal(limitRate(150, 130, { tick: 0 }, cfg), 150);
  assert.equal(limitRate(150, 130, { tick: 39 }, cfg), 150);
  assert.equal(limitRate(150, 130, { tick: 40 }, cfg), 148);
  assert.equal(limitRate(150, 151, { tick: 80 }, cfg), 151);
});

test('limitRate: 通常BPM±20を超えない', () => {
  const cfg = SCENARIOS.A;
  assert.equal(limitRate(130, 100, { tick: 40 }, cfg), 130);
  assert.equal(limitRate(170, 200, { tick: 40 }, cfg), 170);
});

test('走行中のBPMは常に±20以内、変化は4秒の倍数の時刻だけで1回2以内（再開時の例外を除く）', () => {
  for (const cfg of sweep) {
    const tr = trace(cfg);
    const base = cfg.runner.baseBpm;
    for (let i = 1; i < tr.length; i++) {
      const [a, b] = [tr[i - 1], tr[i]];
      assert.ok(b.bpm >= base - 20 && b.bpm <= base + 20);
      if (a.bpm === b.bpm) continue;
      if (a.phase === 'waiting') { assert.equal(b.bpm, base); continue; } // 再開: 通常BPMへ即時
      assert.equal(a.tick % 40, 0, `t=${a.t} で変化`);
      assert.ok(a.tick > 0);
      assert.ok(Math.abs(b.bpm - a.bpm) <= 2);
    }
  }
});

// ---------- 横断の安全（モデル上） ----------
test('青点滅・赤のときに横断へ進入しない。横断中は常に青', () => {
  for (const cfg of sweep) {
    const tr = trace(cfg);
    const { crossingX } = cfg.route;
    for (let i = 1; i < tr.length; i++) {
      const [a, b] = [tr[i - 1], tr[i]];
      if (a.phase === 'waiting' && b.phase !== 'waiting') {
        assert.equal(signalAt(cfg.signal, a.t).color, 'green', `再開 t=${a.t}`);
      }
      if (a.phase === 'approach' && b.x > crossingX) {
        const arriveT = a.t + (crossingX - a.x) / (cfg.runner.strideM * b.bpm / 60);
        assert.equal(signalAt(cfg.signal, arriveT).color, 'green', `進入 t=${arriveT}`);
      }
      if (b.phase === 'crossing') assert.equal(b.signal.color, 'green', `横断中 t=${b.t}`);
      assert.ok(b.x <= cfg.route.goalX);
    }
  }
});

test('ゴール後の step は同じ state を返す', () => {
  const { state } = simulate(SCENARIOS.A);
  assert.equal(state.finished, true);
  assert.equal(step(state, SCENARIOS.A), state);
});

// ---------- 再現性・純粋性 ----------
test('同じ入力なら同じ結果', () => {
  for (const cfg of sweep.slice(0, 8)) assert.deepEqual(simulate(cfg), simulate(structuredClone(cfg)));
});

test('step は入力の state を変更しない', () => {
  const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
  const cfg = deepFreeze(structuredClone(SCENARIOS.B));
  let s = createRun(cfg);
  for (let i = 0; i < 3000 && !s.finished; i++) s = step(deepFreeze(s), cfg);
});

test('chooseTarget: 制御OFFなら常に通常BPM', () => {
  const cfg = withEnabled(SCENARIOS.A, false);
  assert.deepEqual(chooseTarget(createRun(cfg), cfg), { targetBpm: 150, mode: 'normal' });
});

// ---------- 比較シナリオ ----------
test('シナリオA（横断20m）: 通常は20秒停止、RUNWAVEは減速して停止なし', () => {
  const { normal, runwave } = compare(SCENARIOS.A);
  assert.equal(normal.stops, 1);
  near(normal.stopTimeS, 20);
  near(normal.totalTimeS, 320, 0.11);
  assert.equal(runwave.stops, 0);
  assert.ok(runwave.minBpm >= 130 && runwave.maxBpm <= 150);
  // 回帰: 窓の境界判定の丸めで不要に深く減速しない（133 は段階調整込みの最小変化）
  assert.equal(runwave.minBpm, 133);
});

test('デモ推奨: 通常は止まり RUNWAVE は止まらない。位相±5秒でも成立', () => {
  for (const cfg of [DEMO.main, DEMO.sub]) {
    for (let d = -5; d <= 5; d++) {
      const { normal, runwave } = compare(withPhase(cfg, cfg.signal.phaseS + d));
      assert.equal(normal.stops, 1);
      assert.equal(runwave.stops, 0);
    }
  }
  const main = compare(DEMO.main);
  assert.ok(main.runwave.totalTimeS < main.normal.totalTimeS); // 加速ケースは早く着く
});

test('シナリオB: 横断20mでは回避不可で停止、点通過(0m)なら加速して停止なし', () => {
  const b20 = compare(SCENARIOS.B);
  assert.equal(b20.normal.stops, 1);
  near(b20.normal.stopTimeS, 60);
  assert.equal(b20.runwave.stops, 1);
  const b0 = compare(withCrossing(SCENARIOS.B, 0));
  assert.equal(b0.runwave.stops, 0);
  assert.ok(b0.runwave.maxBpm <= 170 && b0.runwave.minBpm >= 150);
});
