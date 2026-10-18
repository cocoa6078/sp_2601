# RUNWAVE Web シミュレーター（Leaflet）

地図に開始・終了・経由点を置いて折れ線の模擬経路を作り、経路上の模擬信号の青タイミングで「通常走行」と「RUNWAVE」を並べて比較する Web アプリ。
素の JavaScript + Vite + Leaflet。設計は `RUNWAVE_WEB_DESIGN_Leaflet_v1.md`（§9 T1〜T7）。

常時表示: **模擬経路・模擬信号によるシミュレーション／モデル上の推定値**。地図上の現在位置は GPS ではなく、API 由来の信号でも実際の点灯状況とは同期しない。

## 起動（Windows / Mac 共通）

```
cd frontend/web-simulator
npm.cmd install      # Mac は npm install
npm.cmd run dev      # http://127.0.0.1:5174/  （Mac は npm run dev）
```

- 本番ビルド: `npm.cmd run build`（出力 `dist/`）→ `npm.cmd run preview`（http://127.0.0.1:4174/）
- テスト: `npm.cmd test`（`test/*.test.js`。Node 標準のテストランナー）
- ルートの `package.json` は変更していない。独立して起動する。dev-dashboard（5173）とは別ポート
- Vite が読めるのは このアプリ・`core/`・`frontend/dev-dashboard/src`（api-client の再利用）だけ

## 使い方

1. 起動直後は **固定デモ B（模式コース）** がすぐ再生できる（API 取得は起動条件ではない）。「再生」を押す。
2. 画面は「地図設定」「比較再生」の 2 状態。右上「収録モード」で設定・診断を隠して 1920x1080 の収録向け表示にする。
3. **任意コース**: 地図設定 → 「地図でコース作成」→ 開始地点 → 終了地点 → 経由点（ドラッグで修正、順序入れ替え・削除可）→「経路確定」。
   「経路確定」を押した 1 回だけ、OSRM（foot）で道沿いの歩行経路を取得して置き換える（取得中は「経路を取得中…」）。取得に失敗した・経路条件に合わない場合は、置いた点を直線で結ぶ従来の折れ線に戻し、理由を画面に出す。編集中のプレビューは常に直線で、点を動かすたびの通信はしない。
   近くの信号（許容距離 30 m・設定可）を経路へ投影して候補にする。チェックで採用/除外を切り替え、「設定を適用して開始」。
4. 再生中は条件編集が無効。一時停止中でも条件を変えると両走行をリセットする。倍率 1/2/4/5 倍（倍率・フレーム刻みが違っても、同じ模擬時刻の位置・時刻・信号位相は同じ。計算は 0.1 秒刻みの tick 数だけで決まる）。タブが隠れると自動で一時停止（復帰時は手動で再開）。
5. 「結果 JSON を保存」で、条件・経路・信号の採用/除外・core のバージョンと SHA・結果・到達イベントを保存（ローカル保存のみ。`POST /api/logs` は使わない）。

### 固定デモと任意コースの違い
- 固定デモ A/B/W は `core/scenarios.js` の定義（400 m 地点の信号・ゴール 600 m）。**模式コース**であり、実地図から測った距離ではない。
- 任意コースの経路は 2 種類。**道沿い**（`route.source = "osrm-foot"`、`src/walk-routing.js`）と、取得失敗時などの**直線**（`manual-polyline`）。画面に「道沿い（OSRM / OpenStreetMap）」または「直線（取得失敗: 理由）」と表示し、結果 JSON の `route.source` に残す。道沿い経路は 2 m 未満の連続点を間引いてから検証する。経由点が経路の交差・往復を生むと検証で拒否され、直線に戻る（仕様）。
- 任意コースは、経路の累積距離 s を信号位置 `crossingX`、経路長を `goalX` にして core の 1 交差点モデルへ渡す。任意経路で固定デモと同じ結果になる保証はない。
- 早歩きは両方とも `control.walk.enabled = true` を明示して渡す。`endMarginS` はシナリオ側の明示値（5 秒）を保持し、core 既定の 8 秒で上書きしない。

## API（任意）

地図設定の「3. API」。既定 URL は `http://localhost:3001`（編集可・5 秒でタイムアウト・自動リトライなし）。

- 「参考信号を取得」: `GET /api/signals`。形式検証は `core/api-adapter.js` の `extractSignals`。座標（lat/lon）は adapter の値を使う。0 件・不正 JSON・HTTP エラー・接続失敗は理由と時刻を表示し、既存の条件は変更しない。
- 「校正値を取得」→「校正値を適用」: `GET /api/calibration`（`extractRunner`）。
- API 信号は「車両用データ由来・位相は仮の参考信号」。座標が実際の横断歩道位置かは未確認（実測と断定しない）。
- API なしでも使える **模擬信号 fixture**（`src/fixtures.js`、札幌付近の 5 件）を同梱。実 API の成功応答ではない。由来は fixture 内コメントと結果 JSON に残る。
- バックエンドは別途起動する（例: `cd backend && npm start`）。ブラウザでは CORS 拒否とサーバー停止を区別できないため、失敗メッセージにその旨を書く。

## 変更点（倍率・CSV・出所表示）

