# RUNWAVE iPhone UI（Mac 側への受け渡し）

Windows で書いた SwiftUI のソースです。**ビルド・シミュレーター・実機での確認はしていません**（Windows には Xcode / swiftc がないため）。

## 1. 変更したファイル

| ファイル | 内容 |
|---|---|
| `frontend/watch-app/Runwave/ContentView.swift` | テンプレートを置き換え。iPhone UI 一式（型・状態管理・3画面）を 1 ファイルにまとめたもの |
| `frontend/iP実装メモ.md` | このメモ（`iP仕様書.md` への回答） |

`RunwaveApp.swift`・`.pbxproj`・署名・Bundle ID・Capabilities、Watch ターゲット、`core/`・`backend/` は変更していません。

### 適用手順（Mac）

1. `git pull` するだけ。新しい Swift ファイルは足していないので、ターゲットへの登録はいらない（`ContentView.swift` は `Runwave` ターゲットのまま）
2. `RunwaveApp.swift` は `WindowGroup { ContentView() }` のままで動く作り

## 2. 画面と操作の概要

画面は `SessionStore.screen` で切り替えます（NavigationStack を使わないので、スワイプで戻ってもセッションが壊れません）。

- **ホーム**: RUNWAVE / Watch 接続状態 / 目標ケイデンス（初期値 160 歩/分、Stepper 1 刻み、120〜190 の範囲に収める）/ セッション開始。Watch 未接続でも開始できる
- **セッション**: 目標ケイデンス（変更可）/ 現在ケイデンス / 心拍数（拍/分、ケイデンスとは別のカード）/ ワークアウト状態（待機・実行中・一時停止）/ 経過時間 / 一時停止・再開・終了（終了は確認ダイアログ）
  - 未接続なら「未接続」、接続中で値がない（nil）なら「未計測」。ケイデンスを 0 歩/分とは表示しない
- **結果**: 運動時間（iPhone の時計で測り、一時停止中は数えない）/ 距離（m、1000 m 以上は km も併記）/ 平均ケイデンス。取得できなかった値は「未取得」
- **デモ値（DEBUG ビルドのみ）**: ホームのトグルで固定のデモ値を表示する。表示中は値の横と画面上部に「デモ値」バッジが付く。Release ビルドでは使えない

## 3. 外部連携で未実装の箇所

- **WatchConnectivity**: `NoWatchLink`（常に未接続・何もしない代わりのクラス）が入っている。`WatchLink` プロトコルに準拠した WCSession 版を作り、`ContentView` の `SessionStore()` を `SessionStore(link: 実装)` に差し替える（`TODO(WatchConnectivity)` を参照）
- **送る項目**: `TargetCommand { targetCadence, mode, issuedAt, sessionID }`。送るタイミングは開始時・セッション中に目標を変えたとき・セッション中に再接続したとき。ホームで目標を変えただけでは送らない（sessionID は開始時に決まるため）
- **受け取る項目**: `WatchMetrics { currentCadence, heartRate, distance(m), averageCadence, receivedAt }`。どれも Optional
- **`TargetMode`** は今のところ `manual` だけ。【要確認】Watch 側と rawValue を決める
- 信号・到着予測・目標ケイデンスの計算は iPhone には入れていない（Web シミュレーターと core の担当）

## 4. Mac 側で確認してほしいこと

- [ ] ビルドが通るか（コードは iOS 16 以降の API だけで書いた。プロジェクトの Deployment Target は 26.2 なので範囲内）
- [ ] プロジェクトは `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`・Approachable Concurrency・Swift 5 モード。全部の型が MainActor 扱いになる前提で、並行処理の警告が出ないか（Watch からのコールバックは `DispatchQueue.main.async` でメインスレッドに渡している。`WatchMetrics` などの `Codable` 準拠は今は使っていない）
- [ ] `.foregroundColor` は iOS 17 以降では非推奨。警告が出るだけで動作には影響しない見込み
- [ ] 小さい画面（iPhone SE）とダークモードで文字が切れないか
- [ ] 一時停止中に経過時間が止まり、再開すると続きから進むか
- [ ] Debug でデモ値を ON にしたとき、すべての値に「デモ値」と分かる表示が付いているか
- [ ] 結果画面の「デモ値」バッジは画面上部にだけ付く。運動時間はデモ中でも実際に測った時間なので、カードごとの表示に分けるか検討する

## 5. 差分の受け取り方

`main` に commit 済み（2026-10-17）。`git log -- frontend/watch-app/Runwave/ContentView.swift` で差分を確認できます。
