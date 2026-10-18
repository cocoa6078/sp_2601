// 経路候補（Apple などの徒歩経路の線）を「止まりにくい順」に並べる（試作）。
// 信号は経路沿い信号 API（POST /api/signals/along-route の matches）か /api/signals/all の形を受け取る。
// 位相は使わず「止まりやすさの式」だけで比べる（位相が分からないデータで仮の位相を使うと逆効果だったため）。
import { rankByRisk } from './route-search.js';

const EARTH_R_M = 6371008.8;
const need = (ok, message) => { if (!ok) throw new RangeError(message); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// GeoJSON の座標 [[経度, 緯度], ...] を、始点を原点にした平面（m）の折れ線にする。各点までの累積距離も持つ
export function lineOf(coordinates) {
  need(Array.isArray(coordinates) && coordinates.length >= 2, '経路の座標は2点以上の配列');
  const pts = coordinates.map((c, i) => {
    need(Array.isArray(c) && isNum(c[0]) && isNum(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90, `座標[${i}]は [経度, 緯度] の数`);
    return { lon: c[0], lat: c[1] };
  });
  const k = Math.PI / 180, cos = Math.cos(pts[0].lat * k);
  const toXY = (p) => ({ x: (p.lon - pts[0].lon) * k * EARTH_R_M * cos, y: (p.lat - pts[0].lat) * k * EARTH_R_M });
  const points = pts.map(toXY);
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  need(cum.at(-1) > 0, '経路の長さが0');
  return { points, cum, lengthM: cum.at(-1), toXY };
}

// 点を折れ線に当てはめ、経路から corridorM 以内を通る「通過」を全部返す（周回・折り返しで同じ信号を2回通る場合に対応）。
// 経路に沿って passGapM 以内の近い当たりは1回の通過にまとめ、いちばん近い所を使う
export function projectPasses(line, p, { corridorM = 30, passGapM = 2 * corridorM + 20 } = {}) {
  const q = line.toXY(p);
  const hits = [];
  for (let i = 0; i < line.points.length - 1; i++) {
    const a = line.points[i], b = line.points[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    if (!len2) continue;
    const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2));
    const sep = Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy));
    if (sep <= corridorM) hits.push({ atM: line.cum[i] + t * Math.sqrt(len2), separationM: sep });
  }
  hits.sort((x, y) => x.atM - y.atM);
  const passes = [];
  for (const h of hits) {
    const last = passes.at(-1);
    if (last && h.atM - last.lastAtM <= passGapM) {
      if (h.separationM < last.separationM) Object.assign(last, { atM: h.atM, separationM: h.separationM });
      last.lastAtM = h.atM;
    } else {
      passes.push({ ...h, lastAtM: h.atM });
    }
  }
  return passes.map(({ atM, separationM }) => ({ atM, separationM }));
}

// API の信号を core の信号の形にする（along-route の matches と /api/signals/all の両方に対応）
function signalOf(s) {
  const t = s.timing ?? s;
  return {
    id: String(s.physicalSignalId ?? s.signalId ?? s.id),
    lat: s.lat, lon: s.lon,
    signal: { cycleS: t.cycleS, greenS: t.greenS, yellowS: t.yellowS, redS: t.redS, phaseS: t.phaseS ?? 0, crossingM: s.crossingM ?? t.crossingM ?? 15 },
  };
}

// 1本の候補を、止まりやすさの式の入力（route-search と同じ形）にする
export function candidateRoute({ id, coordinates }, signals, { corridorM = 30, edgeMarginM = 15 } = {}) {
  const line = lineOf(coordinates);
  const entries = [], skipped = [];
  for (const raw of signals) {
    const s = signalOf(raw);
    if (!isNum(s.lat) || !isNum(s.lon)) continue;   // 座標の無い信号は当てはめられない
    projectPasses(line, s, { corridorM }).forEach((p, k) => {
      const entryId = k ? `${s.id}#${k + 1}` : s.id;   // 2回目以降の通過は別の信号として数える
      if (p.atM < edgeMarginM || p.atM + s.signal.crossingM > line.lengthM - edgeMarginM) {
        skipped.push({ id: entryId, reason: 'スタートかゴールのすぐ近く' });
        return;
      }
      entries.push({ id: entryId, physicalSignalId: s.id, atM: p.atM, separationM: p.separationM, signal: s.signal });
    });
  }
  entries.sort((a, b) => a.atM - b.atM);
  // 前の信号の横断と重なるほど近い信号（同じ交差点の別の向きなど）は、先のものだけ残す
  const kept = [];
  for (const e of entries) {
    const prev = kept.at(-1);
    if (prev && e.atM <= prev.atM + prev.signal.crossingM) skipped.push({ id: e.id, reason: '前の信号と近すぎる（同じ交差点とみなす）' });
    else kept.push(e);
  }
  return { id, distanceM: line.lengthM, signals: kept, skipped };
}

// 候補を止まりにくい順に並べる（止まる回数の見込み → 距離 → id）。runner・control は core と同じ形（省略時は core の既定）
export function rankCandidateLines(candidates, signals, { runner = { strideM: 0.8, baseBpm: 150 }, control, corridorM = 30, edgeMarginM = 15 } = {}) {
  need(Array.isArray(candidates) && candidates.length >= 1, '候補は1本以上の配列');
  need(Array.isArray(signals), '信号は配列');
  const ids = new Set();
  for (const c of candidates) {
    need(c && (typeof c.id === 'string' || typeof c.id === 'number') && String(c.id).length > 0, '候補の id が必要');
    need(!ids.has(String(c.id)), `候補の id が重複: ${c.id}`);
    ids.add(String(c.id));
  }
  const routes = candidates.map((c) => candidateRoute({ id: String(c.id), coordinates: c.coordinates }, signals, { corridorM, edgeMarginM }));
  return rankByRisk(routes, runner, control).map((r, i) => ({
    rank: i + 1,
    id: r.id,
    distanceM: Math.round(r.distanceM * 10) / 10,
    expectedStops: Math.round(r.risk.expectedStops * 1000) / 1000,
    signalCount: r.signals.length,
    signals: r.signals.map((s, k) => ({ id: s.id, physicalSignalId: s.physicalSignalId, atM: Math.round(s.atM * 10) / 10,
      separationM: Math.round(s.separationM * 10) / 10, stopRisk: Math.round(r.risk.perSignal[k].risk * 1000) / 1000 })),
    skipped: r.skipped,
  }));
}
