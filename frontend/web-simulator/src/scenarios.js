// 固定デモ（模式コース）の定義。既存 core/scenarios.js の A/B/W を import し、
// 早歩き（control.walk.enabled=true）を明示して正規化する。core の既定（enabled:true）に黙って頼らない。
// endMarginS はシナリオ側の明示値（5 秒）を保持し、core 既定の 8 秒で上書きしない。
import { scenariosNs } from './core-ns.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

/** walk を明示的に有効化した config を返す（元は変更しない） */
export function normalizeWalk(config, enabled = true) {
  const c = clone(config);
  c.control = { ...(c.control || {}), walk: { ...(c.control?.walk || {}), enabled } };
  return c;
}

function build() {
  const out = [];
  const { SCENARIOS, SCENARIOS_WALK } = scenariosNs;
  const add = (id, label, desc, src) => {
    if (src) out.push({ id, kind: 'single', label, desc, config: normalizeWalk(src) });
  };
  add('B', 'デモ B（加速で回避）', '道沿いの固定経路 600m・信号 400m。1 交差点', SCENARIOS?.B);
  add('W', 'デモ W（早歩きの見せ場）', '道沿いの固定経路 600m・信号 400m。走りだけでは止まる位相', SCENARIOS_WALK?.W);
  add('A', 'デモ A（減速で回避）', '道沿いの固定経路 600m・信号 400m。1 交差点', SCENARIOS?.A);
  // D: 信号 5 つ（sapporo_3→8→2→1→5）を道沿いの固定経路で連続して通る。config は持たず、地図コースと同じく
  // matchSignals → planFromMap → route-core で作る（kind: 'route'。main.js の recompute）
  out.push({ id: 'D', kind: 'route', label: 'デモ D（5 交差点・連続走行）', desc: '道沿いの固定経路・信号 5 つ。先読みあり（route-core）', config: null });
  return out;
}

export const DEMO_SCENARIOS = build();
export const DEFAULT_DEMO_ID = DEMO_SCENARIOS.find((s) => s.id === 'B')?.id ?? DEMO_SCENARIOS[0]?.id ?? null;
/** 信号 1 つの固定デモ（A/B/W）。config を持つ */
export const SINGLE_DEMOS = DEMO_SCENARIOS.filter((d) => d.kind !== 'route');
export const getDemo = (id) => DEMO_SCENARIOS.find((s) => s.id === id) ?? null;

/** 実地図の経路に使う既定の走者と制御（B の control を土台にし、walk を明示） */
export function defaultRunnerAndControl() {
  const b = getDemo('W') ?? getDemo('B');
  const c = clone(b.config);
  return { runner: c.runner, control: c.control };
}
