# 受け入れ証跡の置き場所

要件 v2（`20261018_RUNWAVE_完成要件_v2.md`）§4 の証跡のうち、Web シミュレーターで取るものをここに置く。
置き場所は**合意済み: リポジトリ直下 `docs/acceptance/YYYYMMDD/`**（要件 §4-11 の【仮】`work/acceptance/` から変更）。Web シミュレーター分の証跡もここに置く。

## 決まり

- フォルダは日付ごと `YYYYMMDD/`（取得日・ローカル日付）。同じ日に取り直すときは上書きせず、古いものを `_v1` などに改名してから実行する
- 置くもの: **結果（JSON・CSV）・ログ（テスト出力のテキスト）・録画へのリンク（`recording-links.md`）**
- 重い録画（動画）は git に入れない。共有ドライブに置き、`recording-links.md` に「項目・URL・撮影日・撮影者・対象 SHA」を書く【共有ドライブの場所は要確認】
- 各証跡には git SHA・`coreVersion`・実行日時を必ず残す（自動出力のものは JSON に入っている）
- 模擬経路・模擬信号によるシミュレーションの結果であり、実環境・実信号の性能実証ではない（§4-9）。証跡にこの注記を付ける

## 自動で作る証跡

| コマンド（`frontend/web-simulator` で実行・出力はリポジトリ直下 `docs/acceptance/`） | 出力 |
|---|---|
| `npm run acceptance` | `YYYYMMDD/web-speed-consistency.json`（デモ B/W を x1/x2/x4 で走らせ、同時刻の位置・時刻・信号位相・BPM の一致、git SHA、`coreVersion`、実行日時） |
| `npm test` | 標準出力を `YYYYMMDD/web-test.log` に保存（共通ケース `test/core-cases.test.js` を含む） |

## 要件 §4 の項目と証跡ファイル名

Web で取るのは 1・6・9・10・11 と、8 の一部。それ以外は iPhone / Watch 側の証跡（この表では参照だけ）。

| §4 | 内容 | 証跡ファイル（`YYYYMMDD/` 以下） | 状態 |
|---|---|---|---|
| 1 | ブランチ・SHA・差分・`coreVersion` | `web-speed-consistency.json` の `git` / `coreVersion`、`web-test.log` 冒頭に `git rev-parse HEAD` | 一部取得（JSON は 20261018 分あり。差分記録は【未】） |
| 2 | iPhone 17 シミュレーターで走行完了 | （iPhone 側の証跡） | 対象外 |
| 3 | 赤で進入しない（複数シナリオ＋時系列ログ） | （iPhone 実動作の証跡。Web の参考: 結果画面の時系列 CSV `web-timeseries-<デモ>.csv`） | 【未】 |
| 4 | 無理な加速を提案せず不確実性を表示 | （iPhone 実動作の証跡） | 対象外 |
| 5 | 目標ケイデンス ±20 以内・下限・飛び | （iPhone 実動作の証跡） | 対象外 |
| 6 | x1/x2/x4 で位置・時間・信号位相が整合 | `web-speed-consistency.json`（Web）、`recording-x1-x2-x4.md`（録画リンク・iPhone 実動作と Web の対応） | Web の JSON は取得済み。録画は【未】 |
| 7 | Watch 実機の同期・消灯 | （Watch 側の証跡） | 対象外 |
| 8 | 結果・校正値・信号の出所の表示 | `web-result-sample.json`（「結果 JSON を保存」の出力）、画面キャプチャ `web-provenance.png` | 【未】 |
| 9 | 模擬信号・推定であることの明記 | `web-disclaimer.png`（常時表示の注記と出所表示のキャプチャ）、発表資料の該当ページ | 【未】 |
| 10 | CORE-02 全ケースで CORE-03 を満たす | `web-test.log`（`core-cases.test.js` が skip でなく成功）。core の `core/cases/core-cases.json` 作成後に取得 | 【未】（core-cases.json 未作成のため skip） |
| 11 | 証跡が決めた場所にそろっている | この README の表がすべて「取得済み」になっていること | 【未】 |