- **倍率**: 1 / 2 / 4 / 5 倍。`test/speed.test.js` が x1/x2/x4 と壁時計の刻み違いで同時刻の状態が一致することを確認する。
- **時系列 CSV**: 比較再生の「時系列 CSV を保存」。列は `lane, time_s, position_m, signal_color, target_bpm, bpm, speed_mps, state, data_source, is_estimated`（0.1 秒ごと・通常/RUNWAVE の 2 走行。`state` は approach / stopped / crossing / passed / finished。UTF-8 BOM つき）。
- **データの出所表示**: 画面上部に、推定信号のとき「【シミュレーション（推定信号）】」を出す。信号詳細に「データ区分」と、API が返した `signalType` / `phaseBasis` / `positionAccuracyM` / `fetchedAt` / `crossingDirection`（無ければ非表示）を出す。結果 JSON は `api`（`source`: api / fixture / none、`url`、取得日時 `at`、直近の API 取得結果 `lastApiAttempt`）、`signals.adopted[].provenance`（`isEstimated` と上記項目。API が返さなければ null）、`simulationLabel` を含む。固定デモと fixture は `source: "fixture"`。`isEstimated` は API が false と明示した信号だけ false、それ以外は推定。
- **API 失敗**: 信号の取得に失敗すると fixture に戻し「取得失敗・fixture（推定データ）を使用」と理由を表示する。校正値が欠損・0 以下・数値でないときは適用せずエラー理由を表示（既定値で黙って埋めない）。
- **極端な条件**: 低速・横断長 0・青より長い横断時間でも落ちず、時間切れや理由つきエラーとして表示する（`test/robust.test.js`）。計算中に例外が出た場合は一時停止して理由を表示する。

## 道沿い経路（OSRM）
「経路確定」のときだけ `https://routing.openstreetmap.de/routed-foot/route/v1/foot/{lng,lat;...}?overview=full&geometries=geojson` を 1 回 GET する（タイムアウト 5 秒・リトライなし・start→via→end の順）。FOSSGIS が運営する公開サーバーで、利用条件は次のとおり。
- **最大 1 リクエスト/秒、大量利用禁止**（1 回の確定で 1 リクエスト。編集のたび・render のたびには通信しない）
- **帰属表示**: OSRM 経路のとき地図の帰属に「経路: OSRM（FOSSGIS） © OpenStreetMap contributors」と OSM の修正リンクを出す
- 出典: https://routing.openstreetmap.de/about.html ／ https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server
- 大量・商用の利用や安定運用が必要になったら、自前の OSRM サーバーに切り替える（`WALK_ROUTING_BASE` を差し替え）。

## 地図タイル
OpenStreetMap の標準タイルを通常のズーム・パンの範囲だけ読む（一括取得なし）。取得に失敗すると「背景地図を取得できません」を出し、経路・信号・ランナーは座標平面で表示し計算は続く。帰属表示は常に出す。

## 未接続・未実装
- 複数信号（2〜5 件）は `core/route-core.js`（routeVersion は画面と JSON に表示）で連続走行する。1 件のときは従来の単信号 core。`atM` は経路の開始点から測り直した s、`goalM` は経路長（API の `distanceFromStartM` は使わない）。通過・待機・横断の表示と信号ごとの結果は `state.events` / `summarizeRoute().signals[]` が正。
- BPM グラフ（T10）、時間位置の選択、全件/地域別 API（`/api/signals/all`）、単独 ON/OFF 表示、10 倍速（T11）は未実装。
- 自己交差・往復・同一信号の再通過を含む経路は拒否（初版は単純な片道経路のみ）。直線の折れ線は仮想経路で、歩道通行可能性や道路距離は保証しない。道沿い経路も OSRM の推定で、実際の歩道・横断歩道の通行可否や信号待ち時間は保証しない（OSM の地図データの誤りは https://www.openstreetmap.org/fixthemap から修正できる）。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `src/walk-routing.js` | OSRM foot から道沿い経路を 1 回取得（`fetchWalkRoute`・2 m 未満の点の間引き・帰属文言） |
| `src/route-geometry.js` | 地理距離・投影・累積距離・`pointAtDistance`・経路検証（距離計算はここだけ） |
| `src/route-builder.js` | 経由点の編集、経路上の信号の採用・検証 |
| `src/fixtures.js` / `src/scenarios.js` | 模擬信号 fixture・デモ経路 / 既存 A/B/W の import と walk 正規化 |
| `src/engine-adapter.js` | core 呼び出しの隠蔽（単信号は core、2 件以上は route-core） |
| `src/playback.js` | 固定 0.1 秒刻みの共通時計 |
| `src/map-view.js` | Leaflet のレイヤー・マーカー更新 |
| `src/signal-view.js` `metrics-view.js` `comparison-view.js` | 表示部品（HTML 文字列） |
| `src/api.js` `report.js` `store.js` `main.js` | API / 結果 JSON / 状態 / 接続 |
| `test/` | DOM 非依存の契約テスト |

## 確認したこと・していないこと
- `npm.cmd test` と `npm.cmd run build` は通る。ブラウザ（1920x1080 エミュレーション）で、固定デモ B/W の描画・早歩き表示・任意コース作成と信号の採用/除外・3 信号の任意コースの最後までの再生（赤待ち・早歩き・信号ごとの結果・一括計算との一致）・収録モードの切替を確認した。
- 未確認: 実 API（localhost:3001）との接続、タイル取得失敗時のバナー表示の実機確認、実際のブラウザウィンドウでの 60fps 描画・5 倍速の実測、Mac での起動。
