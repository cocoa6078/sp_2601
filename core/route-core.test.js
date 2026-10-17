import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, signalAt } from './runwave-core.js';
import { createRouteRun, stepRoute, simulateRoute, summarizeRoute, compareRoute, validateRouteConfig, EVENT_TYPES } from './route-core.js';
import { SCENARIOS, SCENARIOS_WALK } from './scenarios.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const traceRoute = (config) => {
  const out = [createRouteRun(config)];
  while (!out.at(-1).finished && out.at(-1).tick < 40000) out.push(stepRoute(out.at(-1), config));
  return out;
};
// 1信号の config を経路の形に
const asRoute = (c) => ({ runner: c.runner, control: c.control, goalM: c.route.goalX, signals: [{ id: 's1', atM: c.route.crossingX, signal: c.signal }] });
const withControl = (c, control) => ({ ...c, control: { ...c.control, ...control } });

// API のデモ5交差点（累積距離・周期・位相はバックエンドの値。スタートは最初の交差点の300m手前）
const API = [['sapporo_3', 0, 110, 31, 74, 0], ['sapporo_8', 270, 100, 27, 68, 15], ['sapporo_2', 534, 100, 41, 54, 30], ['sapporo_1', 879, 145, 31, 109, 45], ['sapporo_5', 1255, 145, 50, 90, 60]];
const ROUTE = {
  runner: { strideM: 0.8, baseBpm: 150 },
  control: { startMarginS: 3, endMarginS: 5 },
  goalM: 300 + 1255 + 15 + 200,
  signals: API.map(([id, d, c, g, r, p]) => ({ id, atM: 300 + d, signal: { cycleS: c, greenS: g, yellowS: 5, redS: r, phaseS: p, crossingM: 15 }, meta: { source: 'api', isEstimated: true } })),
};
const withRouteControl = (control) => ({ ...ROUTE, control: { ...ROUTE.control, ...control } });

// ---------- 入力検証 ----------
test('route: 入力検証（goalM・atM の順番と重なり・id の重複・信号の形）', () => {
  const bad = [
    { ...ROUTE, goalM: 0 },
    { ...ROUTE, signals: [] },
    { ...ROUTE, signals: [ROUTE.signals[1], ROUTE.signals[0]] },                                  // 順番が逆
    { ...ROUTE, signals: [ROUTE.signals[0], { ...ROUTE.signals[1], atM: ROUTE.signals[0].atM + 10 }] },  // 横断（15m）と重なる
    { ...ROUTE, signals: [ROUTE.signals[0], { ...ROUTE.signals[1], id: ROUTE.signals[0].id }] },    // id の重複
    { ...ROUTE, goalM: 300 + 1255 + 10 },                                                           // 最後の横断の途中がゴール
    { ...ROUTE, signals: [{ ...ROUTE.signals[0], signal: { ...ROUTE.signals[0].signal, redS: 1 } }] },  // 周期が合わない
  ];
  for (const c of bad) assert.throws(() => validateRouteConfig(c), RangeError);
  assert.doesNotThrow(() => validateRouteConfig(ROUTE));
});

// ---------- 1信号の互換 ----------
test('route: 信号が1つなら、既存の compare と停止回数・停止時間・所要時間などが一致（A/B/W・早歩き無効・length）', () => {
  const cases = [SCENARIOS.A, SCENARIOS.B, SCENARIOS_WALK.W, withControl(SCENARIOS.A, { walk: { enabled: false } }),
    withControl(SCENARIOS.B, { crossingModel: 'length' })];
  for (let p = 0; p < 120; p += 13) cases.push({ ...SCENARIOS.A, signal: { ...SCENARIOS.A.signal, phaseS: p } });
  for (const c of cases) {
    const a = compare(c), b = compareRoute(asRoute(c));
    for (const k of ['normal', 'runwave']) {
      for (const key of Object.keys(a[k])) assert.deepEqual(b[k][key], a[k][key], `${key}`);
    }
  }
});

