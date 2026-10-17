// 発表用シナリオ。条件の元は core/scenarios.js の export（同名の別設定は作らない）。
// 1 レーンの config: control.enabled=true・横断モデル point・早歩き有効・終了前余裕 5 秒を明示して固定する。
// 見せ場の検出は core を逐次 step して行う（UI で mode を判定したり state を作ったりしない）。
import { core, scenariosNs } from './core-ns.js';
import { MAX_TICKS } from './simulation.js';

const SOURCES = {
  B: { src: scenariosNs.SCENARIOS.B, name: 'B：テンポ調整', blurb: '接近→加速判断→目標変更→歩調変化→通過' },
  A: { src: scenariosNs.SCENARIOS.A, name: 'A：減速調整', blurb: '減速でも停止を減らせるという判断' },
  W: { src: scenariosNs.SCENARIOS_WALK.W, name: 'W：早歩き', blurb: '走るだけでは難しい場面を早歩きでつなぐ' },
};

export function demoConfig(src) {
  const c = src.control || {};
  return {
    signal: { ...src.signal },
    runner: { ...src.runner },
    route: { ...src.route },
    control: { ...c, enabled: true, crossingModel: 'point', endMarginS: c.endMarginS ?? 5, walk: { ...(c.walk || {}), enabled: true } },
  };
}

export const SCENARIO_IDS = ['B', 'A', 'W'];
export const DEFAULT_SCENARIO_ID = 'B';

export const SCENARIO_LIST = SCENARIO_IDS.map((id) => {
  const s = SOURCES[id];
  return { id, name: s.name, blurb: s.blurb, config: demoConfig(s.src) };
});
for (const s of SCENARIO_LIST) core.validateConfig(s.config);

export const getScenario = (id) => SCENARIO_LIST.find((s) => s.id === id) ?? null;

// ---------- 見せ場 ----------
export const HIGHLIGHT_KINDS = [
  { kind: 'adjust', label: 'テンポ調整', test: (s) => s.mode === 'adjusting' && s.reason === 'signal' },
  { kind: 'prep', label: '早歩きへの切替準備', test: (s) => s.mode === 'adjusting' && s.reason === 'walkBridge' },
  { kind: 'walk', label: '早歩き', test: (s) => s.mode === 'walking' },
  { kind: 'stopRec', label: '停止推奨', test: (s) => s.mode === 'stopRecommended' },
  { kind: 'wait', label: '信号待ち', test: (s) => s.mode === 'waiting' },
];

/** 初期状態から core を逐次 step し、各種別が最初に起きた tick を返す（tick 昇順）。起きなければ空 */
export function findHighlights(config) {
  const found = [];
  const seen = new Set();
  let s = core.createRun(config);
  while (!s.finished && s.tick < MAX_TICKS) {
    s = core.step(s, config);
    for (const h of HIGHLIGHT_KINDS) {
      if (!seen.has(h.kind) && h.test(s)) {
        seen.add(h.kind);
        found.push({ kind: h.kind, label: h.label, tick: s.tick, mode: s.mode, reason: s.reason });
      }
    }
    if (seen.size === HIGHLIGHT_KINDS.length) break;
  }
  return found.sort((a, b) => a.tick - b.tick);
}

const cache = new Map();
export function highlightsFor(id) {
  if (!cache.has(id)) {
    const sc = getScenario(id);
    cache.set(id, sc ? findHighlights(sc.config) : []);
  }
  return cache.get(id);
}
