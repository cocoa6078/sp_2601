# API が届いたときの確認手順

**10/17 ガイド受領**（バックエンド・API連携ガイド）：ベースURL は `http://localhost:3001`。バックエンドのコード（backend フォルダ）を起動してから確認する。
```
npm run api-check -- http://localhost:3001
```

## 1. まず読み取りだけ（データは書き込まない）
```
npm run api-check -- https://＜共有されたURL＞
```
- URL は `https://xxx.vercel.app` のように**ドメインまで**を渡す（`/api` は付けない）
- 確認する内容: GET /api/signals・/api/calibration・/api/logs、存在しないパスが 4xx になるか、すべて JSON で返るか
- 取得した信号と歩幅・BPM を core に通して、シミュレーションが最後まで走るかも確認する
- 結果は画面に表示し、`work/api-check/<時刻>.json` に保存される

## 2. 書き込みの確認（バックエンド担当に確認してから）
```
npm run api-check -- https://＜URL＞ --write
```
- POST /api/calibration と POST /api/logs の正常系・異常系（ボディ無し・空・負の値・文字列・壊れた JSON）を送る
- **注意**:
  - calibration の正常系は、サーバーの歩幅・BPM を 0.8m / 150BPM に上書きする
  - logs に1件書き込まれる。`test: true`・`source: "runwave-api-check"` を付けているが、サーバーがそれを保存・区別できるかは未確認
  - 本番しかない場合は、バックエンド担当に一言伝えてから実行する
  - 失敗しても自動で再送はしない（重複を防ぐため）

## 3. API の形が想定と違ったら
- パス・送る中身: `tools/api-check.config.json` を直す
- 応答の読み方: `core/api-adapter.js`（信号は F-02 の6項目 `cycleS, greenS, yellowS, redS, phaseS, crossingM`、歩幅は `strideM, baseBpm` を期待）
- 名前が違う場合（例: `cycle` と `cycleS`）は、推測で吸収せずバックエンド担当と名前を合わせる

## 4. このスクリプトでは確認できないこと
- **ブラウザからの CORS**: Node から呼ぶとブラウザの制限がかからない。CORS ヘッダーが無ければ ⚠ を出すが、最終確認はシミュレーターの画面から行う
- ログが再起動後も残るか（計画では「任意」）
- 認証がある場合の確認

## 練習（本物の API が無くても試せる）
```
npm run mock-api          # 別のターミナルで偽サーバーを起動（http://localhost:8787）
npm run api-check -- http://localhost:8787 --write
```
