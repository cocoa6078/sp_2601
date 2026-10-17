// index.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// 1. データストア (JSONファイルからの読み込み / インメモリ)
// ---------------------------------------------------------

let signalsData = [];

try {
  const filePath = path.join(__dirname, 'sapporo_signals.json');
  const rawData = fs.readFileSync(filePath, 'utf-8');
  const parsedData = JSON.parse(rawData);
  
  // B1: 信号データを仕様F-02の形（greenS, yellowS, redS, phaseS, crossingM）に変換
  signalsData = parsedData.map(signal => {
    // 青信号時間から5秒を黄信号（点滅）として扱う
    const greenS = Math.max(0, signal["青信号時間"] - 5); 
    const yellowS = 5;
    const redS = signal["赤信号時間"];
    
    // greenS + yellowS + redS === cycleS になるように計算
    const cycleS = greenS + yellowS + redS; 

    return {
      signalId: `sapporo_${signal["交差点番号"]}`,
      cycleS: cycleS,
      greenS: greenS,
      yellowS: yellowS,
      redS: redS,
      phaseS: 0,         // 初期位相（デモ時にS5でUIから上書き可能）
      crossingM: 15.0,   // 横断歩道の距離（仮のプリセット値）
      note: "※JARTIC由来の参考プリセット（車両用データ流用）"
    };
  });
  console.log("信号データのロードとF-02フォーマットへの変換が完了しました。");
} catch (error) {
  console.error("sapporo_signals.jsonの読み込みに失敗しました:", error.message);
}

let userCalibrationData = { 歩幅: 0.8, 通常BPM: 150 };
let runLogs = [];

// ---------------------------------------------------------
// 2. API エンドポイント
// ---------------------------------------------------------

// GET /api/signals
app.get('/api/signals', (req, res) => {
  res.status(200).json({
    ステータス: "成功",
    データ: signalsData
  });
});

// POST /api/calibration
app.post('/api/calibration', (req, res) => {
  // B2: ボディなしでPOSTされても落ちないようにする
  const body = req.body ?? {};
  const { 歩幅, 通常BPM } = body;

  // B3: 歩幅・BPMが数値で、正の値かをチェックする
  if (typeof 歩幅 !== 'number' || 歩幅 <= 0 || typeof 通常BPM !== 'number' || 通常BPM <= 0) {
    return res.status(400).json({ 
      ステータス: "エラー", 
      メッセージ: "歩幅と通常BPMは正の数値である必要があります。" 
    });
  }

  userCalibrationData = { 歩幅, 通常BPM };
  res.status(200).json({
    ステータス: "成功",
    データ: userCalibrationData
  });
});

// GET /api/calibration
app.get('/api/calibration', (req, res) => {
  res.status(200).json({
    ステータス: "成功",
    データ: userCalibrationData
  });
});

// POST /api/logs
app.post('/api/logs', (req, res) => {
  const logData = req.body ?? {};
  const newLog = { 時刻: new Date().toISOString(), ...logData };
  runLogs.push(newLog);

  res.status(201).json({
    ステータス: "成功",
    総ログ数: runLogs.length
  });
});

// B4: GET /api/logs を追加
app.get('/api/logs', (req, res) => {
  res.status(200).json({
    ステータス: "成功",
    データ: runLogs
  });
});

// ---------------------------------------------------------
// 3. サーバー起動
// ---------------------------------------------------------
const PORT = process.env.PORT || 3001; 
app.listen(PORT, () => {
  console.log(`RUNWAVE Backend サーバーがポート ${PORT} で起動しました。`);
});
module.exports = app;