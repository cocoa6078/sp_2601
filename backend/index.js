// index.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// 2点間の緯度経度から実際の直線距離（メートル）を算出するハーバーサイン公式
function calculateDistanceM(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // 地球の半径 (m)
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // メートル単位
}

// ---------------------------------------------------------
// 0. ファイルパスおよびストレージの初期設定
// ---------------------------------------------------------
const logsFilePath = path.join(__dirname, 'logs.json');

// キャリブレーション設定データの初期値（早歩き歩幅を追加）
let userCalibrationData = { 
  "歩幅": 0.8, 
  "通常BPM": 150, 
  "walkStrideM": 0.75 
};
let runLogs = [];

// サーバー起動時にログファイル（logs.json）を読み込む
try {
  if (fs.existsSync(logsFilePath)) {
    const fileData = fs.readFileSync(logsFilePath, 'utf-8');
    runLogs = JSON.parse(fileData);
    console.log(`📂 既存のログファイルから ${runLogs.length} 件のログを読み込みました。`);
  }
} catch (error) {
  console.error("❌ ログファイルの読み込みに失敗しました:", error.message);
}

// ---------------------------------------------------------
// 1. データストア (全データおよびデモ用抽出データの準備)
// ---------------------------------------------------------
let signalsData = [];
let allSignalsDataF02 = [];

