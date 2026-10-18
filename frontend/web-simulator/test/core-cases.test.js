// 共通ケース（core/cases/core-cases.json）の入り口。ファイルが無い間は skip（成功扱い）。
// 読み取りと形式の想定は src/core-cases.js に集約している。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_CASES_PATH, CoreCasesFormatError, compareCase, coreCasesExist, loadCoreCases, parseCoreCases } from '../src/core-cases.js';
import { core } from '../src/core-ns.js';
import { getDemo } from '../src/scenarios.js';

test('共通ケース: core/cases/core-cases.json を web の engine-adapter 経由と core 直呼びで比べる', (t) => {
  if (!coreCasesExist()) {
    t.skip('core-cases.json 未作成');
    return;
  }
  const { coreVersion, cases } = loadCoreCases();
  assert.ok(coreVersion, 'coreVersion がある');
  assert.ok(Array.isArray(cases), 'cases は配列');
  assert.equal(coreVersion, core.CORE_VERSION, `ケースの coreVersion ${coreVersion} と取り込んだ core ${core.CORE_VERSION} が違う`);
  for (const c of cases) {
    const r = compareCase(c);
    assert.ok(r.ok, `ケース ${r.id}: ${r.diffs.join(' / ')}`);
  }
});

// ---- 以下は入り口自体の確認（ファイルの有無に関係なく動く） ----
test('形式が想定と違うと「形式が想定と違う: 〜」で失敗する', () => {
  const bad = [
    ['{not json', /JSON/],
    [[], /最上位/],
    [{ cases: [] }, /coreVersion/],
    [{ coreVersion: '1', cases: {} }, /cases が配列/],
    [{ coreVersion: '1', cases: [{ config: {} }] }, /id/],
    [{ coreVersion: '1', cases: [{ id: 'a', config: {} }] }, /signal/],
    [{ coreVersion: '1', cases: [{ id: 'a', config: { signals: [] } }] }, /signal/],
    [{ coreVersion: '1', cases: [{ id: 'a', config: { signal: {} } }, { id: 'a', config: { signal: {} } }] }, /重複/],
  ];
  for (const [input, re] of bad) {
    assert.throws(() => parseCoreCases(input), (e) => e instanceof CoreCasesFormatError && /^形式が想定と違う: /.test(e.message) && re.test(e.message), JSON.stringify(input));
  }
});

test('想定形式（デモ B/W/A を入れたケース）は読めて、adapter と core 直呼びが一致する', () => {
  const sample = { coreVersion: core.CORE_VERSION, cases: ['B', 'W', 'A'].map((id) => ({ id: `demo-${id}`, config: getDemo(id).config })) };
  const parsed = parseCoreCases(sample);
  assert.equal(parsed.cases.length, 3);
  for (const c of parsed.cases) {
    const r = compareCase(c);
    assert.ok(r.ok, `${r.id}: ${r.diffs.join(' / ')}`);
    assert.ok(r.ticks > 0);
  }
});

test('unix-epoch の信号を含むケースは換算後の config で比べる（runStartUnixS が要る）', () => {
  const config = JSON.parse(JSON.stringify(getDemo('B').config));
  config.signal.phaseReference = 'unix-epoch';
  config.signal.phaseS = 1760000000 + config.signal.phaseS; // Unix 基準の値
  const c = parseCoreCases({ coreVersion: 'x', cases: [{ id: 'e', config, runStartUnixS: 0 }] }).cases[0];
  const r = compareCase(c);
  assert.ok(r.ok, r.diffs.join(' / '));
  assert.throws(() => compareCase({ ...c, runStartUnixS: null }), /runStartUnixS/);
});

test('CORE_CASES_PATH はリポジトリの core/cases/core-cases.json を指す', () => {
  assert.match(CORE_CASES_PATH.replaceAll('\\', '/'), /\/core\/cases\/core-cases\.json$/);
});
