# RUNWAVE iPhone UI 実装 引き継ぎ書

## 1. 依頼内容

RUNWAVEの**iPhone側UI**をSwiftUIで実装してください。

作業環境はWindowsです。XcodeやiOSシミュレーターは使えないため、**ソースコードの作成のみ**をお願いします。ビルド・実行・実機確認はMac側で行います。

- 使用モデル：Claude Opus 5.5（High）
- 対象リポジトリ：JPHACKS `sp_2601`
- 作業場所：`frontend/watch-app/`
- 現在のXcodeプロジェクト：`frontend/watch-app/Runwave.xcodeproj`

iOS向けアプリはAppleのXcodeとiOS SDKでビルド・実行します。WindowsではSwiftのソース編集はできますが、このプロジェクトのビルドやiOSシミュレーターでの確認はできません。[AppleのXcodeシステム要件](https://developer.apple.com/xcode/system-requirements)

## 2. プロダクト概要

RUNWAVEは、ランナーが目標ケイデンス（歩/分）を受け取り、走行中に目標テンポと運動状態を確認できる仕組みです。

- MacのWebシミュレーター：仮想信号・距離・到着予測・目標ケイデンスを計算する
- iPhoneアプリ：目標値などの設定と、将来のWatchへの中継を担う
- Apple Watchアプリ：ワークアウト、センサー取得、目標テンポの提示を担う

**信号の計算ロジックをiPhoneアプリに重複実装しないでください。** 実際の信号機・JARTIC・GPSにも接続しません。

## 3. 既存プロジェクトと編集範囲

XcodeプロジェクトにはiPhoneアプリの`Runwave`ターゲットと、Watchアプリの`Runwave watch Watch App`ターゲットがあります。

iPhone側の既存ソース：

- `frontend/watch-app/Runwave/ContentView.swift`
- `frontend/watch-app/Runwave/RunwaveApp.swift`

Watch側のソース：

- `frontend/watch-app/Runwave watch Watch App/`

iPhone UIの作業では、基本的にiPhone側の`Runwave`ターゲットだけを編集してください。**Watch側のソースや署名設定を変更しないでください。**

まずは既存のiPhone側`ContentView.swift`で画面を作る方針にしてください。新しいSwiftファイルを追加する場合は、Xcodeプロジェクトへの登録やターゲット所属の確認がMac側で必要になるため、変更したファイルと登録手順を明記してください。

## 4. iPhone UIのMVP案

### 設定・ホーム画面

- アプリ名：RUNWAVE
- 目標ケイデンス：初期値160歩/分
- 設定範囲：120〜190歩/分
- 「Watch接続状態」を表示する
- セッション開始ボタン
- 接続できていない場合も、手動設定した目標値を扱える設計にする

### セッション画面

- 目標ケイデンス：歩/分またはSPMで表示
- Watchから受け取った現在ケイデンス
- ワークアウト状態（待機・実行中・一時停止）
- 一時停止・再開・終了操作
- Watch未接続、値未受信の場合は「未接続」「未計測」と表示する

### 結果画面

- 運動時間
- Watchから取得できた距離・平均ケイデンス
- 取得できなかった値は表示しないか、「未取得」と表示する

画面に表示する仮の値を実測値のように見せないでください。モック表示が必要な場合は「デモ値」と明記してください。

## 5. データ・用語のルール

- `targetCadence`：目標歩数。単位は歩/分
- `currentCadence`：現在ケイデンス。未取得の場合はnil相当として扱う
- `heartRate`：心拍数。ケイデンスとは別の値
- `distance`：距離。単位はm
- 心拍数を走行テンポとして扱わない
- ケイデンスが未取得のときに0歩/分と表示しない

既存のJavaScriptコア契約は`core/CONTRACT.md`を確認してください。シミュレーターの状態値には`bpm`や`targetBpm`という名前もありますが、これは**歩/分**を指します。心拍数と混同しないでください。

## 6. Watchとの連携方針

WatchConnectivityをこの作業で実装する必要はありません。画面と状態管理を先に作り、将来接続できる構成にしてください。

後続の連携で想定している送信項目：

- `targetCadence`
- `mode`
- `issuedAt`
- `sessionID`

Watchが未接続でも設定画面や画面遷移が成立するようにしてください。Watchがワークアウト・センサーを担当する前提を保ってください。

## 7. Windows側での作業ルール

- SwiftUIのソースコードのみを変更する
- ビルド・実行・テストは行わない
- 未実行のコードを「動作確認済み」と表現しない
- 新しい外部ライブラリや依存関係を追加しない
- `.pbxproj`、署名、Bundle ID、Capabilitiesなどの設定を変更しない
- WatchターゲットやJavaScriptの`core/`・`backend/`を変更しない

## 8. Mac側に渡すもの

作業完了時に、次をまとめてください。

1. 変更したファイル一覧
2. 画面・操作の概要
3. 外部連携が未実装の箇所
4. Mac側で確認が必要な点
5. 変更内容を適用する差分、またはリポジトリ内のブランチ

**ビルドできるか・シミュレーターでどう表示されるかは、Mac側で確認します。**