// ---------- 複数信号 ----------
test('route: 共通の時刻で進む（交差点ごとに時刻0に戻らない）。位置は増え続け、信号は順番に進む', () => {
  for (const enabled of [false, true]) {
    const tr = traceRoute(withRouteControl({ enabled }));
    for (let i = 1; i < tr.length; i++) {
      const [a, b] = [tr[i - 1], tr[i]];
      near(b.t, a.t + 0.1, 1e-9);
      assert.ok(b.x >= a.x - 1e-9);
      assert.ok(b.signalIndex >= a.signalIndex);
    }
    assert.equal(tr.at(-1).signalIndex, 5);
    assert.equal(tr.at(-1).finished, true);
  }
});

test('route: 各信号のイベントは 到着→（待ち始め→待ち終わり）→横断開始→横断終了 の順。時刻も増える', () => {
  for (const enabled of [false, true]) {
    const { state } = simulateRoute(withRouteControl({ enabled }));
    for (const sig of ROUTE.signals) {
      const types = state.events.filter((e) => e.signalId === sig.id).map((e) => e.type);
      const ok = types.join() === 'arrive,crossStart,crossEnd' || types.join() === 'arrive,waitStart,waitEnd,crossStart,crossEnd';
      assert.ok(ok, `${sig.id}: ${types}`);
    }
    for (let i = 1; i < state.events.length; i++) assert.ok(state.events[i].t >= state.events[i - 1].t);
    for (const e of state.events) assert.ok(EVENT_TYPES.includes(e.type));
  }
});

test('route: 横断に入るのは青のときだけ（signalAt と共通の時刻）。待ち終わりも青', () => {
  for (const enabled of [false, true]) {
    const { state } = simulateRoute(withRouteControl({ enabled }));
    for (const e of state.events) {
      const sig = ROUTE.signals.find((s) => s.id === e.signalId).signal;
      assert.equal(e.color, signalAt(sig, e.t).color);
      if (e.type === 'crossStart' || e.type === 'waitEnd') assert.equal(e.color, 'green', `${e.signalId} ${e.type} t=${e.t}`);
      if (e.type === 'waitStart') assert.notEqual(e.color, 'green');
    }
  }
});

test('route: 赤待ちのケースもある（通常走行）。停止時間の合計は信号ごとの待ち時間の合計と一致', () => {
  for (const enabled of [false, true]) {
    const r = simulateRoute(withRouteControl({ enabled })).summary;
    const sumWait = r.signals.reduce((a, s) => a + s.waitS, 0);
    near(r.stopTimeS, sumWait, 1e-4);   // 再開のイベント時刻は境界の判定のため 1e-6 秒だけ後ろ
    assert.equal(r.stops, r.signals.filter((s) => s.waited).length);
  }
  const normal = simulateRoute(withRouteControl({ enabled: false })).summary;
  assert.ok(normal.stops >= 1, '通常走行で赤待ちが起きる経路');
});

test('route: ステップの途中の到着を、その瞬間の時刻で記録する', () => {
  const { state } = simulateRoute(ROUTE);
  assert.ok(state.events.some((e) => e.type === 'arrive' && Math.abs(e.t * 10 - Math.round(e.t * 10)) > 1e-6));
});

test('route: RUNWAVE は通常走行より止まる回数・停止時間が増えない', () => {
  const { normal, runwave } = compareRoute(ROUTE);
  assert.ok(runwave.stops <= normal.stops);
  assert.ok(runwave.stopTimeS <= normal.stopTimeS);
});

test('route: 走りの部分は ±20・4秒/2BPM を信号をまたいでも守る（例外は 早歩きの切り替え・再開）', () => {
  const tr = traceRoute(ROUTE);
  for (let i = 1; i < tr.length; i++) {
    const [a, b] = [tr[i - 1], tr[i]];
    if (a.gait === 'walk' || b.gait === 'walk' || a.phase === 'waiting' || b.phase === 'waiting' || b.stops > a.stops) continue;
    assert.ok(b.bpm >= 130 && b.bpm <= 170);
    if (a.bpm === b.bpm) continue;
    assert.equal(a.tick % 40, 0, `t=${a.t}`);
    assert.ok(Math.abs(b.bpm - a.bpm) <= 2);
  }
});

test('route: 早歩きは横断を渡り終えたら走りに戻る。通常走行（制御OFF）は早歩きにならない', () => {
  const tr = traceRoute(ROUTE);
  for (let i = 1; i < tr.length; i++) {
    if (tr[i - 1].gait === 'walk' && tr[i].gait === 'run' && tr[i].phase !== 'waiting') assert.equal(tr[i].bpm, 150);
  }
  for (const s of traceRoute(withRouteControl({ enabled: false }))) assert.equal(s.gait, 'run');
});

