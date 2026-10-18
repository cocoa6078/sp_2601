## バックエンド (Backend API)

### 🚀 起動方法 (How to Run)
```bash
cd backend
npm install
npm start


## 追記: 運用上の注意と新しい項目（DATA-02 / DATA-04）

### 運用上の注意
- **Vercel ではログが永続しない**: ログは /tmp/logs.json に書かれ、インスタンスが入れ替わると消える。保存先として当てにしない。
- **公開 API への POST はデモ中に行わない**: POST /api/calibration と POST /api/logs は全員共通の値（キャリブレーション値・ログ）を上書き/追記する。

### 信号の品質項目
対象: /api/signals・/api/signals/all・/api/signals/region/:region・POST /api/signals/along-route の各信号。既存キー（isEstimated・note・phaseS など）はそのまま、次を追加。

| キー | 値 | 意味 |
|---|---|---|
| signalType | "vehicle" | 車両用信号（歩行者用ではない） |
| phaseBasis | "estimated" | 位相は仮値 |
| phaseBasisNote | 文字列 | 仮値の説明（デモ5件は15秒ずらし、全件データは phaseS=0 固定） |
| positionAccuracyM | null | 位置精度は不明 |
| fetchedAt | null | 元データの取得日時が不明 |
| crossingDirection | null | 横断方向は未確認 |

### レスポンス形式（英語キーを追加）
日本語キー（ステータス/メッセージ/データ）は既存クライアント互換のため残す。
- 成功: status: "ok" を追加
- エラー: status: "error" と error: { code, message } を追加
  - code 例: INVALID_INPUT(400)・NOT_FOUND(404)・CONFLICT(409)・INTERNAL_ERROR(500)
  - along-route は従来どおり INVALID_ROUTE_GEOMETRY・RATE_LIMITED・SIGNAL_DATA_UNAVAILABLE（retryable 付き）

### テスト
cd backend && npm test（node:test。app を空きポートで listen して検証。index.js は直接実行時のみ listen する）

### POST /api/signals/along-route 応答例
経路（GeoJSON LineString、2〜1000点）の corridorM（既定30m）以内の信号を、経路始点からの距離順で返す。
- alongRouteM: 経路始点から、信号を経路へ射影した点までの経路上距離(m、小数1桁)。複数区間に近い場合は最短距離の区間を採用
- offsetM: 信号から経路までの最短距離(m、小数1桁)
- generatedAt: 応答生成時刻(ISO 8601)

~~~json
{
  "status": "ok",
  "generatedAt": "2026-10-18T01:53:01.600Z",
  "schemaVersion": 1,
  "dataVersion": "hokkaido-signals-2026-10",
  "coverage": { "region": "hokkaido", "complete": false },
  "matches": [
    {
      "physicalSignalId": "hokkaido_札幌方面_3",
      "lat": 43.06677002,
      "lon": 141.35050919,
      "alongRouteM": 0,
      "offsetM": 0,
      "timing": { "cycleS": 110, "greenS": 31, "yellowS": 5, "redS": 74, "phaseS": 0 },
      "crossingM": 15,
      "headingDeg": null,
      "approachDirection": null,
      "matchQuality": "position-only",
      "quality": "estimated",
      "source": "JARTIC-derived signal split; coordinates from source/scrape",
      "signalType": "vehicle",
      "phaseBasis": "estimated",
      "phaseBasisNote": "位相は仮値（phaseS=0 固定）。実測ではありません。",
      "positionAccuracyM": null,
      "fetchedAt": null,
      "crossingDirection": null,
      "isEstimated": true,
      "note": "※JARTICビッグデータ抽出分（実測・スクレイピング座標適用）"
    }
  ],
  "warnings": [
    "車両用信号の推定値です。歩行者信号・進行方向との対応は未確認です。",
    "crossingM は一律仮定値（15m）が含まれています。"
  ]
}
~~~
