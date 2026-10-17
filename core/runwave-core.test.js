import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrate, requiredBpm, signalAt, safeGreenWindows, canEnter, limitRate, chooseTarget,
  createRun, step, simulate, compare, validateConfig, MODES,
} from './runwave-core.js';
import { SCENARIOS, DEMO, SCENARIOS_800M, DEMO_800M, SCENARIOS_WALK, withCrossing, withModel } from './scenarios.js';

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
const withControl = (config, control) => ({ ...config, control: { ...config.control, ...control } });
const noWalk = (config) => withControl(config, { walk: { enabled: false } });  // 走りのみ（v0.3 以前と同じ）を明示する

// 性質テストに使う条件の組み合わせ（位相・横断モデル・制御ON/OFF）
const sweep = [];
for (let phaseS = 0; phaseS < 120; phaseS += 7)
  for (const model of ['point', 'length'])
    for (const enabled of [false, true])
      sweep.push(withEnabled(withModel(withPhase(noWalk(SCENARIOS.A), phaseS), model), enabled));

// ---------- 手計算との一致（v4 6章） ----------
test('calibrate: 160m/200歩/80秒 → 0.8m・150BPM・2m/s', () => {
  const r = calibrate({ distanceM: 160, steps: 200, timeS: 80 });
  near(r.strideM, 0.8);
  near(r.baseBpm, 150);
  near(r.speedMps, 2);
});

test('requiredBpm: 400m・0.8m で 188秒 → 159.57、215秒 → 139.53', () => {
  near(requiredBpm(400, 0.8, 188), 159.574, 1e-3);
  near(requiredBpm(400, 0.8, 215), 139.535, 1e-3);
});

test('requiredBpm: 距離0は0、到着までの残り秒が0以下は拒否', () => {
  assert.equal(requiredBpm(0, 0.8, 10), 0);
  assert.throws(() => requiredBpm(400, 0.8, 0), RangeError);
  assert.throws(() => requiredBpm(400, 0.8, -5), RangeError);
});

// ---------- 入力検証 ----------
test('不正な入力は RangeError（NaN・Infinity・null・周期不整合）', () => {
  assert.throws(() => calibrate({ distanceM: 0, steps: 10, timeS: 5 }), RangeError);
  assert.throws(() => validateConfig({ ...SCENARIOS.A, signal: { ...SIG, redS: 60 } }), RangeError);
  assert.throws(() => validateConfig({ ...SCENARIOS.A, runner: { strideM: 0.8, baseBpm: NaN } }), RangeError);
  assert.throws(() => validateConfig({ ...SCENARIOS.A, runner: { strideM: Infinity, baseBpm: 150 } }), RangeError);
  assert.throws(() => validateConfig({ ...SCENARIOS.A, signal: { ...SIG, phaseS: null } }), RangeError);
});

test('不正な control・dt を拒否する', () => {
  for (const bad of [
    { stepIntervalS: 0 }, { stepIntervalS: 0.05 }, { stepBpm: NaN }, { maxDeltaBpm: null }, { horizonS: null },
    { startMarginS: Infinity }, { targetIntervalS: -1 }, { enabled: 'yes' }, { crossingModel: 'zone' },
  ]) assert.throws(() => validateConfig(withControl(SCENARIOS.A, bad)), RangeError, JSON.stringify(bad));
  assert.throws(() => validateConfig({ ...SCENARIOS.A, dt: 0.05 }), RangeError);
  assert.doesNotThrow(() => validateConfig({ ...SCENARIOS.A, dt: 0.1 }));
  assert.throws(() => simulate(SCENARIOS.A, { maxTimeS: NaN }), RangeError);
});

test('signalAt・safeGreenWindows は不正な引数を拒否する', () => {
  assert.throws(() => signalAt(SIG, NaN), RangeError);
  assert.throws(() => signalAt({ ...SIG, cycleS: 0 }, 0), RangeError);
  assert.throws(() => safeGreenWindows(SIG, 10, 5), RangeError);
});

