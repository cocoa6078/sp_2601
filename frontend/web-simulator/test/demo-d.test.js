import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { core } from '../src/core-ns.js';
import { DEMO_D_LEAD_M, DEMO_D_TAIL_M, DEMO_D_WALK_PATH, FIXTURE_SIGNALS, demoDRoutePoints } from '../src/fixtures.js';
import { buildRoute, validateRoute } from '../src/route-geometry.js';
import { matchSignals } from '../src/route-builder.js';
import { DEMO_SCENARIOS, defaultRunnerAndControl, getDemo } from '../src/scenarios.js';
import { createPair, isRouteConfig, pairDone, planFromMap, stepPair, summaryOf } from '../src/engine-adapter.js';
import { buildPhoneFrame, describeDecision } from '../src/phone-view-model.js';

const ORDER = ['sapporo_3', 'sapporo_8', 'sapporo_2', 'sapporo_1', 'sapporo_5'];

function planD() {
  const route = buildRoute(demoDRoutePoints(), { id: 'demo-d', source: 'preset' });
  const match = matchSignals(route, FIXTURE_SIGNALS);
  const { runner, control } = defaultRunnerAndControl();
  return { route, match, plan: planFromMap({ route, adopted: match.adopted, runner, control, runStartUnixS: 0 }) };
}

test('D が DEMO_SCENARIOS にあり（kind: route）、A/B/W は信号 1 つのまま', () => {
  assert.equal(getDemo('D').kind, 'route');
  for (const id of ['A', 'B', 'W']) assert.equal(getDemo(id).kind, 'single');
  assert.deepEqual(DEMO_SCENARIOS.map((d) => d.id).sort(), ['A', 'B', 'D', 'W']);
});

test('D の経路: 引き返しなし・validateRoute OK・最初の交差点の 300 m 手前〜最後の 200 m 先・5 信号が順に採用される', () => {
  assert.ok(validateRoute(buildRoute(DEMO_D_WALK_PATH)).ok);
  const { route, match } = planD();
  assert.deepEqual(validateRoute(route), { ok: true, errors: [] });
  assert.deepEqual(match.errors, []);
  assert.deepEqual(match.adopted.map((a) => a.signalId), ORDER);
  assert.ok(Math.abs(match.adopted[0].s - DEMO_D_LEAD_M) < 1, `s0=${match.adopted[0].s}`);
  assert.ok(Math.abs(route.lengthM - match.adopted[4].s - DEMO_D_TAIL_M) < 1, `tail=${route.lengthM - match.adopted[4].s}`);
  for (const a of match.adopted) assert.ok(a.offsetM <= 30, `${a.signalId}: ${a.offsetM} m`);
  for (let i = 1; i < match.adopted.length; i++) assert.ok(match.adopted[i].s - match.adopted[i - 1].s > 150);
});

test('D の計算: route-core（先読みは既定どおり有効）で最後まで走り切る', () => {
  const { plan } = planD();
  assert.equal(plan.kind, 'route');
  assert.equal(plan.config.signals.length, 5);
  assert.notEqual(plan.config.lookahead, false);
  let pair = createPair(plan.config);
  while (!pairDone(pair)) pair = stepPair(pair);
  assert.ok(pair.normal.state.finished && pair.runwave.state.finished);
  assert.ok(summaryOf(pair.runwave).stops <= summaryOf(pair.normal).stops);
});

test('iPhone パネル: 信号を通過するたびに参照信号・距離・信号カードが次へ切り替わり、値は同じ tick の core state と一致する', () => {
  const { match, plan } = planD();
  const adopted = match.adopted;
  let pair = createPair(plan.config);
  const seen = [];
  let prevFrame = null;
  while (!pairDone(pair)) {
    pair = stepPair(pair);
    const t = pair.tick / 10;
    const st = pair.runwave.state;
    const f = buildPhoneFrame({ lane: pair.runwave, t, adopted });
    // 同じ tick の state・時刻と一致
    assert.equal(f.t, t);
    assert.equal(f.signal.index, Math.min(st.signalIndex, 4));
    assert.equal(f.signal.id, ORDER[f.signal.index]);
    assert.equal(f.signal.color, core.signalAt(plan.config.signals[f.signal.index].signal, t).color);
    assert.equal(f.currentText, String(Math.round(st.phase === 'waiting' || st.finished ? 0 : st.bpm)));
    if (!(st.phase === 'waiting' || st.finished)) assert.equal(f.targetText, st.targetBpm == null ? '—' : String(Math.round(st.targetBpm)));
    for (const g of plan.config.signals) assert.equal(f.signal.colors[g.id], core.signalAt(g.signal, t).color);
    if (f.signal.allPassed) assert.equal(f.toSignalText, '信号は通過済み');
    else assert.equal(f.toSignalText, `約${Math.round(Math.max(0, plan.config.signals[f.signal.index].atM - st.x))} m先`);
    if (!prevFrame || prevFrame.signal.index !== f.signal.index) {
      seen.push({ index: f.signal.index, id: f.signal.id, title: f.signal.title, number: f.signal.number });
      // 切り替わった瞬間: 直前に最後の信号を通過した場合を除き、次の信号までの距離は信号間隔ぶん進む
      if (prevFrame) assert.equal(f.signal.index, prevFrame.signal.index + 1, '信号は 1 つずつ次へ進む');
    }
    prevFrame = f;
  }
  assert.deepEqual(seen.map((s) => s.id), ORDER);
  assert.deepEqual(seen.map((s) => s.number), [1, 2, 3, 4, 5]);
  assert.ok(seen.every((s) => s.title.includes('/ 5') && s.title.includes(s.id)));
  // 最後の信号を通過したら「通過済み」
  assert.equal(prevFrame.signal.allPassed, true);
  assert.equal(prevFrame.stateText, '完了');
});

test('iPhone パネル: 文言は presentation-simulator の describeDecision と同じ表（phone / phoneSub / kind）', async () => {
  const path = new URL('../../presentation-simulator/src/demo-view-model.js', import.meta.url);
  if (!existsSync(path)) return; // presentation-simulator が無い構成ではスキップ
  const { describeDecision: other } = await import(path.href);
  const modes = ['finished', 'waiting', 'stopRecommended', 'walking', 'adjusting', 'normal', 'xx'];
  const reasons = ['passed', 'walkBridge', 'signal', 'noMargin', 'none', 'off', 'unavoidable', 'xx'];
  for (const mode of modes) for (const reason of reasons) for (const gait of ['run', 'walk']) for (const direction of ['up', 'down', 'same']) {
    const a = describeDecision({ mode, reason, gait }, { direction });
    const b = other({ mode, reason, gait }, { direction });
    assert.deepEqual([a.kind, a.phone, a.phoneSub], [b.kind, b.phone, b.phoneSub], `${mode}/${reason}/${gait}/${direction}`);
  }
});

test('iPhone パネル: 信号 1 つの固定デモ B でも値を作れる（A/B/W は従来の単信号 core）', () => {
  const config = getDemo('B').config;
  assert.equal(isRouteConfig(config), false);
  let pair = createPair(config);
  for (let i = 0; i < 50; i++) pair = stepPair(pair);
  const f = buildPhoneFrame({ lane: pair.runwave, t: pair.tick / 10, adopted: [{ key: 'demo:B', signalId: '模式信号' }] });
  assert.equal(f.signal.count, 1);
  assert.equal(f.signal.number, 1);
  assert.match(f.toSignalText, /^約\d+ m先$/);
});
