import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrate, requiredBpm, signalAt, safeGreenWindows, canEnter, limitRate, chooseTarget,
  createRun, step, simulate, compare, validateConfig, MODES,
} from './runwave-core.js';
import { SCENARIOS, DEMO, withCrossing, withModel } from './scenarios.js';

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

// 性質テストに使う条件の組み合わせ（位相・横断モデル・制御ON/OFF）
const sweep = [];
for (let phaseS = 0; phaseS < 120; phaseS += 7)
  for (const model of ['point', 'length'])
    for (const enabled of [false, true])
      sweep.push(withEnabled(withModel(withPhase(SCENARIOS.A, phaseS), model), enabled));

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
    { stepIntervalS: 0 }, { stepIntervalS: 0.05 }, { stepBpm: NaN }, { maxDeltaBpm: null },
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
  const cfg = { ...SCENARIOS.A, signal: { ...SIG, phaseS: 0 }, route: { crossingX: 1, goalX: 10 } };
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
  const cfg = { ...SCENARIOS.B, route: { crossingX: 400, goalX: 400.01 } };
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

test('走っている間も longestRunS が更新される', () => {
  let s = createRun(SCENARIOS.B);
  for (let i = 0; i < 100; i++) s = step(s, SCENARIOS.B);
  near(s.longestRunS, 10, 1e-6);
});

test('reason は今の phase と合う（待機中 waiting、通過後 passed、制御OFFは常に off）', () => {
  const off = withEnabled(SCENARIOS.B, false);
  for (const s of trace(off)) assert.equal(s.reason, 'off');
  const on = trace(withEnabled(withModel(SCENARIOS.B, 'length'), true));  // RUNWAVE でも止まる条件
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
  const b = compare(withModel(SCENARIOS.B, 'length'));
  assert.equal(b.runwave.stops, 1);
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