try {
  // 1. 全データの読み込み
  const fullDataPath = path.join(__dirname, 'CSVtoDataset', 'hokkaido_all_signals.json');
  const fullRawData = fs.readFileSync(fullDataPath, 'utf-8');
  const allHokkaidoData = JSON.parse(fullRawData);

  // 2. スクレイピングした正確な緯度経度データの読み込み
  const scrapedCoordPath = path.join(__dirname, 'scraped_coordinates.json');
  let coordMap = {};
  if (fs.existsSync(scrapedCoordPath)) {
    const scrapedData = JSON.parse(fs.readFileSync(scrapedCoordPath, 'utf-8'));
    // 地域インデックス（page_id）と交差点番号をキーにして緯度経度をマップ化
    // page_id: 1=札幌方面, 2=旭川方面, 3=函館方面, 4=釧路方面, 5=北見方面 の順序に対応
    const pageIdToRegion = { 1: "札幌方面", 2: "旭川方面", 3: "函館方面", 4: "釧路方面", 5: "北見方面" };
    scrapedData.forEach(item => {
      const regionName = pageIdToRegion[item.page_id];
      const key = `${regionName}_${item.交差点番号}`;
      coordMap[key] = { lat: item["緯度"], lon: item["経度"] };
    });
    console.log(`✅ 正確な座標データ(${scrapedData.length}件)のロード完了`);
  }

  // 3. 全データをF-02フォーマットへ変換（スクレイピング座標を結合）
  allSignalsDataF02 = allHokkaidoData.map(signal => {
    const greenS = Math.max(0, signal["青信号時間"] - 5); 
    const yellowS = 5;
    const redS = signal["赤信号時間"];
    const cycleS = greenS + yellowS + redS; 

    // スクレイピングで取得した正確な座標があれば上書き、なければ元の値を使用
    const coordKey = `${signal["地域"]}_${signal["交差点番号"]}`;
    const preciseCoord = coordMap[coordKey];
    const lat = preciseCoord ? preciseCoord.lat : signal["緯度"];
    const lon = preciseCoord ? preciseCoord.lon : signal["経度"];

    return {
      signalId: `hokkaido_${signal["地域"]}_${signal["交差点番号"]}`,
      region: signal["地域"],
      lat: lat,
      lon: lon,
      cycleS: cycleS,
      greenS: greenS,
      yellowS: yellowS,
      redS: redS,
      phaseS: 0,
      crossingM: 15.0,
      isEstimated: true,
      note: "※JARTICビッグデータ抽出分（実測・スクレイピング座標適用）"
    };
  });
  console.log(`✅ 全データロード成功: ${allSignalsDataF02.length}件のF-02変換完了`);

  // 【P0デモ用】札幌駅〜すすきの間（交差点番号: 3, 8, 2, 1, 5）の抽出
  const targetIds = [3, 8, 2, 1, 5];
  const filteredData = allHokkaidoData.filter(signal => 
    signal["地域"] === "札幌方面" && targetIds.includes(signal["交差点番号"])
  );

  // 指定順序 (3 -> 8 -> 2 -> 1 -> 5) でソート
  const orderMap = { 3: 1, 8: 2, 2: 3, 1: 4, 5: 5 };
  filteredData.sort((a, b) => orderMap[a["交差点番号"]] - orderMap[b["交差点番号"]]);

  // デモ用配列の生成（ハーバーサイン公式による動的距離計算版：正確な座標を使用）
  let accumulatedDistance = 0;
  signalsData = filteredData.map((signal, index) => {
    const greenS = Math.max(0, signal["青信号時間"] - 5);
    const yellowS = 5;
    const redS = signal["赤信号時間"];
    const cycleS = greenS + yellowS + redS;
    const dynamicPhaseS = index * 15;

    // 正確な座標を適用
    const coordKey = `${signal["地域"]}_${signal["交差点番号"]}`;
    const preciseCoord = coordMap[coordKey];
    const lat = preciseCoord ? preciseCoord.lat : signal["緯度"];
    const lon = preciseCoord ? preciseCoord.lon : signal["経度"];

    let distanceFromStartM = 0;
    if (index === 0) {
      accumulatedDistance = 0;
      distanceFromStartM = 0;
    } else {
      const prevSignal = filteredData[index - 1];
      const prevCoordKey = `${prevSignal["地域"]}_${prevSignal["交差点番号"]}`;
      const prevPreciseCoord = coordMap[prevCoordKey];
      const prevLat = prevPreciseCoord ? prevPreciseCoord.lat : prevSignal["緯度"];
      const prevLon = prevPreciseCoord ? prevPreciseCoord.lon : prevSignal["経度"];

      const dist = calculateDistanceM(prevLat, prevLon, lat, lon);
      accumulatedDistance += dist;
      distanceFromStartM = Math.round(accumulatedDistance); // 整数値に丸める
    }

    return {
      signalId: `sapporo_${signal["交差点番号"]}`,
      orderIndex: index + 1,
      lat: lat,
      lon: lon,
      distanceFromStartM: distanceFromStartM, // 動的計算された累積距離 (m)
      cycleS: cycleS,
      greenS: greenS,
      yellowS: yellowS,
      redS: redS,
      phaseS: dynamicPhaseS,
      crossingM: 15.0,
      isEstimated: true,
      note: "※車両用信号のスプリット由来、黄は5秒固定、位相は仮（15秒ずらし）の推定値です。"
    };
  });
  console.log(`✅ デモ用データ準備完了（実測座標・動的距離計算版）: ${signalsData.length} 件抽出`);
} catch (error) {
  console.error("❌ データの読み込みに失敗しました:", error.message);
}

// ---------------------------------------------------------
// 2. API エンドポイント
// ---------------------------------------------------------

// [GET] デモ用データ取得
app.get('/api/signals', (req, res) => {
  res.status(200).json({ ステータス: "成功", データ: signalsData });
});

// [GET] 拡張用：全データ取得
app.get('/api/signals/all', (req, res) => {
  res.status(200).json({
    ステータス: "成功",
    総件数: allSignalsDataF02.length,
    データ: allSignalsDataF02
  });
});

// [GET] 拡張用：地域別データ取得（例: /api/signals/region/函館方面）
app.get('/api/signals/region/:region', (req, res) => {
  const targetRegion = req.params.region;
  const filtered = allSignalsDataF02.filter(s => s.region === targetRegion);
  
  if (filtered.length === 0) {
    return res.status(404).json({ ステータス: "エラー", メッセージ: "該当地域のデータがありません" });
  }
  res.status(200).json({ ステータス: "成功", 地域: targetRegion, 件数: filtered.length, データ: filtered });
});

