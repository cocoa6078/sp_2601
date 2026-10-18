// index.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
// ---------------------------------------------------------
// セキュリティの共通設定
// ---------------------------------------------------------
// S1: サーバーの種類を出さない・基本の防御ヘッダー
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
// S1: CORS の許可元。環境変数 CORS_ORIGINS（カンマ区切り）があればそれだけ許可。無ければ従来どおり全許可
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : {}));
// 本文の大きさの上限（express.json の既定と同じ 100KB を明示。新しい制限ではない）
app.use(express.json({ limit: '100kb' }));

// S2: 公開デモでは、全員共通の値の書き換え・ログの閲覧・案内の中継を止める。
// Vercel（本番）では既定で有効（明示的に DEMO_READONLY=0 のときだけ無効）。手元では DEMO_READONLY=1 で有効
const DEMO_READONLY = process.env.DEMO_READONLY === '1' || (process.env.VERCEL === '1' && process.env.DEMO_READONLY !== '0');
function denyInDemo(req, res, next) {
  if (DEMO_READONLY) return sendError(res, 403, "READ_ONLY", "デモ環境ではこの操作は無効です");
  next();
}

// S3: レート制限（IP ごと・1分あたり）。メモリ上なのでサーバーレスではインスタンスごと
// IP は X-Forwarded-For の先頭（Vercel はこのヘッダーを上書きして偽装を防ぐ：公式資料）。ほかの転送ヘッダーは信用しない
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim().slice(0, 64);
  return req.socket.remoteAddress || 'unknown';
}
const RATE_KEYS_MAX = Number(process.env.RUNWAVE_RATE_KEYS_MAX) || 10000; // テストでは環境変数で小さくする
function rateLimit(max, windowMs = 60000) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = clientIp(req);
    let r = hits.get(key);
    if (!r || now - r.windowStart > windowMs) {
      if (!r && hits.size >= RATE_KEYS_MAX) {
        // 期限の過ぎた記録だけを消す（全員分を消すと、偽の IP を大量に送るだけで制限を外せてしまう）
        for (const [k, v] of hits) if (now - v.windowStart > windowMs) hits.delete(k);
        if (hits.size >= RATE_KEYS_MAX) return sendError(res, 429, "RATE_LIMITED", "リクエストが多すぎます。しばらく待ってください");
      }
      r = { windowStart: now, count: 0 };
      hits.set(key, r);
    }
    r.count++;
    if (r.count > max) return sendError(res, 429, "RATE_LIMITED", "リクエストが多すぎます。しばらく待ってください");
    next();
  };
}

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
// 共通ヘルパー（DATA-02 品質項目 / DATA-04 英語キー）
// ---------------------------------------------------------
// 信号1件に品質項目を付ける（既存キーは残す）。値の意味は README 参照。
function withQuality(signal, phaseBasisNote, phaseReference) {
  const phaseBasis = "estimated"; // 正本。isEstimated は派生

  return {
    ...signal,
    signalType: "vehicle",          // 車両用信号（歩行者用ではない）
    phaseBasis,                     // 位相は仮値（正本）
    phaseReference,                 // phaseS の基準: run-start | unix-epoch
    isEstimated: phaseBasis !== "measured", // 派生
    phaseBasisNote,
    positionAccuracyM: null,        // 位置精度は不明
    fetchedAt: null,                // 元データの取得日時が不明
    crossingDirection: null,         // 横断方向は未確認
    quality: phaseBasis          // 品質は位置情報のみ
  };
}
const PHASE_NOTE_DEMO = "位相は仮値（信号の並び順に15秒ずつずらした値）。実測ではありません。";
const PHASE_NOTE_ALL = "位相は仮値（phaseS=0 固定）。実測ではありません。";

// along-route の match に載せる品質項目を信号から取り出す
function pickQuality(signal) {
  const { signalType, phaseBasis, phaseReference, phaseBasisNote, positionAccuracyM, fetchedAt, crossingDirection, quality } = signal;
  return { signalType, phaseBasis, phaseReference, phaseBasisNote, positionAccuracyM, fetchedAt, crossingDirection, quality };
}

