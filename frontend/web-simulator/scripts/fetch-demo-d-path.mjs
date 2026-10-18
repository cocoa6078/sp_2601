// 固定デモ D（5 交差点）用の道沿い経路 DEMO_D_WALK_PATH を OSRM foot から 1 回だけ取得して表示する（実行時には使わない。手動で実行し、結果を src/fixtures.js に貼る）。
// 使い方: node scripts/fetch-demo-d-path.mjs [margin手前m margin先m]   既定: 最初の交差点の 350 m 手前 → 最後の交差点の 250 m 先（fixtures.js 側で 300 m / 200 m に切り出す）
// 出典: OSRM（FOSSGIS 公開サーバー）・© OpenStreetMap contributors。利用条件（1 リクエスト/秒・大量利用禁止）は README の「道沿い経路（OSRM）」参照。
import { fetchWalkRoute } from '../src/walk-routing.js';
import { FIXTURE_SIGNALS } from '../src/fixtures.js';
import { buildRoute, projectOnRoute, validateRoute } from '../src/route-geometry.js';

const [before = 350, after = 250] = process.argv.slice(2).filter((a) => !a.startsWith('--')).map(Number);
const DEG_PER_M = 1 / 111195;
const byId = (n) => FIXTURE_SIGNALS.find((f) => f.signalId === `sapporo_${n}`);
const first = byId(3);
const last = byId(5);
// sapporo_3（北）→ sapporo_5（南）。南北の並びなので、最初の交差点の北側から最後の交差点の南側までを取る
// 5 交差点は直線上ではないので、各交差点を経由点にして道沿いに通す（--no-via で開始・終了だけにもできる）
// --skip=2,... は経由点にしない交差点（経由点が脇道に吸着すると引き返しが出るため）
const skip = (process.argv.find((a) => a.startsWith('--skip='))?.slice(7) ?? '').split(',').filter(Boolean).map(Number);
const vias = process.argv.includes('--no-via') ? [] : [3, 8, 2, 1, 5].filter((n) => !skip.includes(n)).map((n) => ({ lat: byId(n).lat, lng: byId(n).lng }));
const pts = await fetchWalkRoute([{ lat: first.lat + before * DEG_PER_M, lng: first.lng }, ...vias, { lat: last.lat - after * DEG_PER_M, lng: last.lng }]);
const route = buildRoute(pts);
const order = [3, 8, 2, 1, 5].map((n) => ({ id: `sapporo_${n}`, ...projectOnRoute(route, byId(n)) }));
console.error(JSON.stringify({ n: pts.length, lengthM: route.lengthM, signals: order.map((o) => ({ id: o.id, s: Math.round(o.s), offsetM: +o.distM.toFixed(1) })), validate: validateRoute(route), fetchedAt: new Date().toISOString() }, null, 1));
console.log(JSON.stringify(pts.map((p) => [Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6))])));