// [POST] キャリブレーションの保存
app.post('/api/calibration', (req, res) => {
  const body = req.body ?? {};
  const { 歩幅, 通常BPM, walkStrideM } = body;
  
  // キーの揺れ（NormalBPM または 通常BPM）を考慮した受取
  const targetBpm = 通常BPM !== undefined ? 通常BPM : body.NormalBPM;

  if (typeof 歩幅 !== 'number' || 歩幅 <= 0 || typeof targetBpm !== 'number' || targetBpm <= 0) {
    return res.status(400).json({ ステータス: "エラー", メッセージ: "歩幅と通常BPMは正の数値である必要があります。" });
  }

  if (walkStrideM !== undefined && (typeof walkStrideM !== 'number' || walkStrideM <= 0)) {
    return res.status(400).json({ ステータス: "エラー", メッセージ: "早歩きの歩幅は正の数値である必要があります。" });
  }

  userCalibrationData = { 
    "歩幅": 歩幅, 
    "通常BPM": targetBpm, 
    "walkStrideM": walkStrideM !== undefined ? walkStrideM : userCalibrationData.walkStrideM 
  };

  res.status(200).json({
    ステータス: "成功",
    データ: userCalibrationData
  });
});

// [GET] キャリブレーションの取得
app.get('/api/calibration', (req, res) => {
  res.status(200).json({ ステータス: "成功", データ: userCalibrationData });
});

// [POST] 走行ログの保存
app.post('/api/logs', (req, res) => {
  const logData = req.body ?? {};
  
  if (Object.keys(logData).length === 0) {
    return res.status(400).json({ ステータス: "エラー", メッセージ: "データが空です" });
  }

  const { gait, walkCount, walkTimeS, walkDistanceM } = logData;
  if (gait !== undefined && gait !== "run" && gait !== "walk") {
    return res.status(400).json({ ステータス: "エラー", メッセージ: "gaitは run または walk である必要があります。" });
  }

  if (
    (walkCount !== undefined && (typeof walkCount !== 'number' || walkCount < 0)) ||
    (walkTimeS !== undefined && (typeof walkTimeS !== 'number' || walkTimeS < 0)) ||
    (walkDistanceM !== undefined && (typeof walkDistanceM !== 'number' || walkDistanceM < 0))
  ) {
    return res.status(400).json({ ステータス: "エラー", メッセージ: "早歩き関連の数値は負の値にできません。" });
  }

  const newLog = { 
    id: `log_${Date.now()}`,
    時刻: new Date().toISOString(), 
    ...logData 
  };
  
  runLogs.push(newLog);

  try {
    fs.writeFileSync(logsFilePath, JSON.stringify(runLogs, null, 2), 'utf-8');
  } catch (error) {
    console.error("ログのファイル保存に失敗しました:", error.message);
  }

  res.status(201).json({
    ステータス: "成功",
    id: newLog.id,
    総ログ数: runLogs.length
  });
});

// [GET] 走行ログ単件取得
app.get('/api/logs/:id', (req, res) => {
  const logId = req.params.id;
  const targetLog = runLogs.find(log => log.id === logId);

  if (!targetLog) {
    return res.status(404).json({ ステータス: "エラー", メッセージ: "指定されたログが見つかりません" });
  }

  res.status(200).json({
    ステータス: "成功",
    データ: targetLog
  });
});

// [GET] 走行ログ一覧の取得
app.get('/api/logs', (req, res) => {
  res.status(200).json({ ステータス: "成功", データ: runLogs });
});

// ---------------------------------------------------------
// 3. エラーハンドリング
// ---------------------------------------------------------

// 404 エラーハンドリング
app.use((req, res, next) => {
  res.status(404).json({ ステータス: "エラー", メッセージ: "指定されたエンドポイントは見つかりません" });
});

// グローバルエラーハンドリング（JSONパース失敗等）
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ ステータス: "エラー", メッセージ: "無効なJSONフォーマットです" });
  }
  res.status(err.status || 500).json({ ステータス: "エラー", メッセージ: "サーバーエラーが発生しました" });
});

// ---------------------------------------------------------
// 4. サーバー起動
// ---------------------------------------------------------
const PORT = process.env.PORT || 3001; 
app.listen(PORT, () => {
  console.log(`🚀 RUNWAVE Backend サーバー起動完了 (ポート: ${PORT})`);
});
module.exports = app;