// 成功レスポンス: 日本語キーは残し、英語 status:"ok" と generatedAt を追加
function sendOk(res, body, httpStatus = 200) {
  return res.status(httpStatus).json({ 
    ...body, 
    status: "ok",
    generatedAt: new Date().toISOString()
  });
}

// エラーレスポンス: 日本語キー（ステータス/メッセージ）に加え status:"error" と error:{code,message}
function sendError(res, httpStatus, code, message, jpStatus = "エラー") {
  return res.status(httpStatus).json({
    ステータス: jpStatus,
    メッセージ: message,
    status: "error",
    error: { code, message },
    generatedAt: new Date().toISOString()
  });
}

// ---------------------------------------------------------
// 0. ファイルパスおよびストレージの初期設定
// ---------------------------------------------------------
const isVercel = process.env.VERCEL === '1';
const logsFilePath = process.env.RUNWAVE_LOGS_FILE ? process.env.RUNWAVE_LOGS_FILE : isVercel 
  ? path.join('/tmp', 'logs.json') 
  : path.join(__dirname, 'logs.json');

// キャリブレーション設定データの初期値（通常BPMキー統一、早歩き歩幅を追加）
let userCalibrationData = { 
  歩幅: 0.8, 
  通常BPM: 150, 
  walkStrideM: 0.75 
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
    const pageIdToRegion = { 1: "札幌方面", 2: "旭川方面", 3: "函館方面", 4: "釧路方面", 5: "北見方面" };
    scrapedData.forEach(item => {
      const regionName = pageIdToRegion[item.page_id];
      const key = `${regionName}_${item.交差点番号}`;
      coordMap[key] = { lat: item["緯度"], lon: item["経度"] };
    });
    console.log(`✅ 正確な座標データ(${scrapedData.length}件)のロード完了`);
  }

  // 3. 全データをF-02フォーマットへ変換（スクレイピング座標を結合、品質項目付与）
  allSignalsDataF02 = allHokkaidoData.map(signal => {
    const greenS = Math.max(0, signal["青信号時間"] - 5); 
    const yellowS = 5;
    const redS = signal["赤信号時間"];
    const cycleS = greenS + yellowS + redS; 

    const coordKey = `${signal["地域"]}_${signal["交差点番号"]}`;
    const preciseCoord = coordMap[coordKey];
    const lat = preciseCoord ? preciseCoord.lat : signal["緯度"];
    const lon = preciseCoord ? preciseCoord.lon : signal["経度"];

    return withQuality({
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
    }, PHASE_NOTE_ALL, "unix-epoch");
  });
  console.log(`✅ 全データロード成功: ${allSignalsDataF02.length}件のF-02変換完了`);

  // 【P0デモ用】札幌駅〜すすきの間（交差点番号: 3, 8, 2, 1, 5）の抽出
  const targetIds = [3, 8, 2, 1, 5];
  const filteredData = allHokkaidoData.filter(signal => 
    signal["地域"] === "札幌方面" && targetIds.includes(signal["交差点番号"])
  );

  const orderMap = { 3: 1, 8: 2, 2: 3, 1: 4, 5: 5 };
  filteredData.sort((a, b) => orderMap[a["交差点番号"]] - orderMap[b["交差点番号"]]);

  let accumulatedDistance = 0;
  signalsData = filteredData.map((signal, index) => {
    const greenS = Math.max(0, signal["青信号時間"] - 5);
    const yellowS = 5;
    const redS = signal["赤信号時間"];
    const cycleS = greenS + yellowS + redS;
    const dynamicPhaseS = index * 15;

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
      distanceFromStartM = Math.round(accumulatedDistance);
    }

    return withQuality({
      signalId: `sapporo_${signal["交差点番号"]}`,
      orderIndex: index + 1,
      lat: lat,
      lon: lon,
      distanceFromStartM: distanceFromStartM,
      cycleS: cycleS,
      greenS: greenS,
      yellowS: yellowS,
      redS: redS,
      phaseS: dynamicPhaseS,
      crossingM: 15.0,
      isEstimated: true,
      note: "※車両用信号のスプリット由来、黄は5秒固定、位相は仮（15秒ずらし）の推定値です。"
    }, PHASE_NOTE_DEMO, "run-start");
  });
  console.log(`✅ デモ用データ準備完了（実測座標・動的距離計算版）: ${signalsData.length} 件抽出`);
} catch (error) {
  console.error("❌ データの読み込みに失敗しました:", error.message);
}