test('route: 同じ入力なら同じ結果。stepRoute は入力の state を変更しない', () => {
  assert.deepEqual(simulateRoute(ROUTE), simulateRoute(structuredClone(ROUTE)));
  const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
  const cfg = deepFreeze(structuredClone(ROUTE));
  let s = createRouteRun(cfg);
  for (let i = 0; i < 3000 && !s.finished; i++) s = stepRoute(deepFreeze(s), cfg);
});

test('route: 集計に信号ごとの到着・横断・待ちと meta（source・isEstimated）が残る', () => {
  const r = simulateRoute(ROUTE).summary;
  assert.equal(r.signals.length, 5);
  for (const s of r.signals) {
    assert.ok(s.crossStartT !== null && s.crossEndT !== null && s.crossEndT > s.crossStartT);
    assert.deepEqual(s.meta, { source: 'api', isEstimated: true });
  }
  assert.ok(r.coreVersion && r.routeVersion);
});

test('route: イベントに 進めたか・待った時間・歩き方・位置 が入る（Web の表示用）', () => {
  for (const enabled of [false, true]) {
    const { state } = simulateRoute(withRouteControl({ enabled }));
    for (const e of state.events) {
      assert.ok(e.gait === 'run' || e.gait === 'walk');
      assert.equal(typeof e.atM, 'number');
      if (e.type === 'arrive') {
        const waited = state.events.some((x) => x.signalId === e.signalId && x.type === 'waitStart');
        assert.equal(e.passed, !waited);
      }
      if (e.type === 'waitEnd') {
        const ws = state.events.find((x) => x.signalId === e.signalId && x.type === 'waitStart');
        near(e.waitS, e.t - ws.t, 1e-6);
      }
    }
  }
});

test('route: compareRoute は { normal, runwave } と { off, on } の両方で同じ結果を返す', () => {
  const r = compareRoute(ROUTE);
  assert.equal(r.off, r.normal);
  assert.equal(r.on, r.runwave);
});

// ---------- 先読み ----------
const shifted = (off, ph) => ({
  ...ROUTE, goalM: off + 1255 + 15 + 200,
  signals: API.map(([id, d, c, g, r, p]) => ({ id, atM: off + d, signal: { cycleS: c, greenS: g, yellowS: 5, redS: r, phaseS: p + ph, crossingM: 15 } })),
});

test('route 先読み: デモ5交差点では、今の信号だけを見るより止まる回数が減る（2回 → 0回）', () => {
  const a = simulateRoute({ ...ROUTE, lookahead: false }).summary;
  const b = simulateRoute(ROUTE).summary;
  assert.equal(a.stops, 2);
  assert.equal(b.stops, 0);
});

test('route 先読み: スタート位置と位相を変えた経路で、止まる回数が増えない', () => {
  for (const off of [100, 250, 400]) for (const ph of [0, 30, 60]) {
    const c = shifted(off, ph);
    const a = simulateRoute({ ...c, lookahead: false }).summary, b = simulateRoute(c).summary;
    assert.ok(b.stops <= a.stops, `${off}/${ph}: ${a.stops} → ${b.stops}`);
  }
});

test('route 先読み: RUNWAVE でも赤待ちが必要な経路では待つ（非青で横断に入らない）', () => {
  let found = false;
  for (const off of [100, 150]) for (const ph of [0, 10, 30]) {
    const { state, summary } = simulateRoute(shifted(off, ph));
    if (summary.stops === 0) continue;
    found = true;
    for (const e of state.events) {
      const sig = API.find((x) => x[0] === e.signalId);
      if (e.type === 'crossStart' || e.type === 'waitEnd') assert.equal(e.color, 'green');
      if (e.type === 'waitStart') assert.notEqual(e.color, 'green');
      assert.ok(sig);
    }
  }
  assert.ok(found, 'RUNWAVE でも待つ経路がある');
});

test('route 先読み: 最後の信号（と信号1つの経路）では先読みしない。lookahead: false でも動く', () => {
  const one = asRoute(SCENARIOS.B);
  assert.deepEqual(simulateRoute(one).summary, simulateRoute({ ...one, lookahead: false }).summary);
});
