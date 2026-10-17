// 経路選択の試作。地図APIには接続せず、渡された有向道路グラフを既存coreで比較する。
import { simulateRoute, validateRouteConfig } from '../route-core.js';
import { DEFAULT_CONTROL, speedOf, validateConfig, validateSignal } from '../runwave-core.js';

const need = (ok, message) => { if (!ok) throw new RangeError(message); };
const positive = (v) => Number.isFinite(v) && v > 0;
const nonnegative = (v) => Number.isFinite(v) && v >= 0;

function roadsOf(graph) {
  need(graph && Array.isArray(graph.nodes) && Array.isArray(graph.edges), 'nodes・edges が必要です');
  const roads = new Map();
  for (const node of graph.nodes) {
    need(node && typeof node.id === 'string' && node.id.length > 0 && !roads.has(node.id), 'node.id は重複しない文字列');
    roads.set(node.id, []);
  }
  const ids = new Set();
  for (const edge of graph.edges) {
    need(edge && typeof edge.id === 'string' && edge.id.length > 0 && !ids.has(edge.id), 'edge.id は重複しない文字列');
    ids.add(edge.id);
    need(roads.has(edge.from) && roads.has(edge.to) && edge.from !== edge.to, 'edge の両端は異なる既存node');
    need(positive(edge.lengthM), 'edge.lengthM は正の数');
    need(edge.signals === undefined || Array.isArray(edge.signals), 'edge.signals は配列');
    for (const s of edge.signals || []) {
      need(s && typeof s.id === 'string' && s.id.length > 0, 'signal.id は文字列');
      validateSignal(s.signal);
      need(nonnegative(s.atM) && s.atM + s.signal.crossingM <= edge.lengthM, '信号と横断はedgeの範囲内に置く');
    }
    roads.get(edge.from).push(edge);
  }
  for (const edges of roads.values()) edges.sort((a, b) => a.id.localeCompare(b.id));
  return roads;
}

// ゴールまでの距離だけを下限として使い、遠回り上限内の単純経路を短い順に列挙する。
export function enumerateRoutes(graph, { startId, goalId, maxDetourRatio = 0.2, maxCandidates = 16, maxExpanded = 10000 }) {
  const roads = roadsOf(graph);
  need(roads.has(startId) && roads.has(goalId) && startId !== goalId, '異なる出発node・到着nodeが必要です');
  need(nonnegative(maxDetourRatio), 'maxDetourRatio は0以上の有限数');
  need(Number.isSafeInteger(maxCandidates) && maxCandidates > 0, 'maxCandidates は正の整数');
  need(Number.isSafeInteger(maxExpanded) && maxExpanded > 0, 'maxExpanded は正の整数');
  const remaining = new Map([...roads.keys()].map((id) => [id, Infinity]));
  remaining.set(goalId, 0);
  const pending = new Set(roads.keys());
  while (pending.size) {
    const id = [...pending].sort((a, b) => remaining.get(a) - remaining.get(b))[0];
    pending.delete(id);
    if (!Number.isFinite(remaining.get(id))) break;
    for (const edge of graph.edges) if (edge.to === id) {
      remaining.set(edge.from, Math.min(remaining.get(edge.from), edge.lengthM + remaining.get(id)));
    }
  }
  const shortestM = remaining.get(startId);
  if (!Number.isFinite(shortestM)) return { routes: [], shortestM: null, truncated: false, expanded: 0 };
  const limitM = shortestM * (1 + maxDetourRatio);
  const queue = [{ nodeIds: [startId], edges: [], distanceM: 0, bound: shortestM }];
  const routes = [];
  let expanded = 0;
  while (queue.length && routes.length < maxCandidates && expanded < maxExpanded) {
    queue.sort((a, b) => a.bound - b.bound || a.edges.map((e) => e.id).join('/').localeCompare(b.edges.map((e) => e.id).join('/')));
    const path = queue.shift();
    const last = path.nodeIds.at(-1);
    if (last === goalId) {
      let distanceM = 0;
      const signals = [];
      for (const edge of path.edges) {
        for (const s of edge.signals || []) signals.push({ ...s, atM: distanceM + s.atM });
        distanceM += edge.lengthM;
      }
      signals.sort((a, b) => a.atM - b.atM);
      routes.push({ id: path.edges.map((e) => e.id).join('/'), nodeIds: path.nodeIds, edgeIds: path.edges.map((e) => e.id), distanceM, signals });
      continue;
    }
    expanded++;
    for (const edge of roads.get(last)) {
      if (path.nodeIds.includes(edge.to)) continue;   // 周回して待ち時間を隠さない
      const distanceM = path.distanceM + edge.lengthM;
      const bound = distanceM + remaining.get(edge.to);
      if (bound > limitM + 1e-9) continue;
      queue.push({ nodeIds: [...path.nodeIds, edge.to], edges: [...path.edges, edge], distanceM, bound });
    }
  }
  return { routes, shortestM, truncated: queue.length > 0, expanded };
}

// 信号のない道は通常BPMで進める。設定の妥当性は既存coreと同じ検証を通す。
function freeSummary(config, maxTimeS) {
  validateConfig({ ...config, signal: { cycleS: 1, greenS: 1, yellowS: 0, redS: 0, phaseS: 0, crossingM: 0 }, route: { crossingX: config.goalM / 2, goalX: config.goalM } });
  const totalTimeS = config.goalM / speedOf(config.runner.strideM, config.runner.baseBpm);
  const finished = totalTimeS <= maxTimeS;
  return { finished, termination: finished ? 'finished' : 'timeLimit', stops: 0, stopTimeS: 0, totalTimeS: finished ? totalTimeS : null,
    walkTimeS: 0, walkDistanceM: 0, totalBpmChange: 0, deviationBpmS: 0, signals: [] };
}

// 停止回数→停止時間→歩行時間→距離→所要時間。未完走を停止ゼロの成功として選ばない。
export function chooseRoute(graph, options) {
  const { runner, control, departureTimeS = 0, maxTimeS = 3600 } = options;
  need(nonnegative(departureTimeS), 'departureTimeS は0以上の有限数');
  need(positive(maxTimeS), 'maxTimeS は正の数');
  const search = enumerateRoutes(graph, options);
  const evaluated = search.routes.map((route) => {
    const config = { runner, control, goalM: route.distanceM,
      signals: route.signals.map((s) => ({ ...s, signal: { ...s.signal, phaseS: s.signal.phaseS + departureTimeS } })) };
    const summary = config.signals.length ? (validateRouteConfig(config), simulateRoute(config, { maxTimeS }).summary) : freeSummary(config, maxTimeS);
    return { ...route, config, summary };
  });
  const score = (r) => [r.summary.stops, r.summary.stopTimeS, r.summary.walkTimeS || 0, r.distanceM, r.summary.totalTimeS];
  const compare = (a, b) => {
    const x = score(a), y = score(b);
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 1e-9) return x[i] - y[i];
    return a.id.localeCompare(b.id);
  };
  const completed = evaluated.filter((r) => r.summary.finished).sort(compare);
  return { selected: completed[0] || null, evaluated, shortestM: search.shortestM, truncated: search.truncated, expanded: search.expanded,
    departureTimeS, controlEnabled: control?.enabled ?? DEFAULT_CONTROL.enabled };
}