// ---------------------------------------------------------
// 2. API エンドポイント
// ---------------------------------------------------------

// [GET] ブラウザ手動テスト用ページの配信 (/test)
app.get('/test', (req, res) => {
  const testHtmlPath = path.join(__dirname, 'test.html');
  if (fs.existsSync(testHtmlPath)) {
    res.sendFile(testHtmlPath);
  } else {
    res.status(404).send('test.html が backend ディレクトリに見つかりません。');
  }
});

// [GET] デモ用データ取得
app.get('/api/signals', (req, res) => {
  sendOk(res, { ステータス: "成功", データ: signalsData });
});

// [GET] 拡張用：全データ取得
app.get('/api/signals/all', (req, res) => {
  sendOk(res, {
    ステータス: "成功",
    総件数: allSignalsDataF02.length,
    データ: allSignalsDataF02
  });
});

// [GET] 拡張用：地域別データ取得
app.get('/api/signals/region/:region', (req, res) => {
  const targetRegion = req.params.region;
  const filtered = allSignalsDataF02.filter(s => s.region === targetRegion);
  
  if (filtered.length === 0) {
    return sendError(res, 404, "NOT_FOUND", "該当地域のデータがありません");
  }
  sendOk(res, { ステータス: "成功", 地域: targetRegion, 件数: filtered.length, データ: filtered });
});

// [POST] キャリブレーションの保存
app.post('/api/calibration', denyInDemo, rateLimit(30), (req, res) => {
  const body = req.body ?? {};
  const { 歩幅, 通常BPM, walkStrideM } = body;
  const targetBpm = 通常BPM !== undefined ? 通常BPM : body.NormalBPM;
  
  const strideOk = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3;
  if (!strideOk(歩幅) || typeof targetBpm !== 'number' || !Number.isFinite(targetBpm) || targetBpm < 60 || targetBpm > 220) {
    return sendError(res, 400, "INVALID_INPUT", "歩幅（0〜3m）と通常BPM（60〜220）は有限の数値である必要があります。");
  }

  if (walkStrideM !== undefined && !strideOk(walkStrideM)) {
    return sendError(res, 400, "INVALID_INPUT", "早歩きの歩幅は正の数値である必要があります。");
  }

  userCalibrationData = { 
    歩幅, 
    通常BPM: targetBpm, 
    walkStrideM: walkStrideM !== undefined ? walkStrideM : userCalibrationData.walkStrideM 
  };

  sendOk(res, {
    ステータス: "成功",
    データ: userCalibrationData
  });
});

// [GET] キャリブレーションの取得
app.get('/api/calibration', (req, res) => {
  sendOk(res, { ステータス: "成功", データ: userCalibrationData });
});

// [POST] 走行ログの保存
// S4: 保存する項目を決める（送られた項目を何でも保存しない）。文字列は長さを制限する
const LOG_FIELDS = ['シナリオ', '停止回数', '総所要時間', '停止時間', 'gait', 'walkCount', 'walkTimeS', 'walkDistanceM'];
function pickLog(body) {
  const out = {};
  for (const k of LOG_FIELDS) {
    const v = body[k];
    if (v === undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 100);
  }
  return out;
}

