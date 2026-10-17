// 模擬信号の fixture（API なしでも動かすための明示的な模擬データ。実 API の成功応答ではない）
// 由来: backend/scraped_coordinates.json（札幌方面 page_id=1 の交差点 1,2,3,5,8 の座標）と
//       backend/sapporo_signals.json（サイクル長・青・赤）を、backend/index.js の変換規則
//       （yellowS=5 固定、greenS=青信号時間−5）に合わせて手で写したもの。
// 位相 phaseS は backend の dynamicPhaseS（index×15）に合わせた【仮】。座標が実際の横断歩道位置かは未確認。
export const FIXTURE_ORIGIN = 'fixture:backend-snapshot';

const mk = (n, order, lat, lng, cycle, green, red) => ({
  key: `fixture:sapporo_${n}`,
  region: 'fixture',
  signalId: `sapporo_${n}`,
  lat,
  lng,
  signal: { cycleS: cycle, greenS: green - 5, yellowS: 5, redS: red, phaseS: order * 15, crossingM: 15 },
  origin: FIXTURE_ORIGIN,
  note: '模擬信号（fixture）。車両用データ由来・位相は仮',
});

// 順序は backend の指定順 3 → 8 → 2 → 1 → 5
export const FIXTURE_SIGNALS = [
  mk(3, 0, 43.06677002, 141.35050919, 125, 44, 81),
  mk(8, 1, 43.06438956, 141.35114444, 100, 32, 68),
  mk(2, 2, 43.06204523, 141.35170783, 125, 60, 65),
  mk(1, 3, 43.05900006, 141.35248547, 145, 36, 109),
  mk(5, 4, 43.05567525, 141.35331801, 145, 55, 90),
];

// 固定デモ「模式コース」: 札幌 fixture の sapporo_1 が経路の 2/3（400m/600m）に来るよう南北にほぼ直線で置く。
// 400m 分の緯度差 = 400 / 111195 度。折れ線として 3 点（中間点は直線上）
const DEG_PER_M = 1 / 111195;
const sig1 = FIXTURE_SIGNALS[3];
export const DEMO_ROUTE_POINTS = [
  { lat: sig1.lat - 400 * DEG_PER_M, lng: sig1.lng },
  { lat: sig1.lat - 100 * DEG_PER_M, lng: sig1.lng },
  { lat: sig1.lat + 200 * DEG_PER_M, lng: sig1.lng },
];

export const MAP_CENTER = { lat: 43.0625, lng: 141.3520 }; // 札幌付近
