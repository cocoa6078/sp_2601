import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCoreConverter, toCorePhaseS, toCorePhaseSLocal, toCoreSignal } from '../src/phase.js';
import { planFromMap } from '../src/engine-adapter.js';
import { defaultRunnerAndControl } from '../src/scenarios.js';
import { fetchSignals } from '../src/api.js';

const sig = (extra = {}) => ({ cycleS: 120, greenS: 50, yellowS: 5, redS: 65, phaseS: 20, crossingM: 15, ...extra });

test('run-start と未指定はそのまま', () => {
  assert.equal(toCorePhaseSLocal(sig(), 999), 20);
  assert.equal(toCorePhaseSLocal(sig({ phaseReference: 'run-start' }), 999), 20);
  assert.equal(toCorePhaseSLocal(sig({ phaseReference: 'run-start' })), 20); // runStartUnixS 無しでも可
});

test('unix-epoch は (runStartUnixS + phaseS) mod cycleS', () => {
  assert.equal(toCorePhaseSLocal(sig({ phaseReference: 'unix-epoch', phaseS: 20 }), 1000), (1000 + 20) % 120);
  assert.equal(toCorePhaseSLocal(sig({ phaseReference: 'unix-epoch', phaseS: 0 }), 240), 0);
  assert.equal(toCorePhaseSLocal(sig({ phaseReference: 'unix-epoch', phaseS: -50 }), 10), 80); // 負でも 0 以上 cycleS 未満
});

test('不正な入力は理由つきで失敗する', () => {
  assert.throws(() => toCorePhaseSLocal(sig({ phaseReference: 'unix-epoch' })), /runStartUnixS/);
  assert.throws(() => toCorePhaseSLocal(sig({ phaseReference: 'unix-epoch' }), NaN), /runStartUnixS/);
  assert.throws(() => toCorePhaseSLocal(sig({ phaseReference: 'foo' }), 0), /phaseReference が不明/);
  assert.throws(() => toCorePhaseSLocal(sig({ phaseS: 'x' }), 0), /phaseS/);
});

test('toCorePhaseS: core に同名関数が無い間は自前と同じ結果', () => {
  if (findCoreConverter()) return; // core 側に入ったらそちらが優先される（結果の一致は core 側の責務）
  const s = sig({ phaseReference: 'unix-epoch', phaseS: 7 });
  assert.equal(toCorePhaseS(s, 500), toCorePhaseSLocal(s, 500));
});

test('toCoreSignal: phaseReference を外し、入力を変更しない', () => {
  const s = sig({ phaseReference: 'unix-epoch', phaseS: 7 });
  const out = toCoreSignal(s, 500);
  assert.ok(!('phaseReference' in out));
  assert.equal(out.phaseS, (500 + 7) % 120);
  assert.equal(s.phaseS, 7);
  assert.equal(s.phaseReference, 'unix-epoch');
});

const adoptedOf = (signal, apiMeta) => ({ key: 'api:a', signalId: 'a', s: 400, signal, apiMeta });
const rc = defaultRunnerAndControl();

test('planFromMap: apiMeta.phaseReference=unix-epoch の信号は core に渡す前に換算される（1 件・複数件）', () => {
  const meta = { phaseReference: 'unix-epoch' };
  const one = planFromMap({ route: { lengthM: 600 }, adopted: [adoptedOf(sig({ phaseS: 20 }), meta)], runner: rc.runner, control: rc.control, runStartUnixS: 1000 });
  assert.equal(one.kind, 'single');
  assert.equal(one.config.signal.phaseS, (1000 + 20) % 120);
  assert.ok(!('phaseReference' in one.config.signal));
  const second = { ...adoptedOf(sig({ phaseS: 30 }), { phaseReference: 'run-start' }), key: 'api:b', s: 700 };
  const two = planFromMap({ route: { lengthM: 1000 }, adopted: [adoptedOf(sig({ phaseS: 20 }), meta), second], runner: rc.runner, control: rc.control, runStartUnixS: 1000 });
  assert.equal(two.kind, 'route');
  assert.deepEqual(two.config.signals.map((x) => x.signal.phaseS), [(1000 + 20) % 120, 30]);
});

test('planFromMap: 未指定・run-start は無変換。換算できないときは invalid（理由つき）', () => {
  const none = planFromMap({ route: { lengthM: 600 }, adopted: [adoptedOf(sig({ phaseS: 20 }), null)], runner: rc.runner, control: rc.control });
  assert.equal(none.config.signal.phaseS, 20);
  const bad = planFromMap({ route: { lengthM: 600 }, adopted: [adoptedOf(sig({ phaseS: 20 }), { phaseReference: 'unix-epoch' })], runner: rc.runner, control: rc.control });
  assert.equal(bad.kind, 'invalid');
  assert.match(bad.reason, /位相の換算に失敗/);
});

test('fetchSignals: API の phaseReference が apiMeta に残る', async () => {
  const body = { ステータス: '成功', データ: [{ signalId: 'a', lat: 43, lon: 141, ...sig(), phaseReference: 'unix-epoch' }] };
  const r = await fetchSignals('http://localhost:3001', { fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify(body) }) });
  assert.equal(r.candidates[0].apiMeta.phaseReference, 'unix-epoch');
});
