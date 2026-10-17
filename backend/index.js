// index.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------
// 0. ファイルパスおよびストレージの初期設定
// ---------------------------------------------------------
const logsFilePath = path.join(__dirname, 'logs.json');

let userCalibrationData = { 歩幅: 0.8, 通常BPM: 150 };
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
      //signalId: `hokkaido_${signal["地域"]}_${signal["交差点番号"]}`,
      signalId: `sapporo_${signal["交差点番号"]}`,
      region: signal["地域"],
      lat: signal["緯度"],
      lon: signal["経度"],
      cycleS: cycleS,
      greenS: greenS,
      yellowS: yellowS,
      redS: redS,
      phaseS: 0,
      crossingM: 15.0,
      isEstimated: true, // 推定値フラグ
      //note: "※JARTICビッグデータ抽出分"
      note: "※車両用信号のスプリット由来、黄は5秒固定、位相は仮（15秒ずらし）の推定値です。"
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
  /*
  // デモ用配列の生成（動的位相計算版）
  signalsData = filteredData.map((signal, index) => {
    const greenS = Math.max(0, signal["青信号時間"] - 5);
    const yellowS = 5;
    const redS = signal["赤信号時間"];
    const cycleS = greenS + yellowS + redS;

    const dynamicPhaseS = index * 15;

    return {
      signalId: `sapporo_${signal["交差点番号"]}`,
      cycleS: cycleS,
      greenS: greenS,
      yellowS: yellowS,
      redS: redS,
      phaseS: dynamicPhaseS,
      crossingM: 15.0,
      note: "※JARTIC由来の参考プリセット（車両用データ流用・位相自動計算版）"
    };
  });
  */
  signalsData = filteredData.map((signal, index) => {
    const greenS = Math.max(0, signal["青信号時間"] - 5); 
    const yellowS = 5;
    const redS = signal["赤信号時間"];
    const cycleS = greenS + yellowS + redS; 

    // 仮のコース上の累積距離（m）を付与（例: 0m, 350m, 700m, 1050m, 1400m）
    const estimatedDistances = [0, 350, 700, 1050, 1400];

    return {
      signalId: `sapporo_${signal["交差点番号"]}`,
      orderIndex: index + 1,                    // 交差点的順序
      lat: signal["緯度"] || 43.0687,           // 緯度
      lon: signal["経度"] || 141.3508,          // 経度
      distanceFromStartM: estimatedDistances[index], // スタートからの距離(m)
      cycleS: cycleS,
      greenS: greenS,
      yellowS: yellowS,
      redS: redS,
      phaseS: index * 15,
      crossingM: 15.0,
      note: "※JARTIC由来の参考プリセット（車両用データ流用）"
    };
  });
  console.log(`✅ デモ用データ準備完了: ${signalsData.length} 件抽出`);
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
  const { 歩幅, 通常BPM } = body;
  
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
// 詳細な走行履歴（history）を受け取る POST /api/logs の拡張
app.post('/api/logs', (req, res) => {
  const logData = req.body ?? {};
  
  if (Object.keys(logData).length === 0) {
    return res.status(400).json({ ステータス: "エラー", メッセージ: "データが空です" });
  }

  const newLog = { 
    id: `log_${Date.now()}`, // 一意のIDを付与
    時刻: new Date().toISOString(), 
    ...logData // { signalId, summary, history: [{t, x, bpm, ...}] } など
  };
  
  runLogs.push(newLog);

  // ローカル環境のみファイル保存（Vercel本番ではメモリ上で処理）
  try {
    fs.writeFileSync(logsFilePath, JSON.stringify(runLogs, null, 2), 'utf-8');
  } catch (error) {
    console.error("⚠️ 本番環境または書き込み権限がないため、メモリ上にのみ保存します。");
  }

  res.status(201).json({
    ステータス: "成功",
    id: newLog.id,
    総ログ数: runLogs.length
  });
});

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