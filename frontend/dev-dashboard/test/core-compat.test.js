// core が変わっても、ダッシュボードが壊れず・新しいものが表示に出ることのテスト（偽の名前空間で確認する）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as realCore from '../../../core/runwave-core.js';
import * as realScenarios from '../../../core/scenarios.js';
import * as realAdapter from '../../../core/api-adapter.js';
import {
  KNOWN_STATE_KEYS,
  UNKNOWN_SCENARIO_NOTE,
  buildScenarios,
  checkCoreContract,
  defaultScenarioId,
  describeExports,
  extraSummaryRows,
  formatValue,
  stateRows,
  unknownKeys,
} from '../src/core-compat.js';
import { createPair, modeLabel, sameValue, stepPair, verifyPair, advance, FIXED_SCENARIOS, DEFAULT_SCENARIO_ID } from '../src/sim-engine.js';
import { extraConfigEntries, configToForm, parseForm } from '../src/config-form.js';

const real = { SCENARIOS: realScenarios.SCENARIOS, DEMO: realScenarios.DEMO, withModel: realScenarios.withModel, validate: realCore.validateConfig };
const clone = (o) => JSON.parse(JSON.stringify(o));
const plainCore = () => ({ ...realCore }); // 名前空間は読み取り専用なので、コピーして加工する
const extra = { adapter: { ...realAdapter }, scenarios: { ...realScenarios } };

/* ---------- シナリオの自動生成 ---------- */
test('buildScenarios: 本物の core から A / B / B-length / DEMO.sub を作り、DEMO.main（= B）は重複除去する', () => {
  const { scenarios, problems } = buildScenarios(real);
  assert.deepEqual(problems, []);
  assert.deepEqual(scenarios.map((s) => s.id), ['A', 'B', 'B-length', 'DEMO.sub']);
  assert.equal(defaultScenarioId(scenarios), 'B');
  const bl = scenarios.find((s) => s.id === 'B-length');
  assert.equal(bl.config.control.crossingModel, 'length');
  assert.match(bl.title, /length・横断20m/);
  assert.match(scenarios.find((s) => s.id === 'A').title, /phaseS=20・point/);
  assert.ok(scenarios.every((s) => s.config.control.crossingModel), '指定なしは point が入る');
  assert.equal(scenarios.find((s) => s.id === 'A').config.control.crossingModel, 'point');
  // sim-engine が実際に使っている一覧も同じ
  assert.deepEqual(FIXED_SCENARIOS.map((s) => s.id), ['A', 'B', 'B-length', 'DEMO.sub']);
  assert.equal(DEFAULT_SCENARIO_ID, 'B');
});

test('buildScenarios: SCENARIOS に C を足すと自動で出る（未知の ID は「追加されたシナリオ」の文言）', () => {
  const SCENARIOS = { ...realScenarios.SCENARIOS, C: { ...clone(realScenarios.SCENARIOS.A), signal: { ...realScenarios.SCENARIOS.A.signal, phaseS: 60 } } };
  const { scenarios } = buildScenarios({ ...real, SCENARIOS });
  const c = scenarios.find((s) => s.id === 'C');
  assert.ok(c);
  assert.equal(c.expectNote, UNKNOWN_SCENARIO_NOTE);
  assert.equal(c.known, false);
  assert.match(c.title, /C（phaseS=60・point）/);
  assert.equal(scenarios.find((s) => s.id === 'A').known, true);
  // 新しい DEMO のキーも出る。DEMO.main が B と同一オブジェクトなら重複しない
  const DEMO = { main: SCENARIOS.B, sub: realScenarios.DEMO.sub, extra: clone(SCENARIOS.C) };
  const ids = buildScenarios({ ...real, SCENARIOS, DEMO }).scenarios.map((s) => s.id);
  assert.ok(ids.includes('DEMO.extra'));
  assert.ok(!ids.includes('DEMO.main'));
  assert.equal(ids.filter((i) => i === 'B').length, 1);
});