// 既知の項目は保存の前に元の値で検査する（不正な値を黙って落として成功させない）
const LOG_COUNTS = ['停止回数', 'walkCount'];
const LOG_MEASURES = ['総所要時間', '停止時間', 'walkTimeS', 'walkDistanceM'];
function invalidLog(body) {
  if (body['シナリオ'] !== undefined && typeof body['シナリオ'] !== 'string') return "シナリオは文字列です";
  if (body.gait !== undefined && !['run', 'walk'].includes(body.gait)) return "gaitは run または walk である必要があります。";
  if (LOG_COUNTS.some((k) => body[k] !== undefined && (!Number.isSafeInteger(body[k]) || body[k] < 0))) return "回数は0以上の整数です";
  if (LOG_MEASURES.some((k) => body[k] !== undefined && (typeof body[k] !== 'number' || !Number.isFinite(body[k]) || body[k] < 0))) return "時間・距離は0以上の数値です";
  return null;
}

app.post('/api/logs', denyInDemo, rateLimit(30), (req, res) => {
  const body = req.body ?? {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return sendError(res, 400, "INVALID_INPUT", "データはオブジェクトである必要があります");
  }
  const bad = invalidLog(body);
  if (bad) return sendError(res, 400, "INVALID_INPUT", bad);
  const logData = pickLog(body);

  if (Object.keys(logData).length === 0) {
    return sendError(res, 400, "INVALID_INPUT", "データが空です");
  }

  const { gait, walkCount, walkTimeS, walkDistanceM } = logData;
  if (gait !== undefined && gait !== "run" && gait !== "walk") {
    return sendError(res, 400, "INVALID_INPUT", "gaitは run または walk である必要があります。");
  }

  if (
    (walkCount !== undefined && (typeof walkCount !== 'number' || walkCount < 0)) ||
    (walkTimeS !== undefined && (typeof walkTimeS !== 'number' || walkTimeS < 0)) ||
    (walkDistanceM !== undefined && (typeof walkDistanceM !== 'number' || walkDistanceM < 0))
  ) {
    return sendError(res, 400, "INVALID_INPUT", "早歩き関連の数値は負の値にできません。");
  }

  const newLog = { 
    id: `log_${Date.now()}`,
    時刻: new Date().toISOString(), 
    ...logData 
  };
  
  runLogs.push(newLog);
  if (runLogs.length > 1000) runLogs = runLogs.slice(-1000); // S4: 保存件数の上限

  try {
    fs.writeFileSync(logsFilePath, JSON.stringify(runLogs, null, 2), 'utf-8');
  } catch (error) {
    console.error("ログのファイル保存に失敗しました:", error.message);
  }

  sendOk(res, {
    ステータス: "成功",
    id: newLog.id,
    総ログ数: runLogs.length
  }, 201);
});

// [GET] 走行ログ単件取得
app.get('/api/logs/:id', denyInDemo, (req, res) => {
  const logId = req.params.id;
  const targetLog = runLogs.find(log => log.id === logId);

  if (!targetLog) {
    return sendError(res, 404, "NOT_FOUND", "指定されたログが見つかりません");
  }

  sendOk(res, {
    ステータス: "成功",
    データ: targetLog
  });
});

// [GET] 走行ログ一覧の取得
app.get('/api/logs', denyInDemo, (req, res) => {
  sendOk(res, { ステータス: "成功", データ: runLogs });
});

