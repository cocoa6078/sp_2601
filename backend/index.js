// index.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

let signalsData = [];

// ---------------------------------------------------------
// 1. データストア (全北海道の統合データから特定ルートを抽出)
// ---------------------------------------------------------
try {
  // 修正: CSVtoDataset フォルダ内の hokkaido_all_signals.json を参照
  const filePath = path.join(__dirname, 'CSVtoDataset', 'hokkaido_all_signals.json');
  const rawData = fs.readFileSync(filePath, 'utf-8');
  const allHokkaidoData = JSON.parse(rawData);
  
  // デモ対象の札幌駅〜すすきの間（交差点番号: 3, 8, 2, 1, 5）のみを抽出
  const targetIds = [3, 8, 2, 1, 5];
  
  const filteredData = allHokkaidoData.filter(signal => 
    signal["地域"] === "札幌方面" && targetIds.includes(signal["交差点番号"])
  );

  // 指定された順番(3 -> 8 -> 2 -> 1 -> 5)に並び替え
  const orderMap = { 3: 1, 8: 2, 2: 3, 1: 4, 5: 5 };
  filteredData.sort((a, b) => orderMap[a["交差点番号"]] - orderMap[b["交差点番号"]]);

  // B1: 信号データを仕様F-02の形に変換
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
      note: "※JARTIC由来の参考プリセット"
    };
  });
  
  console.log(`✅ データロード成功: hokkaido_all_signals.json からデモ用 ${signalsData.length} 件を抽出しました。`);
} catch (error) {
  console.error("❌ データの読み込みに失敗しました。パスを確認してください:", error.message);
}

let userCalibrationData = { 歩幅: 0.8, 通常BPM: 150 };
let runLogs = [];

// ---------------------------------------------------------
// 2. API エンドポイント (変更なし)
// ---------------------------------------------------------
app.get('/api/signals', (req, res) => {
  res.status(200).json({ ステータス: "成功", データ: signalsData });
});

app.post('/api/calibration', (req, res) => {
  const body = req.body ?? {};
  const { 歩幅, 通常BPM } = body;
  if (typeof 歩幅 !== 'number' || 歩幅 <= 0 || typeof 通常BPM !== 'number' || 通常BPM <= 0) {
    return res.status(400).json({ ステータス: "エラー", メッセージ: "歩幅と通常BPMは正の数値である必要があります。" });
  }
  userCalibrationData = { 歩幅, 通常BPM };
  res.status(200).json({ ステータス: "成功", データ: userCalibrationData });
});

app.get('/api/calibration', (req, res) => {
  res.status(200).json({ ステータス: "成功", データ: userCalibrationData });
});

app.post('/api/logs', (req, res) => {
  const logData = req.body ?? {};
  if (Object.keys(logData).length === 0) {
    return res.status(400).json({ 
      ステータス: "エラー", 
      メッセージ: "ログデータが空です。" 
    });
  }

  const newLog = { 時刻: new Date().toISOString(), ...logData };
  runLogs.push(newLog);

  res.status(201).json({
    ステータス: "成功",
    総ログ数: runLogs.length
  });
});

app.get('/api/logs', (req, res) => {
  res.status(200).json({ ステータス: "成功", データ: runLogs });
});

app.get('/api/signals/all', (req, res) => {
  try {
    const rawData = fs.readFileSync(path.join(__dirname, 'CSVtoDataset', 'hokkaido_all_signals.json'), 'utf-8');
    res.status(200).json({ ステータス: "成功", 総件数: 384, データ: JSON.parse(rawData) });
  } catch (error) {
    res.status(500).json({ ステータス: "エラー", メッセージ: "全データ取得失敗" });
  }
});

app.use((req, res, next) => {
  res.status(404).json({ 
    ステータス: "エラー", 
    メッセージ: "指定されたエンドポイントは見つかりません" 
  });
});

// グローバルエラーハンドリング (壊れたJSONなどのパースエラー時もJSONを返す) (イシュー11対応)
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ 
      ステータス: "エラー", 
      メッセージ: "無効なJSONフォーマットです" 
    });
  }
  res.status(err.status || 500).json({ 
    ステータス: "エラー", 
    メッセージ: "リクエストを処理できませんでした" 
  });
});

const PORT = process.env.PORT || 3001; 
app.listen(PORT, () => {
  console.log(`🚀 RUNWAVE Backend サーバーがポート ${PORT} で起動しました。`);
});
module.exports = app;