test('buildScenarios: config の crossingModel は尊重する。B が length なら B-length を足さず、B が無ければ作らない', () => {
  const lengthB = { ...clone(realScenarios.SCENARIOS.B), control: { ...realScenarios.SCENARIOS.B.control, crossingModel: 'length' } };
  const r1 = buildScenarios({ ...real, SCENARIOS: { A: realScenarios.SCENARIOS.A, B: lengthB }, DEMO: {} });
  assert.deepEqual(r1.scenarios.map((s) => s.id), ['A', 'B']);
  assert.equal(r1.scenarios[1].config.control.crossingModel, 'length');
  const r2 = buildScenarios({ ...real, SCENARIOS: { A: realScenarios.SCENARIOS.A }, DEMO: {} });
  assert.deepEqual(r2.scenarios.map((s) => s.id), ['A']);
});

test('buildScenarios: 不正な形・export 欠落でも例外にならず、理由を返す', () => {
  assert.doesNotThrow(() => buildScenarios());
  assert.doesNotThrow(() => buildScenarios({}));
  const none = buildScenarios({});
  assert.deepEqual(none.scenarios, []);
  assert.ok(none.problems.some((p) => /SCENARIOS/.test(p)));

  const bad = buildScenarios({
    ...real,
    SCENARIOS: { A: realScenarios.SCENARIOS.A, X: null, Y: 'text', Z: { signal: {} }, W: { ...clone(realScenarios.SCENARIOS.A), signal: { ...realScenarios.SCENARIOS.A.signal, cycleS: 99 } } },
    DEMO: 'not-object',
  });
  assert.deepEqual(bad.scenarios.map((s) => s.id), ['A']);
  assert.ok(bad.problems.some((p) => /SCENARIOS\.X/.test(p)));
  assert.ok(bad.problems.some((p) => /SCENARIOS\.Z/.test(p)));
  assert.ok(bad.problems.some((p) => /^W: core の検証に通らない/.test(p)));
  assert.ok(bad.problems.some((p) => /DEMO がオブジェクトではない/.test(p)));

  // withModel が無い・壊れていても動く
  const noWm = buildScenarios({ ...real, withModel: undefined });
  assert.deepEqual(noWm.scenarios.map((s) => s.id), ['A', 'B', 'B-length', 'DEMO.sub']);
  const throwingWm = buildScenarios({ ...real, withModel: () => { throw new Error('boom'); } });
  assert.equal(throwingWm.scenarios.length, 4);
  assert.equal(defaultScenarioId([]), null);
});

/* ---------- 契約チェック ---------- */
test('checkCoreContract: 本物の core・api-adapter・scenarios では不足なし', () => {
  const r = checkCoreContract(realCore, extra);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.features, { sim: true, form: true, preview: true, api: true, scenarios: true });
  // 名前空間そのまま（コピーなし）でも同じ
  assert.equal(checkCoreContract(realCore).ok, true);
});

test('checkCoreContract: export の欠落を検出し、該当機能だけ無効にする', () => {
  const noStep = plainCore();
  delete noStep.step;
  const r1 = checkCoreContract(noStep, extra);
  assert.equal(r1.ok, false);
  assert.ok(r1.missing.some((m) => m.startsWith('step')));
  assert.equal(r1.features.sim, false);
  assert.equal(r1.features.form, true, 'フォームは動き続ける');
  assert.equal(r1.features.api, true);

  const noSpeed = plainCore();
  delete noSpeed.speedOf;
  const r2 = checkCoreContract(noSpeed, extra);
  assert.deepEqual([r2.features.preview, r2.features.sim], [false, true]);

  const noValidate = plainCore();
  delete noValidate.validateConfig;
  const r3 = checkCoreContract(noValidate, extra);
  assert.deepEqual([r3.features.form, r3.features.api], [false, false]);

  const noAdapter = checkCoreContract(realCore, { ...extra, adapter: { unwrap: realAdapter.unwrap } });
  assert.equal(noAdapter.features.api, false);
  assert.ok(noAdapter.missing.some((m) => /extractSignals/.test(m)));
  const noScen = checkCoreContract(realCore, { ...extra, scenarios: {} });
  assert.equal(noScen.features.scenarios, false);

  const dead = checkCoreContract(null);
  assert.equal(dead.ok, false);
  assert.ok(Object.values(dead.features).every((v) => v === false));
});

