// index.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// 1. データストア (全データおよびデモ用抽出データの準備)
// ---------------------------------------------------------
let signalsData = [];
let allSignalsDataF02 = [];

try {
  // 全データの読み込み
  const fullDataPath = path.join(__dirname, 'CSVtoDataset', 'hokkaido_all_signals.json');
  const fullRawData = fs.readFileSync(fullDataPath, 'utf-8');
  const allHokkaidoData = JSON.parse(fullRawData);

  // 【P2拡張用】全データをF-02フォーマットへ変換（マップ描画などに利用）
  allSignalsDataF02 = allHokkaidoData.map(signal => {
    const greenS = Math.max(0, signal["青信号時間"] - 5); 
    const yellowS = 5;
    const redS = signal["赤信号時間"];
    const cycleS = greenS + yellowS + redS; 

    return {
      signalId: `hokkaido_${signal["地域"]}_${signal["交差点番号"]}`,
      region: signal["地域"],
      lat: signal["緯度"],
      lon: signal["経度"],
      cycleS: cycleS,
      greenS: greenS,
      yellowS: yellowS,
      redS: redS,
      phaseS: 0,
      crossingM: 15.0,
      note: "※JARTICビッグデータ抽出分"
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

  // デモ用配列の生成
  signalsData = filteredData.map(signal => {
    const greenS = Math.max(0, signal["青信号時間"] - 5); 
    const yellowS = 5;
    const redS = signal["赤信号時間"];
    const cycleS = greenS + yellowS + redS; 

    return {
      signalId: `sapporo_${signal["交差点番号"]}`,
      cycleS: cycleS,
      greenS: greenS,
      yellowS: yellowS,
      redS: redS,
      phaseS: 0,         
      crossingM: 15.0,   
      note: "※JARTIC由来の参考プリセット（車両用データ流用）" // ← 「車両用データ流用」を復元
    };
  });
  console.log(`✅ デモ用データ準備完了: ${signalsData.length} 件抽出`);
} catch (error) {
  console.error("❌ データの読み込みに失敗しました:", error.message);
}

// キャリブレーションとログのインメモリ保存用変数
let userCalibrationData = { 歩幅: 0.8, 通常BPM: 150 };
let runLogs = [];

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
  const { 歩幅, 通常BPM } = body;
  
  // バリデーションチェック
  if (typeof 歩幅 !== 'number' || 歩幅 <= 0 || typeof 通常BPM !== 'number' || 通常BPM <= 0) {
    return res.status(400).json({ ステータス: "エラー", メッセージ: "正の数値を入力してください" });
  }
  userCalibrationData = { 歩幅, 通常BPM };
  res.status(200).json({ ステータス: "成功", データ: userCalibrationData });
});

// [GET] キャリブレーションの取得
app.get('/api/calibration', (req, res) => {
  res.status(200).json({ ステータス: "成功", データ: userCalibrationData });
});

// [POST] 走行ログの保存
app.post('/api/logs', (req, res) => {
  const logData = req.body ?? {};
  // 空リクエストの除外
  if (Object.keys(logData).length === 0) {
    return res.status(400).json({ ステータス: "エラー", メッセージ: "データが空です" });
  }
  runLogs.push({ 時刻: new Date().toISOString(), ...logData });
  res.status(201).json({ ステータス: "成功", 総ログ数: runLogs.length });
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