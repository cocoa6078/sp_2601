// 経路の幾何（DOM・Leaflet 非依存）。地理距離の実装はこのファイルだけに集約する。
// - 距離: ハーバーサイン（球面）。表示のピクセル距離やズームには依存しない
// - 投影: 経路の先頭を原点にした局所メートル座標（等距円筒）で線分へ垂線を下ろす。札幌周辺の狭い範囲向け
// 計算の真値は「開始からの累積距離 s（m）」。地図座標は描画への変換。
export const EARTH_R_M = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const isFiniteLL = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
export { isFiniteLL };

/** 2 点間の地理距離（m）。a, b = { lat, lng } */
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** origin を中心にした局所メートル座標。x=東, y=北 */
export function localFrame(origin) {
  const cosLat = Math.cos(rad(origin.lat));
  const mPerDeg = (Math.PI / 180) * EARTH_R_M;
  return {
    toXY: (p) => ({ x: (p.lng - origin.lng) * cosLat * mPerDeg, y: (p.lat - origin.lat) * mPerDeg }),
    toLatLng: (q) => ({ lat: origin.lat + q.y / mPerDeg, lng: origin.lng + q.x / (cosLat * mPerDeg) }),
  };
}

/** 折れ線から route を作る。cumulativeM[i] = 先頭から points[i] までの距離 */
export function buildRoute(points, { id = 'route', source = 'manual-polyline' } = {}) {
  if (!Array.isArray(points) || points.length < 2) throw new RangeError('経路には 2 点以上が必要です');
  if (!points.every(isFiniteLL)) throw new RangeError('経路の座標が数値ではありません');
  const pts = points.map((p) => ({ lat: p.lat, lng: p.lng }));
  const cumulativeM = [0];
  for (let i = 1; i < pts.length; i++) cumulativeM.push(cumulativeM[i - 1] + distanceM(pts[i - 1], pts[i]));
  return { id, source, points: pts, cumulativeM, lengthM: cumulativeM[cumulativeM.length - 1] };
}

/** s（先頭からの距離 m）に対応する地図座標。範囲外は端に丸める */
export function pointAtDistance(route, s) {
  const { points, cumulativeM, lengthM } = route;
  if (!(s > 0)) return { ...points[0] };
  if (s >= lengthM) return { ...points[points.length - 1] };
  let i = 1;
  while (i < cumulativeM.length - 1 && cumulativeM[i] < s) i++;
  const segLen = cumulativeM[i] - cumulativeM[i - 1];
  const t = segLen > 0 ? (s - cumulativeM[i - 1]) / segLen : 0;
  const a = points[i - 1];
  const b = points[i];
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/**
 * 経路の fromS〜toS（先頭からの距離 m）の部分を切り出して新しい route を返す。端点は pointAtDistance で補間する。
 * 範囲外は RangeError。端の補間点から MIN_SEGMENT_M 未満の途中頂点は落とす（validateRoute の近すぎる点の検査に通すため）。
 */
export function sliceRoute(route, fromS, toS, { id = route.id, source = route.source } = {}) {
  if (!(fromS >= -1e-6 && toS <= route.lengthM + 1e-6 && toS > fromS)) throw new RangeError(`切り出し範囲が経路外です（${fromS}〜${toS} m / 経路長 ${route.lengthM} m）`);
  const a = pointAtDistance(route, fromS);
  const b = pointAtDistance(route, toS);
  const mid = route.points.filter((_, i) => route.cumulativeM[i] > fromS && route.cumulativeM[i] < toS)
    .filter((p) => distanceM(a, p) >= MIN_SEGMENT_M && distanceM(p, b) >= MIN_SEGMENT_M);
  return buildRoute([a, ...mid, b], { id, source });
}

/**
 * 点 p を経路へ投影する。戻り値 { distM（垂線距離）, s（経路上の累積距離）, segIndex, t, point（投影点） }
 * 垂線距離は局所メートル座標で測る（画面座標は使わない）。
 */
export function projectOnRoute(route, p) {
  const frame = localFrame(route.points[0]);
  const q = frame.toXY(p);
  let best = null;
  for (let i = 0; i < route.points.length - 1; i++) {
    const a = frame.toXY(route.points[i]);
    const b = frame.toXY(route.points[i + 1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2)) : 0;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d = Math.hypot(q.x - px, q.y - py);
    if (!best || d < best.distM - 1e-9) {
      const segLen = route.cumulativeM[i + 1] - route.cumulativeM[i];
      best = { distM: d, s: route.cumulativeM[i] + segLen * t, segIndex: i, t, point: frame.toLatLng({ x: px, y: py }) };
    }
  }
  return best;
}

// ---- 経路の検証（初版は単純な片道経路のみ）----
export const MIN_ROUTE_LENGTH_M = 50;
export const MIN_SEGMENT_M = 2;
export const MIN_START_END_M = 20;

function segIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 経路の不正条件を調べる。{ ok, errors: string[] } */
export function validateRoute(route) {
  const errors = [];
  const { points, cumulativeM } = route;
  if (points.length < 2) return { ok: false, errors: ['開始と終了の 2 点が必要です'] };
  if (distanceM(points[0], points[points.length - 1]) < MIN_START_END_M) errors.push(`開始と終了が近すぎます（${MIN_START_END_M} m 未満）`);
  for (let i = 1; i < points.length; i++) {
    if (cumulativeM[i] - cumulativeM[i - 1] < MIN_SEGMENT_M) errors.push(`${i} 番目と ${i + 1} 番目の点が重複または近すぎます（${MIN_SEGMENT_M} m 未満）`);
  }
  if (route.lengthM < MIN_ROUTE_LENGTH_M) errors.push(`経路が短すぎます（${MIN_ROUTE_LENGTH_M} m 未満）`);
  const frame = localFrame(points[0]);
  const xy = points.map(frame.toXY);
  // 往復（ほぼ引き返す折れ線）
  for (let i = 1; i < points.length - 1; i++) {
    const ax = xy[i].x - xy[i - 1].x;
    const ay = xy[i].y - xy[i - 1].y;
    const bx = xy[i + 1].x - xy[i].x;
    const by = xy[i + 1].y - xy[i].y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la > 0 && lb > 0 && (ax * bx + ay * by) / (la * lb) < Math.cos(rad(170))) errors.push(`${i + 1} 番目の点で往復（引き返し）しています`);
  }
  // 自己交差（隣り合わない線分どうし）
  for (let i = 0; i < xy.length - 1; i++) {
    for (let j = i + 2; j < xy.length - 1; j++) {
      if (segIntersect(xy[i], xy[i + 1], xy[j], xy[j + 1])) errors.push(`線分 ${i + 1} と ${j + 1} が交差しています（自己交差は初版では未対応）`);
    }
  }
  return { ok: errors.length === 0, errors };
}
