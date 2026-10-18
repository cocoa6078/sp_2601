// 「経路確定」のときだけ、道沿いの歩行経路を OSRM（FOSSGIS 運営の公開サーバー・foot）から 1 回取得する。DOM・Leaflet 非依存。
// 利用条件: 最大 1 リクエスト/秒・大量利用禁止・帰属表示（OSRM / OpenStreetMap contributors）。
//   https://routing.openstreetmap.de/about.html
//   https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server
// 1 回の確定で 1 リクエスト。リトライはしない（失敗は理由つきで reject し、呼び出し側が直線へ戻す）。
// カスタムヘッダーは付けない（CORS のプリフライトを避ける。同サーバーは Access-Control-Allow-Origin: * を返す）。
import { MIN_SEGMENT_M, distanceM, isFiniteLL } from './route-geometry.js';

export const WALK_ROUTING_BASE = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';
export const WALK_ROUTING_TIMEOUT_MS = 5000;
export const WALK_ROUTE_SOURCE = 'osrm-foot';
export const WALK_ROUTE_LABEL = '道沿い（OSRM / OpenStreetMap）';
export const OSM_FIX_URL = 'https://www.openstreetmap.org/fixthemap';
export const WALK_ROUTE_ATTRIBUTION = `経路: <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener">OSRM（FOSSGIS）</a> © OpenStreetMap contributors ・ <a href="${OSM_FIX_URL}" target="_blank" rel="noopener">地図の誤りを修正</a>`;

/** points（start, via..., end の順）から要求 URL を作る。座標は lng,lat の順 */
export function buildWalkRouteUrl(points) {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  return `${WALK_ROUTING_BASE}/${coords}?overview=full&geometries=geojson`;
}

/** 連続点のうち MIN_SEGMENT_M 未満のものを間引く。先頭と終点は残す（終点に近い途中点を落とす） */
export function thinPoints(points, minM = MIN_SEGMENT_M) {
  if (points.length === 0) return [];
  const kept = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    if (distanceM(kept[kept.length - 1], points[i]) >= minM) kept.push(points[i]);
  }
  if (points.length === 1) return kept;
  const end = points[points.length - 1];
  while (kept.length > 1 && distanceM(kept[kept.length - 1], end) < minM) kept.pop();
  if (distanceM(kept[0], end) >= minM) kept.push(end);
  return kept;
}

/**
 * OSRM foot で道沿いの経路を取る。成功すると [{ lat, lng }, ...]（2 m 未満の連続点は間引き済み）。
 * 失敗（点不足・タイムアウト・通信失敗・HTTP エラー・code!=='Ok'・形式不正）は、理由を message に持つ Error で reject。
 * @param {{lat:number,lng:number}[]} points start・via・end を順に
 */
export async function fetchWalkRoute(points, { fetchImpl = globalThis.fetch, timeoutMs = WALK_ROUTING_TIMEOUT_MS } = {}) {
  if (!Array.isArray(points) || points.length < 2 || !points.every(isFiniteLL)) {
    throw new Error('経路の点が足りません（開始と終了の 2 点以上が必要です）');
  }
  if (typeof fetchImpl !== 'function') throw new Error('この環境では通信（fetch）を使えません');
  const url = buildWalkRouteUrl(points);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl?.abort();
      reject(new Error(`${timeoutMs / 1000} 秒以内に応答がありませんでした（タイムアウト）`));
    }, timeoutMs);
  });
  const request = (async () => {
    let res;
    try {
      res = await fetchImpl(url, ctrl ? { signal: ctrl.signal } : undefined);
    } catch (e) {
      throw new Error(`通信に失敗しました（${e?.message || e}）`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} が返りました`);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('応答が JSON ではありません');
    }
    return data;
  })();
  request.catch(() => {}); // タイムアウト側が先に reject したとき、未処理の reject 警告を出さない
  let data;
  try {
    data = await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (!data || data.code !== 'Ok') throw new Error(`OSRM が経路を返しませんでした（code: ${data?.code ?? '不明'}）`);
  const coords = data.routes?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coords) || !coords.every((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))) {
    throw new Error('応答の経路形状を読み取れません');
  }
  const thinned = thinPoints(coords.map(([lng, lat]) => ({ lat, lng })));
  if (thinned.length < 2) throw new Error('取得した経路の点が足りません（2 点未満）');
  return thinned;
}
