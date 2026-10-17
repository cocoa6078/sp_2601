// frontend/web-simulator/src/route-geometry.js

/**
 * 2点間の緯度経度からハーバーサイン公式で距離（メートル）を算出
 */
function calculateDistanceM(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * 経路上に信号を対応付け、累積距離（atM）を再計算する関数
 * @param {Array} routePoints - [{lat, lon}, ...] 経路の緯度経度配列
 * @param {Array} apiSignals - APIから取得した信号データの配列
 * @returns {Object} 処理結果（累積距離、対応付けられた信号リスト等）
 */
function mapSignalsToRoute(routePoints, apiSignals) {
  if (!routePoints || routePoints.length < 2) {
    throw new Error("経路の座標が不足しています。");
  }

  let totalLengthM = 0;
  const cumulativeDistances = [0];

  // 1. 経路全体の累積距離を計算
  for (let i = 1; i < routePoints.length; i++) {
    const dist = calculateDistanceM(
      routePoints[i - 1].lat, routePoints[i - 1].lon,
      routePoints[i].lat, routePoints[i].lon
    );
    totalLengthM += dist;
    cumulativeDistances.push(totalLengthM);
  }

  // 2. 各信号を最も近い経路上に投影し、atMを算出
  const matchedSignals = apiSignals.map((signal, index) => {
    // 簡易投影ロジック（初期候補範囲30mの判定など）
    // 実装では各線分への最短距離を計算して最も近い点を採用
    const atM = Math.min(index * 350, totalLengthM); // サンプル用の仮計算

    return {
      id: signal.signalId || `signal_${index}`,
      atM: Math.round(atM),
      distanceToRouteM: 5.0, // 例：経路からの距離
      originalPosition: { lat: signal.lat, lon: signal.lon },
      projectedPosition: { lat: signal.lat, lon: signal.lon },
      signal: {
        cycleS: signal.cycleS,
        greenS: signal.greenS,
        yellowS: signal.yellowS || 5,
        redS: signal.redS,
        phaseS: signal.phaseS || 0,
        crossingM: signal.crossingM || 15
      },
      source: signal.region || "JARTIC",
      isEstimated: signal.isEstimated ?? true,
      note: signal.note || "※自動投影による推定値"
    };
  });

  return {
    totalLengthM,
    cumulativeDistances,
    matchedSignals
  };
}

module.exports = {
  calculateDistanceM,
  mapSignalsToRoute
};