// ---------------------------------------------------------
// セッション別案内中継データストア (D1 / B1)
// ---------------------------------------------------------
const sessionGuidanceStore = new Map();
// S2: 公開デモでは案内の中継を閉じる（まだどのアプリも使っていない。サーバーレスではセッションの状態がインスタンスごとで、
// 書き込みトークンでも持ち主を保証できないため）
app.all('/api/sessions/:sessionId/guidance', denyInDemo);
// S5: セッションごとの書き込みトークン（最初の PUT で発行。GET では返さない）。{ token, at }
const sessionTokens = new Map();
const MAX_SESSIONS = 1000;
const TOKEN_KEEP_MS = 60 * 60 * 1000;      // 持ち主の記録は1時間残す（すぐ消すと、同じ ID を別人が初回 PUT で取れる）
const GUIDANCE_DEFAULT_MS = 5 * 60 * 1000;  // 期限を省いた案内は5分
const GUIDANCE_MAX_MS = 10 * 60 * 1000;     // 期限は最長10分先まで
// S6: sessionId の形（16〜64文字の英数字・-・_）。推測しにくさは呼ぶ側が crypto.randomUUID() などで作ることが前提
const SESSION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
// S7: 案内の値の範囲（core と同じ mode の一覧。BPM は 60〜220）
const GUIDANCE_GAITS = ['run', 'walk'];
const GUIDANCE_MODES = ['normal', 'adjusting', 'walking', 'stopRecommended', 'waiting', 'finished'];
// 日時は ISO 8601 の形だけ（Date.parse は "1" なども受け付けるため）
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const isIsoDate = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
// 案内に載せる signal は浅いオブジェクトだけ（深いオブジェクトで応答の JSON 化が失敗していた）
// キー名は32文字まで・数は有限（生 JSON の 1e309 を通さない）・文字列は100文字まで
const isShallowSignal = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 20 &&
  Object.entries(v).every(([k, x]) => k.length <= 32 && (x === null || typeof x === 'boolean' ||
    (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.length <= 100)));
// 期限の過ぎた案内と、古い持ち主の記録を消す
function pruneSessions(now) {
  for (const [id, g] of sessionGuidanceStore) if (g.expiresAt && Date.parse(g.expiresAt) < now) sessionGuidanceStore.delete(id);
  for (const [id, t] of sessionTokens) if (now - t.at > TOKEN_KEEP_MS && !sessionGuidanceStore.has(id)) sessionTokens.delete(id);
}
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function validateGuidanceBody(body) {
  const { configVersion, guidanceSeq, createdAt, expiresAt, guidance, signal } = body;
  if (!Number.isSafeInteger(guidanceSeq) || guidanceSeq < 0) return "guidanceSeq は0以上の整数で必須です。";
  if (configVersion !== undefined && (!Number.isSafeInteger(configVersion) || configVersion < 1)) return "configVersion は1以上の整数です。";
  if (createdAt !== undefined && createdAt !== null && !isIsoDate(createdAt)) return "createdAt は日時の文字列です。";
  if (expiresAt !== undefined && expiresAt !== null && !isIsoDate(expiresAt)) return "expiresAt は日時の文字列です。";
  if (guidance !== undefined && (guidance === null || typeof guidance !== 'object' || Array.isArray(guidance))) return "guidance はオブジェクトです。";
  const g = guidance ?? {};
  if (g.targetBpm !== undefined && !(typeof g.targetBpm === 'number' && Number.isFinite(g.targetBpm) && g.targetBpm >= 60 && g.targetBpm <= 220)) return "targetBpm は 60〜220 の数値です。";
  if (g.gait !== undefined && !GUIDANCE_GAITS.includes(g.gait)) return "gait は run または walk です。";
  if (g.mode !== undefined && !GUIDANCE_MODES.includes(g.mode)) return `mode は ${GUIDANCE_MODES.join(' / ')} のどれかです。`;
  if (g.status !== undefined && !(typeof g.status === 'string' && g.status.length <= 32)) return "status は32文字以内の文字列です。";
  if (signal !== undefined && signal !== null && !isShallowSignal(signal)) return "signal は20項目以内の浅いオブジェクト（値は数・100文字以内の文字列・真偽・null）です。";
  if (expiresAt !== undefined && expiresAt !== null) {
    const end = Date.parse(expiresAt), now = Date.now();
    if (end > now + GUIDANCE_MAX_MS) return "expiresAt は10分先までです。";
  }
  return null;
}