test('checkCoreContract: 任意の export（MODE_LABELS など）が無いだけなら警告で、機能は止めない', () => {
  const ns = plainCore();
  delete ns.MODE_LABELS;
  delete ns.CORE_VERSION;
  const r = checkCoreContract(ns, extra);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 2);
  assert.ok(Object.values(r.features).every(Boolean));
  assert.equal(modeLabel('waiting') !== undefined, true);
});

test('checkCoreContract: state / summary の項目の欠落、DT の変更、例外を検出する', () => {
  const dropKey = (key) => {
    const ns = plainCore();
    ns.createRun = (c) => {
      const s = { ...realCore.createRun(c) };
      delete s[key];
      return s;
    };
    return ns;
  };
  const r1 = checkCoreContract(dropKey('phase'), extra);
  assert.equal(r1.ok, false);
  assert.ok(r1.missing.includes('state.phase'));
  assert.equal(r1.features.sim, false);
  assert.equal(r1.features.form, true);

  const stepDrops = plainCore();
  stepDrops.step = (s, c) => {
    const n = { ...realCore.step(s, c) };
    delete n.stoppedAtT;
    return n;
  };
  assert.ok(checkCoreContract(stepDrops, extra).missing.some((m) => /stoppedAtT/.test(m)));

  const sumDrops = plainCore();
  sumDrops.summarize = (s, c) => {
    const n = { ...realCore.summarize(s, c) };
    delete n.totalTimeS;
    return n;
  };
  assert.ok(checkCoreContract(sumDrops, extra).missing.includes('summary.totalTimeS'));

  const dt = { ...plainCore(), DT: 0.05 };
  const rdt = checkCoreContract(dt, extra);
  assert.equal(rdt.features.sim, false);
  assert.ok(rdt.missing.some((m) => /DT/.test(m)));

  const throwing = plainCore();
  throwing.createRun = () => { throw new Error('壊れた'); };
  const rt = checkCoreContract(throwing, extra);
  assert.equal(rt.ok, false);
  assert.ok(rt.problems.some((p) => /壊れた/.test(p)));

  // state / summary に項目が「増えた」だけなら問題なし
  const added = plainCore();
  added.createRun = (c) => ({ ...realCore.createRun(c), fatigue: 0.1 });
  assert.equal(checkCoreContract(added, extra).ok, true);
});

/* ---------- 自動表示用の整形 ---------- */
test('未知の state キーの抽出と表の行（history は除く、オブジェクトは JSON 1 行）', () => {
  const pair = advance(createPair(FIXED_SCENARIOS.find((s) => s.id === 'A').config), 30);
  const withNew = { ...pair.runwave, fatigue: 0.25, zone: { name: 'z2', range: [120, 140] } };
  assert.deepEqual(unknownKeys(withNew, KNOWN_STATE_KEYS), ['fatigue', 'zone']);
  assert.deepEqual(unknownKeys(pair.normal, KNOWN_STATE_KEYS), [], '今の core の state は全部既知');
  const rows = stateRows(pair.normal, withNew);
  assert.ok(!rows.some((r) => r.key === 'history'));
  const fatigue = rows.find((r) => r.key === 'fatigue');
  assert.deepEqual([fatigue.known, fatigue.normal, fatigue.runwave], [false, '（なし）', '0.25']);
  assert.equal(rows.find((r) => r.key === 'zone').runwave, '{"name":"z2","range":[120,140]}');
  assert.equal(rows.find((r) => r.key === 'bpm').known, true);
  assert.equal(rows.find((r) => r.key === 'signal').runwave.startsWith('{'), true);
  assert.ok(!formatValue({ a: 'x'.repeat(500) }).includes('\n'));
  assert.ok(formatValue({ a: 'x'.repeat(500) }).endsWith('…'));
  assert.equal(formatValue(null), 'null');
  assert.equal(formatValue(0.1 + 0.2), '0.3');
});