// ---------- 信号（位相・境界） ----------
test('signalAt: 位相0で t=0 青、50 から青点滅、55 赤、120 青（半開区間）', () => {
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

test('signalAt: 非0位相・複数周期後・負や周期超えの位相', () => {
  assert.equal(signalAt({ ...SIG, phaseS: 20 }, 100).color, 'green');   // 100+20=120 → 0秒目
  assert.equal(signalAt({ ...SIG, phaseS: 20 }, 99.9).color, 'red');
  assert.equal(signalAt({ ...SIG, phaseS: -10 }, 0).color, 'red');      // 110秒目
  assert.equal(signalAt({ ...SIG, phaseS: 250 }, 0).color, 'green');    // 10秒目
  assert.equal(signalAt(SIG, 120 * 7 + 50).color, 'flashing');          // 7周期後
  assert.equal(signalAt(SIG, 500 / 10).color, 'flashing');
});

test('safeGreenWindows: [青開始+3, 青終了−横断時間−5)', () => {
  const ws = safeGreenWindows({ ...SIG, phaseS: 20 }, 0, 300, { startMarginS: 3, endMarginS: 5, crossTimeS: 10 });
  // t=0 より前に始まった青（−20〜30秒）の窓は fromT で切り詰めて返す
  assert.deepEqual(ws, [{ startT: 0, endT: 15 }, { startT: 103, endT: 135 }, { startT: 223, endT: 255 }]);
  // point モデル（横断時間0）
  assert.deepEqual(safeGreenWindows({ ...SIG, phaseS: 20 }, 100, 200, { startMarginS: 3, endMarginS: 5 }), [{ startT: 103, endT: 145 }]);
  // 余裕で潰れる青は返さない
  assert.deepEqual(safeGreenWindows({ ...SIG, greenS: 10, redS: 105 }, 0, 100, { crossTimeS: 5 }), []);
});

// ---------- BPM制限 ----------
test('limitRate: t=0 と 4秒の倍数以外では変えない。1回最大2', () => {
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

test('走行中のBPMは±20以内、変化は4秒の倍数で1回2以内。待機中は0、再開は通常BPMへ即時（例外）', () => {
  for (const cfg of sweep) {
    const tr = trace(cfg);
    const base = cfg.runner.baseBpm;
    for (let i = 1; i < tr.length; i++) {
      const [a, b] = [tr[i - 1], tr[i]];
      if (b.phase === 'waiting') { assert.equal(b.bpm, 0); continue; }
      assert.ok(b.bpm >= base - 20 && b.bpm <= base + 20);
      if (a.phase === 'waiting' || b.stops > a.stops) { assert.equal(b.bpm, base); continue; } // 再開の例外（同じステップ内の停止→再開も含む）
      if (a.bpm === b.bpm) continue;
      assert.equal(a.tick % 40, 0, `t=${a.t} で変化`);
      assert.ok(a.tick > 0);
      assert.ok(Math.abs(b.bpm - a.bpm) <= 2);
    }
  }
});

test('目標の再計算は1秒ごと（それ以外の時刻で targetBpm が変わらない）', () => {
  for (const cfg of [SCENARIOS.A, SCENARIOS.B, DEMO.sub]) {
    const tr = trace(cfg);
    for (let i = 1; i < tr.length; i++) {
      const [a, b] = [tr[i - 1], tr[i]];
      if (a.targetBpm !== b.targetBpm && a.phase === 'approach') assert.equal(a.tick % 10, 0, `t=${a.t}`);
    }
  }
});

// ---------- 横断の判定（モデル上） ----------
test('青点滅・赤のときに横断地点を通過しない。停止→再開、停止回数が正しい', () => {
  for (const cfg of sweep) {
    const tr = trace(cfg);
    const { crossingX } = cfg.route;
    let stops = 0;
    for (let i = 1; i < tr.length; i++) {
      const [a, b] = [tr[i - 1], tr[i]];
      if (a.phase !== 'waiting' && b.phase === 'waiting') stops++;
      if (a.phase === 'waiting' && b.phase !== 'waiting') {
        assert.equal(signalAt(cfg.signal, a.t).color, 'green', `再開 t=${a.t}`);
      }
      if (a.phase === 'approach' && b.x > crossingX) {
        const arriveT = a.t + (crossingX - a.x) / (cfg.runner.strideM * b.bpm / 60);
        assert.equal(signalAt(cfg.signal, arriveT).color, 'green', `通過 t=${arriveT}`);
      }
      if (b.phase === 'crossing') assert.equal(b.signal.color, 'green', `横断中 t=${b.t}`);
      assert.ok(b.x <= cfg.route.goalX);
    }
    assert.equal(tr.at(-1).stops, stops);
  }
});

test('point モデルでは横断長を使わない（横断長を変えても結果が同じ）', () => {
  assert.deepEqual(compare(withCrossing(SCENARIOS.B, 0)), compare(withCrossing(SCENARIOS.B, 15)));
});

test('ゴールで mode・phase が finished、その後の step は同じ state を返す', () => {
  const { state } = simulate(SCENARIOS.A);
  assert.equal(state.finished, true);
  assert.equal(state.mode, 'finished');
  assert.ok(MODES.includes(state.mode));
  assert.equal(step(state, SCENARIOS.A), state);
});

test('上限時間までにゴールしなければ timeLimit。待機中の時間も停止時間に含める', () => {
  // 青の無い信号は無いので、上限を短くして待機中に打ち切る（通常走行は200秒で横断地点、t=200〜220 待機）
  const { summary } = simulate(withEnabled(SCENARIOS.A, false), { maxTimeS: 210 });
  assert.equal(summary.finished, false);
  assert.equal(summary.termination, 'timeLimit');
  assert.equal(summary.totalTimeS, null);
  near(summary.stopTimeS, 10, 0.11);
});

// ---------- v4 レビューで見つかった不具合の回帰テスト ----------
test('横断地点とゴールが同じ位置の config は拒否（赤で止まったままゴールにならない）', () => {
  assert.throws(() => validateConfig({ ...SCENARIOS.A, route: { crossingX: 400, goalX: 400 } }), RangeError);
});

test('待機中、ステップの途中で始まる短い青でも再開し、停止時間を正しく数える', () => {
  // 周期1秒・青0.02秒・位相0.95、横断地点0.04m・2m/s → 0.02秒に赤で停止、0.05秒に青
  const cfg = {
    signal: { cycleS: 1, greenS: 0.02, yellowS: 0, redS: 0.98, phaseS: 0.95, crossingM: 0 },
    runner: { strideM: 0.8, baseBpm: 150 },
    route: { crossingX: 0.04, goalX: 1 },
    control: { enabled: false },
  };
  const { summary } = simulate(cfg, { maxTimeS: 5 });
  assert.equal(summary.termination, 'finished');
  assert.equal(summary.stops, 1);
  near(summary.stopTimeS, 0.03, 1e-6);
});

test('公開関数は null・負の値・NaN を拒否する', () => {
  assert.throws(() => safeGreenWindows(SIG, 0, 100, { startMarginS: null }), RangeError);
  assert.throws(() => canEnter(SIG, 0, -1), RangeError);
  assert.throws(() => limitRate(NaN, 150, { tick: 40 }, SCENARIOS.A), RangeError);
  assert.throws(() => limitRate(150, 150, { tick: 0.5 }, SCENARIOS.A), RangeError);
});

test('巨大な位相でも安全窓の探索が終わる', () => {
  const ws = safeGreenWindows({ ...SIG, phaseS: 1e20 }, 0, 300);
  assert.ok(Array.isArray(ws) && ws.length >= 2);
});

// ---------- 再現性・純粋性 ----------
test('同じ入力なら同じ結果。通常と制御ありの差は enabled だけ', () => {
  for (const cfg of sweep.slice(0, 8)) assert.deepEqual(simulate(cfg), simulate(structuredClone(cfg)));
  const r = compare(SCENARIOS.A);
  assert.equal(r.normal.enabled, false);
  assert.equal(r.runwave.enabled, true);
});

test('step は入力の state を変更しない', () => {
  const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
  const cfg = deepFreeze(structuredClone(SCENARIOS.B));
  let s = createRun(cfg);
  for (let i = 0; i < 3000 && !s.finished; i++) s = step(deepFreeze(s), cfg);
});

test('chooseTarget: 制御OFFなら常に通常BPM', () => {
  const cfg = withEnabled(SCENARIOS.A, false);
  assert.deepEqual(chooseTarget(createRun(cfg), cfg), { targetBpm: 150, mode: 'normal', reason: 'off' });
});

// ---------- アルゴリズム修正（v0.3.0）の回帰テスト ----------
test('横断地点が遠くても、通常で止まらないなら加速しない（予測範囲を距離から決める）', () => {
  for (const crossingX of [600, 1000, 1500]) {
    const cfg = { ...SCENARIOS.A, route: { crossingX, goalX: crossingX + 200 } };
    const { normal, runwave } = compare(cfg);
    if (normal.stops === 0) assert.equal(runwave.maxBpm, 150, `${crossingX}m`);
    assert.equal(chooseTarget(createRun(cfg), cfg).mode === 'stopRecommended' && normal.stops === 0, false, `${crossingX}m で誤った停止推奨`);
  }
});

test('遠い横断地点でも RUNWAVE の停止が増えない（全位相）', () => {
  let nStops = 0, rStops = 0;
  for (let p = 0; p < 120; p += 3) {
    const cfg = withPhase({ ...SCENARIOS.A, route: { crossingX: 800, goalX: 1000 } }, p);
    const r = compare(cfg);
    nStops += r.normal.stops; rStops += r.runwave.stops;
    assert.ok(r.runwave.stops <= r.normal.stops, `位相${p}`);
  }
  assert.ok(rStops < nStops);
});

test('「停止推奨」は本当に止まるときだけ。余裕は無いが青に着くときは reason=noMargin', () => {
  const cfg = noWalk({ ...SCENARIOS.A, signal: { ...SIG, phaseS: 0 }, route: { crossingX: 1, goalX: 10 } });
  const d = chooseTarget(createRun(cfg), cfg);
  assert.equal(d.reason, 'noMargin');
  assert.notEqual(d.mode, 'stopRecommended');
  assert.equal(simulate(cfg).summary.stops, 0);
  // 停止推奨のときは、実際に止まる
  for (let p = 0; p < 120; p += 5) {
    const c = withPhase(SCENARIOS.A, p);
    const tr = trace(c);
    if (tr.some((s) => s.mode === 'stopRecommended')) assert.ok(tr.at(-1).stops > 0, `位相${p}`);
  }
});

test('赤の終わりのごく手前を青と判定しない（判定は丸めない）', () => {
  assert.equal(signalAt(SIG, 119.9999996).color, 'red');
  assert.equal(canEnter(SIG, 119.9999996), false);
  assert.equal(signalAt(SIG, 120 - 1e-14).color, 'red');            // 剰余の計算で周期に丸まる値
  assert.equal(canEnter(SIG, 120 - 1e-14), false);
  assert.equal(signalAt({ ...SIG, phaseS: -1e-14 }, 0).color, 'red'); // 負の位相
  assert.equal(signalAt(SIG, 240).color, 'green');
  assert.equal(signalAt(SIG, 120).color, 'green');
});

test('ゴール時刻は到達した瞬間（手計算と一致）', () => {
  const cfg = {
    signal: { cycleS: 100, greenS: 100, yellowS: 0, redS: 0, phaseS: 0, crossingM: 0 },
    runner: { strideM: 0.8, baseBpm: 150 }, route: { crossingX: 300, goalX: 600 }, control: { enabled: false },
  };
  near(simulate(cfg).summary.totalTimeS, 300, 1e-6);
  near(simulate({ ...cfg, route: { crossingX: 100, goalX: 201 } }).summary.totalTimeS, 100.5, 1e-6);
});

test('リズムの指標：通常走行はずれ0、RUNWAVE は止まらずにゴールまで走れる', () => {
  const { normal, runwave } = compare(SCENARIOS.B);
  assert.equal(normal.deviationBpmS, 0);
  assert.equal(normal.offBaseTimeS, 0);
  near(normal.longestRunS, 200, 0.11);           // スタート→横断地点で停止
  assert.ok(runwave.deviationBpmS > 0 && runwave.offBaseTimeS > 0);
  near(runwave.longestRunS, runwave.totalTimeS);  // 一度も止まらない
});

test('リズムの指標はゴールの瞬間までだけ数える', () => {
  // B のゴールを 400.01m にすると、最後のステップの途中（161BPM 走行中）でゴールする
  const cfg = noWalk({ ...SCENARIOS.B, route: { crossingX: 400, goalX: 400.01 } });
  const tr = trace(cfg);
  const last = tr.at(-1);
  // 各ステップの実際の走行時間（最後だけはゴールの瞬間まで）× そのステップの BPM のずれ
  let dev = 0, off = 0;
  for (let i = 1; i < tr.length; i++) {
    const dur = i === tr.length - 1 ? last.finishTimeS - tr[i - 1].t : 0.1;
    const d = Math.abs(tr[i].bpm - 150);
    dev += d * dur;
    if (d > 0) off += dur;
  }
  assert.ok(last.finishTimeS - tr.at(-2).t < 0.1 - 1e-6, 'ステップの途中でゴールする条件になっていない');
  near(last.deviationBpmS, dev, 1e-6);
  near(last.offBaseTimeS, off, 1e-6);
});

test('余裕0でも、計画どおりに着けるなら止まらない（窓の端ぎりぎりの到着を避ける）', () => {
  // 余裕0では、届く範囲に青があるのに止まる位相が出ていた（v0.3.0 初版、例: 位相93）
  const m0 = (p) => withControl(withPhase(noWalk(SCENARIOS.A), p), { startMarginS: 0, endMarginS: 0 });
  for (const p of [93, 94, 98, 99, 100, 103, 104, 107, 108]) assert.equal(compare(m0(p)).runwave.stops, 0, `位相${p}`);
  let stops = 0;
  for (let p = 0; p < 120; p++) stops += compare(m0(p)).runwave.stops;
  assert.equal(stops, 22);  // 届く範囲に青が無い位相の数（理論値）
});

test('走っている間も longestRunS が更新される', () => {
  let s = createRun(SCENARIOS.B);
  for (let i = 0; i < 100; i++) s = step(s, SCENARIOS.B);
  near(s.longestRunS, 10, 1e-6);
});

test('reason は今の phase と合う（待機中 waiting、通過後 passed、制御OFFは常に off）', () => {
  const off = withEnabled(noWalk(SCENARIOS.B), false);
  for (const s of trace(off)) assert.equal(s.reason, 'off');
  const on = trace(withEnabled(withModel(noWalk(SCENARIOS.B), 'length'), true));  // RUNWAVE でも止まる条件
  for (const s of on.slice(1)) {
    if (s.phase === 'waiting') assert.equal(s.reason, 'waiting');
    else if (s.phase !== 'approach') assert.equal(s.reason, 'passed');
  }
  assert.ok(on.some((s) => s.reason === 'unavoidable'));
});

// ---------- 比較シナリオ（v4 5章、point モデル） ----------
test('シナリオA: 通常は20秒停止、RUNWAVE は減速して停止なし（総時間は少し長い）', () => {
  const { normal, runwave } = compare(SCENARIOS.A);
  assert.equal(normal.stops, 1);
  near(normal.stopTimeS, 20);
  near(normal.totalTimeS, 320, 0.11);
  assert.equal(runwave.stops, 0);
  assert.ok(runwave.minBpm >= 130 && runwave.maxBpm <= 150);
  assert.equal(runwave.minBpm, 133);
});

test('シナリオB: 通常は60秒停止、RUNWAVE は加速して停止なし', () => {
  const { normal, runwave } = compare(SCENARIOS.B);
  assert.equal(normal.stops, 1);
  near(normal.stopTimeS, 60);
  assert.equal(runwave.stops, 0);
  assert.ok(runwave.minBpm >= 150 && runwave.maxBpm <= 170);
  assert.ok(runwave.totalTimeS < normal.totalTimeS);
});

test('length モデル（拡張）: シナリオB は横断20mだと回避できない', () => {
  const b = compare(withModel(noWalk(SCENARIOS.B), 'length'));
  assert.equal(b.runwave.stops, 1);
  // 既定（早歩き有効）では早歩きでつないで止まらない（変更前: 停止1回・60秒・総時間360秒 → 変更後: 停止0回・総時間366.77秒・早歩き1回）
  const w = compare(withModel(SCENARIOS.B, 'length'));
  assert.equal(w.runwave.stops, 0);
  assert.equal(w.runwave.walkCount, 1);
  near(w.runwave.totalTimeS, 366.766792, 1e-3);
});

test('デモ推奨: 通常は止まり RUNWAVE は止まらない。位相±5秒でも成立', () => {
  for (const cfg of [DEMO.main, DEMO.sub]) {
    for (let d = -5; d <= 5; d++) {
      const { normal, runwave } = compare(withPhase(cfg, cfg.signal.phaseS + d));
      assert.equal(normal.stops, 1);
      assert.equal(runwave.stops, 0);
    }
  }
});

// ---------- 改定案のシナリオ（800m・余裕3/8秒・横断長15m） ----------
test('改定案 A: 通常は21秒停止、RUNWAVE は減速して停止なし', () => {
  const { normal, runwave } = compare(SCENARIOS_800M.A);
  assert.equal(normal.stops, 1);
  near(normal.stopTimeS, 21);
  near(normal.totalTimeS, 521, 0.11);
  assert.equal(runwave.stops, 0);
  assert.equal(runwave.minBpm, 141);
  assert.equal(runwave.maxBpm, 150);
});

test('改定案 B: 通常は56秒停止、RUNWAVE は加速して停止なし', () => {
  const { normal, runwave } = compare(SCENARIOS_800M.B);
  assert.equal(normal.stops, 1);
  near(normal.stopTimeS, 56);
  assert.equal(runwave.stops, 0);
  assert.ok(runwave.minBpm >= 150 && runwave.maxBpm <= 170);
});

test('改定案: 全位相・両モデルで RUNWAVE は止まらない', () => {
  for (const model of ['point', 'length']) {
    for (let p = 0; p < 120; p++) assert.equal(compare(withModel(withPhase(SCENARIOS_800M.A, p), model)).runwave.stops, 0, `${model} 位相${p}`);
  }
});

test('改定案: 通過するときに、15m を渡り切る以上の青が残っている（終了前8秒の余裕）', () => {
  for (let p = 0; p < 120; p++) {
    const cfg = withPhase(SCENARIOS_800M.A, p);
    const tr = trace(cfg);
    const i = tr.findIndex((s, k) => k > 0 && tr[k - 1].phase === 'approach' && s.phase !== 'approach');
    if (tr[i].phase === 'waiting' || tr[i].stops > tr[i - 1].stops) continue;
    const v = 0.8 * tr[i].bpm / 60;
    const at = tr[i - 1].t + (cfg.route.crossingX - tr[i - 1].x) / v;
    const left = signalAt(cfg.signal, at).remainingS;
    assert.ok(left >= 15 / v, `位相${p}: 青の残り ${left} < 横断 ${(15 / v).toFixed(2)}`);
  }
});

test('改定案のデモ: 通常は止まり RUNWAVE は止まらない。位相±5秒でも成立', () => {
  for (const cfg of [DEMO_800M.main, DEMO_800M.sub]) {
    for (let d = -5; d <= 5; d++) {
      const { normal, runwave } = compare(withPhase(cfg, cfg.signal.phaseS + d));
      assert.equal(normal.stops, 1);
      assert.equal(runwave.stops, 0);
    }
  }
});

// ---------- 早歩きフェーズ（v0.4.0） ----------
const W400 = noWalk(withCrossing(SCENARIOS.A, 15));  // 400m・余裕3/5秒・横断長15m（走りだけでは止まる位相がある）
const WALK = { walk: { enabled: true } };
const walkCfg = (p, extra = {}) => withControl(withPhase(W400, p), { ...WALK, ...extra });

test('早歩き：手計算と一致（400m を 5.3km/h で 271.7秒・5.8km/h で 248.3秒、15m 横断 10.2秒、歩/分の目安）', () => {
  // 時間 = 距離 ÷ 速さ（km/h ÷ 3.6）、歩/分の目安 = 速さ(m/s)×60÷歩幅0.75m
  const t = (d, kmh) => d / (kmh / 3.6);
  near(t(400, 5.3), 271.698, 1e-3);
  near(t(400, 5.8), 248.276, 1e-3);
  near(t(15, 5.3), 10.189, 1e-3);
  // core の state でも同じ式になっている（早歩き中の bpm）
  const tr = trace(walkCfg(0));
  const w = tr.find((s) => s.gait === 'walk');
  near(w.bpm, (w.targetSpeedKmh / 3.6) * 60 / 0.75, 1e-3);
  near(5.3 / 3.6 * 60 / 0.75, 117.778, 1e-3);
  near(5.8 / 3.6 * 60 / 0.75, 128.889, 1e-3);
});

test('早歩き：walk.enabled=false なら、今までと完全に同じ（state に新しい項目も無い）', () => {
  for (let p = 0; p < 120; p += 7) {
    const cfg = withPhase(W400, p);
    assert.deepEqual(simulate(withControl(cfg, { walk: { enabled: false, minKmh: 5.0, maxKmh: 5.5 } })), simulate(withControl(cfg, { walk: { enabled: false } })));
  }
  assert.equal('gait' in createRun(W400), false);
});

test('早歩き：入力検証（速さの範囲・刻み・歩幅・ゴールの位置）', () => {
  for (const walk of [{ minKmh: 6, maxKmh: 5 }, { minKmh: 0, maxKmh: 5 }, { maxKmh: 6.3 }, { stepKmh: 0 }, { enabled: 'yes' }]) {
    assert.throws(() => validateConfig(withControl(W400, { walk: { enabled: true, ...walk } })), RangeError, JSON.stringify(walk));
  }
  assert.throws(() => validateConfig({ ...withControl(W400, WALK), runner: { strideM: 0.8, baseBpm: 150, walkStrideM: -1 } }), RangeError);
  assert.throws(() => validateConfig({ ...withControl(W400, WALK), route: { crossingX: 400, goalX: 410 } }), RangeError);  // 横断の途中がゴール
});

test('早歩き：400m・全位相で止まらない（point・length）', () => {
  for (const model of ['point', 'length']) {
    let stops = 0, walks = 0;
    for (let p = 0; p < 120; p++) {
      const r = compare(withModel(walkCfg(p), model)).runwave;
      stops += r.stops;
      walks += r.walkCount;
    }
    assert.equal(stops, 0, model);
    assert.ok(walks > 0, model);
  }
});

test('早歩き：速さは常に 5.3〜5.8km/h、歩/分は式どおり、横断地点では「横断時間＋終了前の余裕」以上の青が残る', () => {
  for (let p = 0; p < 120; p++) {
    const cfg = walkCfg(p);
    const tr = trace(cfg);
    for (let i = 1; i < tr.length; i++) {
      const [a, b] = [tr[i - 1], tr[i]];
      if (b.gait === 'walk') {
        assert.ok(b.targetSpeedKmh >= 5.3 - 1e-9 && b.targetSpeedKmh <= 5.8 + 1e-9, `位相${p}`);
        near(b.bpm, b.targetSpeedKmh / 3.6 * 60 / 0.75, 1e-3);
        near(b.speedMps, b.targetSpeedKmh / 3.6, 1e-9);
      }
      if (a.phase === 'approach' && b.phase !== 'approach' && a.gait === 'walk' && b.stops === a.stops) {
        const v = a.targetSpeedKmh / 3.6;
        const at = a.t + (cfg.route.crossingX - a.x) / v;
        const sig = signalAt(cfg.signal, at);
        assert.equal(sig.color, 'green', `位相${p}`);
        assert.ok(sig.remainingS >= 15 / v + 5 - 1e-3, `位相${p}: 青の残り ${sig.remainingS}`);
      }
    }
  }
});

test('早歩き：走りの部分は ±20・4秒/2BPM を守る（例外は 走り→早歩き・早歩き→走り・再開 だけ）。非青では通過しない', () => {
  for (let p = 0; p < 120; p += 2) {
    const cfg = walkCfg(p);
    const tr = trace(cfg);
    for (let i = 1; i < tr.length; i++) {
      const [a, b] = [tr[i - 1], tr[i]];
      if (a.phase === 'approach' && b.x > cfg.route.crossingX) {
        const v = a.gait === 'walk' ? a.targetSpeedKmh / 3.6 : 0.8 * b.bpm / 60;
        assert.equal(signalAt(cfg.signal, a.t + (cfg.route.crossingX - a.x) / v).color, 'green', `位相${p}`);
      }
      if (a.gait === 'walk' || b.gait === 'walk' || b.phase === 'waiting') continue;
      assert.ok(b.bpm >= 130 && b.bpm <= 170);
      if (a.phase === 'waiting' || b.stops > a.stops || a.bpm === b.bpm) continue;
      assert.equal(a.tick % 40, 0, `位相${p} t=${a.t}`);
      assert.ok(Math.abs(b.bpm - a.bpm) <= 2);
    }
  }
});

test('早歩き：横断を渡り終えたら通常BPMの走りに戻る。集計（回数・時間・距離）が合う', () => {
  for (const p of [0, 5, 110]) {
    const tr = trace(walkCfg(p));
    const last = tr.at(-1);
    assert.equal(last.walkCount, 1);
    assert.equal(last.gait, 'run');
    const lastWalk = tr.findLastIndex((s) => s.gait === 'walk');
    assert.equal(tr[lastWalk + 1].bpm, 150);
    assert.ok(tr[lastWalk + 1].x >= 400 + 15 - 1e-6);
    // 平均の速さが早歩きの範囲に入る
    const avg = last.walkDistanceM / last.walkTimeS * 3.6;
    assert.ok(avg >= 5.3 - 1e-3 && avg <= 5.8 + 1e-3, `位相${p}: 平均 ${avg}`);  // 時間・距離の丸め（小数6桁）の誤差を許す
    assert.ok(last.walkDistanceM >= 15);
    assert.ok(last.walkMinBpm >= 117.7 && last.walkMaxBpm <= 129);
  }
});

test('早歩き：走りだけで間に合う位相（停止推奨にならない）では、結果が今と同じ', () => {
  for (let p = 0; p < 120; p++) {
    const plain = trace(withPhase(W400, p));
    if (plain.some((s) => s.mode === 'stopRecommended')) continue;
    const a = compare(withPhase(W400, p)).runwave;
    const { walkCount, walkTimeS, walkDistanceM, walkMinBpm, walkMaxBpm, ...b } = compare(walkCfg(p)).runwave;
    assert.deepEqual(b, a, `位相${p}`);
    assert.equal(walkCount, 0);
  }
});

test('早歩き：通常走行（制御OFF）は早歩きにならない。同じ入力なら同じ結果', () => {
  for (let p = 0; p < 120; p += 5) {
    const off = withEnabled(walkCfg(p), false);
    for (const s of trace(off)) assert.equal(s.gait, 'run');
    assert.deepEqual(simulate(walkCfg(p)), simulate(structuredClone(walkCfg(p))));
  }
});

test('早歩きのシナリオ W：走りだけでは35秒止まるが、早歩きでつないで止まらない', () => {
  const c = SCENARIOS_WALK.W;
  const runOnly = compare(withControl(c, { walk: { enabled: false } })).runwave;
  const { normal, runwave } = compare(c);
  assert.equal(normal.stops, 1);
  assert.equal(runOnly.stops, 1);
  near(runOnly.stopTimeS, 35);
  assert.equal(runwave.stops, 0);
  assert.equal(runwave.walkCount, 1);
});

test('route.arriveWindow: 指定が無ければ従来どおり。指定すればその時間帯に着く（無理なら従来の選び方に戻る）', () => {
  const base = SCENARIOS.A;
  const s0 = simulate(base).state;
  const arrive = (st) => st.history.find((h) => h.x >= base.route.crossingX)?.t;
  // 従来の到着より遅い時間帯を指定（同じ青の中）
  const win = { startT: 230, endT: 240 };
  const s1 = simulate({ ...base, route: { ...base.route, arriveWindow: win } }).state;
  assert.equal(s1.stops, 0);
  const t1 = arrive(s1);
  assert.ok(t1 >= win.startT - 1 && t1 <= win.endT + 1, `到着 ${t1}`);
  assert.notEqual(arrive(s0), t1);
  // 届かない時間帯なら従来と同じ
  const s2 = simulate({ ...base, route: { ...base.route, arriveWindow: { startT: 10, endT: 11 } } }).state;
  assert.equal(s2.finishTimeS, s0.finishTimeS);
  assert.equal(s2.stops, s0.stops);
});