// [PUT] セッション案内情報の保存 (Web -> API)
app.put('/api/sessions/:sessionId/guidance', rateLimit(120), (req, res) => {
  const sessionId = req.params.sessionId;
  const body = req.body ?? {};

  if (!SESSION_ID_RE.test(sessionId)) {
    return sendError(res, 400, "INVALID_INPUT", "sessionId は16〜64文字の英数字・-・_ です。");
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return sendError(res, 400, "INVALID_INPUT", "本文はオブジェクトである必要があります。");
  }
  const invalid = validateGuidanceBody(body);
  if (invalid) return sendError(res, 400, "INVALID_INPUT", invalid);

  // S5: 2回目以降の書き込みは、最初に発行したトークン（X-Session-Token ヘッダー）が一致しないと拒否
  const now = Date.now();
  const known = sessionTokens.get(sessionId);
  let issuedToken = null;
  if (known) {
    if (!sameToken(req.get('X-Session-Token'), known.token)) {
      return sendError(res, 403, "FORBIDDEN", "このセッションに書き込む権限がありません（X-Session-Token）。");
    }
    known.at = now;
    // 案内が期限切れで消えても、最後の番号より古い書き込みは受け付けない（巻き戻し防止）
    if (known.lastSeq !== undefined && known.lastSeq >= body.guidanceSeq) {
      return sendError(res, 409, "CONFLICT", `古い更新番号です。(現在: ${known.lastSeq}, 送信: ${body.guidanceSeq})`, "競合");
    }
  } else {
    if (sessionTokens.size >= MAX_SESSIONS) pruneSessions(now);
    if (sessionTokens.size >= MAX_SESSIONS) return sendError(res, 503, "CAPACITY", "セッション数の上限です。");
    issuedToken = crypto.randomBytes(32).toString('base64url');
  }

  const { configVersion, guidanceSeq, createdAt, guidance, signal } = body;
  // S8: 期限はサーバーで決める（省略は5分後、最長10分先）
  const expiresAt = new Date(body.expiresAt == null ? now + GUIDANCE_DEFAULT_MS : Date.parse(body.expiresAt)).toISOString();

  const existing = sessionGuidanceStore.get(sessionId);
  if (existing && existing.guidanceSeq >= guidanceSeq) {
    return sendError(res, 409, "CONFLICT", `古い更新番号です。(現在: ${existing.guidanceSeq}, 送信: ${guidanceSeq})`, "競合");
  }

  const guidanceData = {
    sessionId,
    configVersion: configVersion ?? 1,
    guidanceSeq,
    createdAt: createdAt || new Date().toISOString(),
    expiresAt: expiresAt || null,
    guidance: {
      targetBpm: guidance?.targetBpm !== undefined ? Number(guidance.targetBpm) : 150.0,
      gait: guidance?.gait || "run",
      mode: guidance?.mode || "normal",
      status: guidance?.status || "running"
    },
    signal: signal || null
  };

  sessionGuidanceStore.set(sessionId, guidanceData);
  if (issuedToken) sessionTokens.set(sessionId, { token: issuedToken, at: now, lastSeq: guidanceSeq });
  else sessionTokens.get(sessionId).lastSeq = guidanceSeq;

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  sendOk(res, {
    ステータス: "成功",
    データ: guidanceData,
    // 最初の書き込みのときだけ返す。以後の PUT では X-Session-Token ヘッダーに入れる
    ...(issuedToken ? { writeToken: issuedToken } : {})
  });
});

// [GET] セッション案内情報の取得 (iPhone -> API)
app.get('/api/sessions/:sessionId/guidance', (req, res) => {
  const sessionId = req.params.sessionId;
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (!SESSION_ID_RE.test(sessionId)) {
    return sendError(res, 400, "INVALID_INPUT", "sessionId は16〜64文字の英数字・-・_ です。");
  }
  const guidanceData = sessionGuidanceStore.get(sessionId);

  if (!guidanceData) {
    return sendError(res, 404, "NOT_FOUND", "セッションの案内データが見つかりません。");
  }
  // S8: 期限切れの案内は配らず、消す（持ち主の記録は残す）
  if (guidanceData.expiresAt && Date.parse(guidanceData.expiresAt) < Date.now()) {
    sessionGuidanceStore.delete(sessionId);
    return sendError(res, 410, "EXPIRED", "案内の期限が切れています。");
  }

  sendOk(res, {
    ステータス: "成功",
    データ: guidanceData
  });
});