test('summary の未知のキーは「その他の集計」に出る。既知だけなら空', () => {
  const base = { enabled: false, finished: true, stops: 1, stopTimeS: 20, totalTimeS: 320, minBpm: 150, maxBpm: 150, totalBpmChange: 0, baseBpm: 150, crossingModel: 'point', termination: 'finished' };
  assert.deepEqual(extraSummaryRows({ normal: base, runwave: base }), []);
  const rows = extraSummaryRows({ normal: base, runwave: { ...base, energyKcal: 12.5, laps: [1, 2] } });
  assert.deepEqual(rows.map((r) => r.key), ['energyKcal', 'laps']);
  assert.deepEqual(rows[0], { key: 'energyKcal', normal: '（なし）', runwave: '12.5' });
  assert.equal(extraSummaryRows(null).length, 0);
});

test('describeExports: 使用中 / 未使用に分け、関数は引数の数つき。ダッシュボードが知らない名前は「新規の可能性」', () => {
  const real1 = describeExports(realCore);
  assert.ok(real1.used.some((r) => r.name === 'createRun' && r.arity === 1));
  assert.ok(real1.used.some((r) => r.name === 'step' && r.arity === 2));
  assert.ok(real1.unused.some((r) => r.name === 'calibrate'));
  assert.ok(real1.unused.every((r) => !r.possiblyNew), '今の core には新規の名前はない');
  const ns = { ...realCore, plan: (a, b, c) => [a, b, c], PLAN_LABELS: { x: 1 } };
  const r = describeExports(ns);
  const plan = r.unused.find((x) => x.name === 'plan');
  assert.deepEqual([plan.kind, plan.arity, plan.possiblyNew], ['function', 3, true]);
  assert.equal(r.unused.find((x) => x.name === 'PLAN_LABELS').arity, null);
  assert.deepEqual(describeExports(null), { used: [], unused: [] });
});

/* ---------- モード名・照合・設定の引き継ぎ ---------- */
test('モード名: core の MODE_LABELS にあればそれを、無い（新しい）モードは生の値をそのまま表示する', () => {
  assert.equal(modeLabel('waiting'), realCore.MODE_LABELS.waiting);
  assert.equal(modeLabel('sprintMode'), 'sprintMode');
});

test('照合の比較: 新しい集計（入れ子・配列）も比べ、片方にしかないキーは不一致になる', () => {
  assert.equal(sameValue({ a: 1, b: [1, 2] }, { a: 1 + 1e-9, b: [1, 2] }), true);
  assert.equal(sameValue({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] }), false);
  assert.equal(sameValue({ a: 1 }, { a: 1, extra: 2 }), false);
  assert.equal(sameValue(null, null), true);
  assert.equal(sameValue(null, 0), false);
  // 実際の照合は summary の全キーを対象にする
  let pair = createPair(FIXED_SCENARIOS.find((s) => s.id === 'A').config);
  while (!pair.normal.finished || !pair.runwave.finished) pair = stepPair(pair);
  const v = verifyPair(pair);
  const keys = new Set(v.items.filter((i) => i.lane === 'runwave').map((i) => i.key));
  for (const k of Object.keys(v.sequential.runwave)) assert.ok(keys.has(k), `${k} も照合している`);
  assert.equal(v.status, 'match');
});

test('フォームにない設定項目は、適用してリセットしても失われない。編集欄にない項目は一覧に出る', () => {
  const base = clone(FIXED_SCENARIOS.find((s) => s.id === 'B').config);
  base.control.futureParam = 7;
  base.runner.weightKg = 60;
  const extras = extraConfigEntries(base).map(([k]) => k);
  assert.ok(extras.includes('control.futureParam'));
  assert.ok(extras.includes('runner.weightKg'));
  assert.ok(!extras.includes('control.enabled'));
  const { config, errors } = parseForm(configToForm(base), base);
  assert.deepEqual(errors, []);
  assert.equal(config.control.futureParam, 7);
  assert.equal(config.runner.weightKg, 60);
  assert.equal(config.control.enabled, undefined);
});
