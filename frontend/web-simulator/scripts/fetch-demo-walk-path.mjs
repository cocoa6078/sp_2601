// 固定デモ用の道沿い経路 DEMO_WALK_PATH を OSRM foot から 1 回だけ取得して表示する（実行時には使わない。手動で実行し、結果を src/fixtures.js に貼る）。
// 使い方: node scripts/fetch-demo-walk-path.mjs [startLng startLat endLng endLat]
// 出典: OSRM（FOSSGIS 公開サーバー）・© OpenStreetMap contributors。利用条件（1 リクエスト/秒・大量利用禁止）は README の「道沿い経路（OSRM）」参照。
import { fetchWalkRoute } from '../src/walk-routing.js';
import { FIXTURE_SIGNALS } from '../src/fixtures.js';
import { buildRoute, distanceM, projectOnRoute, validateRoute } from '../src/route-geometry.js';

const sig1 = FIXTURE_SIGNALS.find((f) => f.signalId === 'sapporo_1');
const [sLng = 141.3414, sLat = 43.059, eLng = 141.3562, eLat = 43.059] = process.argv.slice(2).map(Number);
const pts = await fetchWalkRoute([{ lat: sLat, lng: sLng }, { lat: eLat, lng: eLng }]);
const route = buildRoute(pts);
const proj = projectOnRoute(route, sig1);
const others = FIXTURE_SIGNALS.filter((f) => f !== sig1).map((f) => `${f.signalId}:${projectOnRoute(route, f).distM.toFixed(0)}m`);
console.error(JSON.stringify({ n: pts.length, lengthM: route.lengthM, sig1: { s: proj.s, offsetM: proj.distM }, before: proj.s, after: route.lengthM - proj.s, others, validate: validateRoute(route), fetchedAt: new Date().toISOString(), startSnap: distanceM(pts[0], { lat: sLat, lng: sLng }) }, null, 1));
console.log(JSON.stringify(pts.map((p) => [Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6))])));
