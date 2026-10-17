import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTROL } from '../../../core/runwave-core.js';
import { FIELD_IDS, configToForm, formsEqual, parseForm } from '../src/config-form.js';
import { FIXED_SCENARIOS, getFixedScenario } from '../src/sim-engine.js';

const normalized = (c) => ({ ...c, control: { ...DEFAULT_CONTROL, ...c.control, enabled: undefined } });
const clean = (c) => JSON.parse(JSON.stringify(normalized(c)));

test('固定シナリオ → フォーム → config が元の config と同じ（enabled は含まない）', () => {
  for (const sc of FIXED_SCENARIOS) {
    const form = configToForm(sc.config);
    assert.deepEqual(FIELD_IDS.filter((id) => typeof form[id] !== 'string'), []);
    const { config, errors } = parseForm(form);
    assert.deepEqual(errors, []);
    assert.deepEqual(clean(config), clean(sc.config), sc.id);
    assert.equal(config.control.enabled, undefined, 'enabled は 2 レーン側で決める');
  }
});

test('空欄・NaN・Infinity・負値を項目名つきのエラーにする（例外は投げない）', () => {
  const base = configToForm(getFixedScenario('B').config);
  const cases = [
    [{ strideM: '' }, /歩幅.*空欄/],
    [{ baseBpm: 'abc' }, /通常ケイデンス.*数値として読めません/],
    [{ goalX: 'Infinity' }, /ゴール距離.*有限の数ではありません/],
    [{ crossingX: '-5' }, /横断地点までの距離.*負の値/],
    [{ strideM: '0' }, /歩幅.*0 より大きい/],
    [{ redS: '-1' }, /赤.*負の値/],
    [{ crossingM: 'NaN' }, /横断幅.*数値として読めません/],
    [{ crossingModel: 'foo' }, /横断モデル/],
  ];
  for (const [patch, re] of cases) {
    const r = parseForm({ ...base, ...patch });
    assert.equal(r.config, null);
    assert.ok(r.errors.some((e) => re.test(e.message)), `${JSON.stringify(patch)} → ${r.errors.map((e) => e.message).join(' | ')}`);
  }
  assert.doesNotThrow(() => parseForm({}));
  assert.equal(parseForm({}).config, null);
  assert.doesNotThrow(() => parseForm(undefined ?? {}));
  // phaseS は負でもよい
  assert.deepEqual(parseForm({ ...base, phaseS: '-30' }).errors, []);
});

test('信号周期と青・青点滅・赤の合計が合わないときは具体的な数を示す', () => {
  const base = configToForm(getFixedScenario('B').config);
  const r = parseForm({ ...base, cycleS: '100' });
  assert.equal(r.config, null);
  assert.equal(r.errors[0].field, 'cycleS');
  assert.match(r.errors[0].message, /50\) \+ 青点滅\(5\) \+ 赤\(65\) = 120 秒.*100 秒/);
});

test('core の検証（goalX・baseBpm と調整上限・0.1 秒の倍数）のメッセージも画面に出せる', () => {
  const base = configToForm(getFixedScenario('B').config);
  const goal = parseForm({ ...base, goalX: '300' });
  assert.equal(goal.config, null);
  assert.match(goal.errors[0].message, /^core の検証: goalX/);
  // length モデルでは goalX が crossingX + 横断幅 より先でなければならない
  const len = parseForm({ ...base, crossingModel: 'length', crossingM: '250', goalX: '600' });
  assert.match(len.errors[0].message, /goalX/);
  const delta = parseForm({ ...base, maxDeltaBpm: '150' });
  assert.match(delta.errors[0].message, /maxDeltaBpm/);
  const interval = parseForm({ ...base, stepIntervalS: '0.25' });
  assert.match(interval.errors[0].message, /0\.1 秒の倍数/);
});

test('エラーを直せば config が得られる（再開できる）', () => {
  const base = configToForm(getFixedScenario('A').config);
  const bad = { ...base, strideM: '' };
  assert.equal(parseForm(bad).config, null);
  const fixed = parseForm({ ...bad, strideM: '0.8' });
  assert.deepEqual(fixed.errors, []);
  assert.equal(fixed.config.runner.strideM, 0.8);
});

test('formsEqual: 未適用の変更（dirty）を検出できる', () => {
  const a = configToForm(getFixedScenario('B').config);
  assert.equal(formsEqual(a, { ...a }), true);
  assert.equal(formsEqual(a, { ...a, phaseS: '101' }), false);
});