// ---------------------------------------------------------
// 経路上の信号抽出 (POST /api/signals/along-route)
// ---------------------------------------------------------
function projectPointToSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
  const R = 6371e3;
  const toRad = (deg) => (deg * Math.PI) / 180;

  const latP = toRad(pLat), lonP = toRad(pLon);
  const latA = toRad(aLat), lonA = toRad(aLon);
  const latB = toRad(bLat), lonB = toRad(bLon);

  const x = (lonB - lonA) * Math.cos((latA + latB) / 2);
  const y = (latB - latA);
  const lenSq = x * x + y * y;

  let t = 0;
  if (lenSq > 0) {
    const xp = (lonP - lonA) * Math.cos(latA);
    const yp = (latP - latA);
    t = ((xp * x) + (yp * y)) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }

  const projLat = latA + t * (latB - latA);
  const projLon = lonA + t * (lonB - lonA);

  const dLat = projLat - latP;
  const dLon = (projLon - lonP) * Math.cos((latP + projLat) / 2);
  return { distM: R * Math.sqrt(dLat * dLat + dLon * dLon), t };
}

const alongRouteRateLimits = new Map();

app.post('/api/signals/along-route', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  const ipKey = clientIp(req);
  const now = Date.now();
  let rateRecord = alongRouteRateLimits.get(ipKey);
  if (!rateRecord || now - rateRecord.windowStart > 60000) {
    if (!rateRecord && alongRouteRateLimits.size >= RATE_KEYS_MAX) {
      for (const [k, v] of alongRouteRateLimits) if (now - v.windowStart > 60000) alongRouteRateLimits.delete(k);
      // 消しても満杯なら、新しい IP は記録せずに断る（記録が増え続けない）
      if (alongRouteRateLimits.size >= RATE_KEYS_MAX) {
        return sendError(res, 429, "RATE_LIMITED", "Too many requests. Please try again later.");
      }
    }
    rateRecord = { windowStart: now, count: 0 };
    alongRouteRateLimits.set(ipKey, rateRecord);
  }
  rateRecord.count++;
  if (rateRecord.count > 30) {
    return sendError(res, 429, "RATE_LIMITED", "Too many requests. Please try again later.");
  }

  const body = req.body ?? {};
  const route = body.route;
  // corridorM は省略なら 30m。指定するなら 0 より大きく 100m 以下の数（文字列の "Infinity" で全件が対象になっていた）
  const corridorM = body.corridorM === undefined ? 30 : body.corridorM;
  if (typeof corridorM !== 'number' || !Number.isFinite(corridorM) || corridorM <= 0 || corridorM > 100) {
    return sendError(res, 400, "INVALID_INPUT", "corridorM must be a number in (0, 100].");
  }

  if (!route || route.type !== 'LineString' || !Array.isArray(route.coordinates)) {
    return sendError(res, 400, "INVALID_ROUTE_GEOMETRY", "GeoJSON LineString format is required.");
  }
  if (route.coordinates.length < 2 || route.coordinates.length > 1000) {
    return sendError(res, 400, "INVALID_ROUTE_GEOMETRY", "Coordinate points must be between 2 and 1000.");
  }
  // 各点は [経度, 緯度] の有限の数（null の点で 500 になっていた）
  const validPoint = (p) => Array.isArray(p) && p.length >= 2 &&
    typeof p[0] === 'number' && Number.isFinite(p[0]) && Math.abs(p[0]) <= 180 &&
    typeof p[1] === 'number' && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90;
  if (!route.coordinates.every(validPoint)) {
    return sendError(res, 400, "INVALID_ROUTE_GEOMETRY", "Each coordinate must be [lon, lat] with finite numbers.");
  }

  if (!allSignalsDataF02 || allSignalsDataF02.length === 0) {
    return sendError(res, 503, "INTERNAL_ERROR", "Signal database is not loaded.");
  }

  const matches = [];
  const coords = route.coordinates; // [[lon, lat], ...]

  // 経路始点からの累積距離 (m)
  const cumulativeM = [0];
  for (let i = 1; i < coords.length; i++) {
    cumulativeM.push(cumulativeM[i - 1] + calculateDistanceM(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]));
  }

  for (const signal of allSignalsDataF02) {
    if (typeof signal.lat !== 'number' || typeof signal.lon !== 'number' || Number.isNaN(signal.lat) || Number.isNaN(signal.lon)) {
      continue;
    }

    // 全区間を調べ、最短距離の区間を採用
    let best = null;
    for (let i = 0; i < coords.length - 1; i++) {
      const lonA = coords[i][0], latA = coords[i][1];
      const lonB = coords[i+1][0], latB = coords[i+1][1];

      const { distM, t } = projectPointToSegment(signal.lat, signal.lon, latA, lonA, latB, lonB);
      if (distM <= corridorM && (best === null || distM < best.distM)) {
        best = { distM, alongM: cumulativeM[i] + t * (cumulativeM[i + 1] - cumulativeM[i]) };
      }
    }
    const isWithinCorridor = best !== null;

    if (isWithinCorridor) {
      matches.push({
        physicalSignalId: signal.signalId,
        lat: signal.lat,
        lon: signal.lon,
        alongRouteM: Math.round(best.alongM * 10) / 10,
        offsetM: Math.round(best.distM * 10) / 10,
        timing: {
          cycleS: signal.cycleS,
          greenS: signal.greenS,
          yellowS: signal.yellowS,
          redS: signal.redS,
          phaseS: signal.phaseS
        },
        crossingM: signal.crossingM,
        headingDeg: null,
        approachDirection: null,
        matchQuality: "position-only",
        ...pickQuality(signal),
        isEstimated: signal.isEstimated,
        note: signal.note || "※車両用信号のスプリット由来の推定値です。"
      });
    }
  }

  matches.sort((m1, m2) => m1.alongRouteM - m2.alongRouteM);

  return sendOk(res, {
    schemaVersion: 1,
    dataVersion: "hokkaido-signals-2026-10",
    coverage: { region: "hokkaido", complete: false },
    matches: matches,
    warnings: [
      "車両用信号の推定値です。歩行者信号・進行方向との対応は未確認です。",
      "crossingM は一律仮定値（15m）が含まれています。"
    ]
  });
});

// ---------------------------------------------------------
// 3. エラーハンドリング (必ずルート定義の最後に配置)
// ---------------------------------------------------------

// 404 エラーハンドリング
app.use((req, res, next) => {
  sendError(res, 404, "NOT_FOUND", "指定されたエンドポイントは見つかりません");
});

// グローバルエラーハンドリング
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return sendError(res, 400, "INVALID_INPUT", "無効なJSONフォーマットです");
  }
  if (err.type === 'entity.too.large') return sendError(res, 413, "PAYLOAD_TOO_LARGE", "本文が大きすぎます（100KB まで）");
  if (err.status === 415) return sendError(res, 415, "UNSUPPORTED_MEDIA_TYPE", "本文の形式が未対応です");
  sendError(res, err.status || 500, "INTERNAL_ERROR", "サーバーエラーが発生しました");
});

// ---------------------------------------------------------
// 4. サーバー起動
// ---------------------------------------------------------
const PORT = process.env.PORT || 3001; 
// テストから require されたときは listen しない（Vercel は module.exports の app を使う）
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 RUNWAVE Backend サーバー起動完了 (ポート: ${PORT})`);
  });
}
module.exports = app;