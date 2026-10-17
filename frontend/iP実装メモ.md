# RUNWAVE iPhone UI（Mac 側への受け渡し）

Windows で書いた SwiftUI のソースです。**ビルド・シミュレーター・実機での確認はしていません**（Windows には Xcode / swiftc がないため）。

## 1. 変更したファイル

| ファイル | 内容 |
|---|---|
| `frontend/watch-app/Runwave/ContentView.swift` | iPhone UI 一式（型・状態管理・3画面）。2026-10-17 午後に終了地点カードと信号カードを追加 |
| `frontend/watch-app/Runwave/GoalMapView.swift` | 新規。終了地点を Apple Maps で選ぶ sheet と、ホームに出す小さな地図 |
| `frontend/watch-app/Runwave/SignalLightView.swift` | 新規。歩行者用信号（赤・青）のイラスト |
| `frontend/iP実装メモ.md` | このメモ（`iP仕様書.md` への回答） |

`WatchConnectivityLink.swift`（蝦名さん作）・`RunwaveApp.swift`・`.pbxproj`・署名・Bundle ID・Capabilities・Info.plist の設定、Watch ターゲット、`core/`・`backend/` は変更していません。

### 適用手順（Mac）

1. `git pull` する
2. `Runwave` フォルダは Xcode の「フォルダ同期」（file system synchronized group）なので、新しい 2 ファイルは自動で `Runwave` ターゲットに入る。Xcode の File Inspector で Target Membership が `Runwave` だけになっているか確認する（Watch 側に入っていないこと）

## 2. 画面と操作の概要

画面は `SessionStore.screen` で切り替えます（NavigationStack を使わないので、スワイプで戻ってもセッションが壊れません）。

- **ホーム**: RUNWAVE / Watch 接続状態 / 目標ケイデンス（初期値 160 歩/分、Stepper 1 刻み、120〜190 の範囲に収める）/ **終了地点（任意）** / セッション開始。Watch 未接続でも、終了地点が未設定でも開始できる
  - 終了地点: 未設定なら「未設定」、設定済みなら小さな地図（操作不可）と緯度経度（小数 5 桁）。「地図で設定」で sheet が開く
  - sheet: 地図をタップした位置にピンを置く。「クリア」でピンを外し、「決定」で確定（ピンなしで決定すると未設定に戻る）、「キャンセル」で何も変えない。初期表示は設定済みの地点、なければ札幌駅付近
  - 現在地は使わない（位置情報の権限なし）
- **セッション**: 目標ケイデンス（変更可）/ **信号のイラスト** / 終了地点：設定済み・未設定 / 現在ケイデンス / 心拍数（拍/分、ケイデンスとは別のカード）/ ワークアウト状態（待機・実行中・一時停止）/ 経過時間 / 一時停止・再開・終了（終了は確認ダイアログ）
  - 信号: 縦長の筐体に、上が赤（立っている人）、下が青（歩いている人）。点いている方が明るく、青点滅は約 0.5 秒周期で点滅。下に「赤（止まれ）」「青（進め）」「青点滅」と残り秒数。色が分かりにくい人でも、形とテキストで判別できる
  - 信号の値が届いていないときは、両方を暗くして「信号情報なし（未受信）」と出す。iPhone では信号の色を計算しない
  - 未接続なら「未接続」、接続中で値がない（nil）なら「未計測」。ケイデンスを 0 歩/分とは表示しない
- **結果**: 運動時間（iPhone の時計で測り、一時停止中は数えない）/ 距離（m、1000 m 以上は km も併記）/ 平均ケイデンス。取得できなかった値は「未取得」
- **デモ値（DEBUG ビルドのみ）**: ホームのトグルで固定のデモ値を表示する。表示中は値の横と画面上部に「デモ値」バッジが付く。信号カードには「赤 / 青 / 青点滅」の切り替えが出る（イラストの見た目の確認用）。Release ビルドでは使えない

## 3. 外部連携で未実装の箇所

- **WatchConnectivity**: `WatchConnectivityLink.swift`（蝦名さん）で、目標値・ワークアウト操作の送信と `type: "metrics"` の受信を実装済み。プレビューは `NoWatchLink`
- **送る項目**: `TargetCommand { targetCadence, mode, issuedAt, sessionID }`。送るタイミングは開始時・セッション中に目標を変えたとき・セッション中に再接続したとき。ホームで目標を変えただけでは送らない（sessionID は開始時に決まるため）
- **受け取る項目**: `WatchMetrics { currentCadence, heartRate, distance(m), averageCadence, receivedAt }`。どれも Optional
- **信号の受信経路は未実装**: `SessionStore.receiveSignal(_ info: SignalInfo?)` が受け口。`SignalInfo { color: green|flashing|red, remainingS }` は core の `state.signal` の `color`・`remainingS` に合わせてある。【要確認】シミュレーター → iPhone（または Watch 経由）でどう届けるか。たとえば `WatchConnectivityLink.receive` に `type: "signal"` を足して `receiveSignal` を呼ぶ形
- **終了地点は iPhone の中だけで保持**: Watch やシミュレーターには送っていない。【要確認】送るか、送るならどの形式か（緯度経度 → core の `route.goalX`（m）への変換はどこでするか）
- **`TargetMode`** は今のところ `manual` だけ。【要確認】Watch 側と rawValue を決める
- 信号・到着予測・目標ケイデンスの計算は iPhone には入れていない（Web シミュレーターと core の担当）

## 4. Mac 側で確認してほしいこと

- [ ] ビルドが通るか。ContentView は iOS 16 の API、地図は iOS 17 以降の MapKit（`Map(position:)`・`MapReader`・`Marker`・`onTapGesture` の座標付き版）を使用。Deployment Target 26.2 なので範囲内
- [ ] 地図まわりのコンパイルで不安な点: `Map { if let p = pending { Marker(...) } }` の書き方と、`Map` に付けた `.onTapGesture { point in ... }`。通らなければ Marker を `ForEach` で書き直す
- [ ] プロジェクトは `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`・Approachable Concurrency・Swift 5 モード。並行処理の警告が出ないか
- [ ] `.foregroundColor` は iOS 17 以降では非推奨。警告が出るだけで動作には影響しない見込み
- [ ] 地図のタップでピンが思った位置に立つか（地図のドラッグ・ズームとタップがぶつからないか）
- [ ] 青点滅の点滅が目に痛くないか、残り秒数が切り上げで表示されるか
- [ ] 小さい画面（iPhone SE）とダークモードで文字が切れないか（信号の筐体は濃い灰色の固定色）
- [ ] 一時停止中に経過時間が止まり、再開すると続きから進むか
- [ ] Debug でデモ値を ON にしたとき、すべての値に「デモ値」と分かる表示が付いているか
- [ ] 結果画面の「デモ値」バッジは画面上部にだけ付く。運動時間はデモ中でも実際に測った時間なので、カードごとの表示に分けるか検討する

## 5. 差分の受け取り方

`main` に commit 済み（最初の UI は d8046f8、終了地点と信号のイラストはその後の commit）。`git log -- frontend/watch-app/Runwave/` で確認できます。
