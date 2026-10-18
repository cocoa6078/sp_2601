# RUNWAVE 発表用 連動デモ（presentation-simulator）

人物 → ①状態入力 → ②判定処理 → ③スマホ／Apple Watch → 人物の反応、までを 1 画面で見せる発表・画面収録用アプリ。
仕様: `20261017_仕様書_RUNWAVE_発表用Webシミュレーター_v2.md`（正）。実 API・サーバー・実機は使わない（ブラウザ内で core を実行。通信は発生しない）。
端末（スマホ・Watch）と振動はイメージ表示。BPM は歩調（歩/分）で心拍数ではない。

## 起動

```
cd frontend/presentation-simulator
npm install
npm run dev      # http://127.0.0.1:5175/（使用中なら次のポート）
npm test         # node --test（DOM なし）
npm run build    # dist/
```
`.claude/launch.json` の `presentation-simulator` からも起動できる。dashboard（5173）・web-simulator（5174）とは独立。

## 通しデモ（初期表示）

B → A → W を自動で続けて再生（再生ボタンで開始）。倍率は 5 倍固定。各シナリオは「見せ場の窓」だけを再生し、窓のあいだは「▶▶ 約○秒後」を 0.6 秒出してカット（core を逐次 step して得た tick の state へジャンプ。補間しない）。
- 窓1: 最初に目標BPMが変わった tick から sim 12 秒（ここでズーム演出。A は短縮版）。
- 窓2: 横断地点の 30m 手前に入る tick から、x ≥ 横断地点＋横断長＋10m まで。W はさらに窓2a（walking の 2 秒前〜6 秒後。walking 開始で短縮ズーム）。ゴールまでは再生しない。
- 合計の実時間は約 44〜45 秒（計画 44.4 秒）。`src/tour.js` の定数で調整できる。
リセットで B の頭に戻る。単体シナリオ・「30秒」等の倍率は別モード。ズーム演出は ON/OFF 可（既定 ON）で、表示だけ（state・時計・tick を変えない）。

## 操作

再生／一時停止／リセット／倍率（30秒・1・2・5倍）／シナリオ B・A・W（停止中のみ）／処理を見せる／見せ場へ移動。
- 倍率は初期値「30秒」: スタートからゴールまでが実時間で約 30 秒。倍率はシナリオごとに「同じ config を core で最後まで逐次 step した所要時間 ÷ 30」で決まる（B 約9.5倍・A 約10.8倍・W 約11.4倍）。設定値・dt・信号周期は変えず、時計の進め方だけを変える。
- 処理を見せる: 時計を止め（30 秒の計算に含めない）、入力→予測→照合→決定→出力を各 0.8 秒で順に強調。終了後も停止のまま。
- 見せ場へ移動: 初期状態から core を逐次 step して見つけた tick へ移動（B/A=テンポ調整、W=早歩きへの切替準備→早歩き。ボタンを押すごとに次の見せ場）。見つからない条件では無効。
- タブ非表示で自動停止。復帰しても自動再開しない。

## 構成

`src/` simulation（core・時計・セッション・場面ジャンプ）／demo-view-model（全表示の値を同じ state から 1 回で生成）／world-view／flow-view／phone-view／watch-view／explanation-controller／scenarios（B=SCENARIOS.B, A=SCENARIOS.A, W=SCENARIOS_WALK.W。enabled=true・point・早歩き有効・終了前余裕 5 秒を明示）／main／styles。
core は `src/core-ns.js` からリポジトリ共通の `../../../core/` を直接参照します（コピーせず、ここでは変更しません）。現在の `core/runwave-core.js` の版は **0.5.1** です。

## 収録手順

ブラウザのズーム 100%・ウィンドウ 1920×1080 で開く（画面が小さい場合は 1920×1080 の固定ステージを縮小表示）。
リセット → 再生（30秒）→ 途中で「処理を見せる」→ 再生 → W に切替して「見せ場へ移動」。収録は OS の画面収録を使う。

## 確認結果（2026-10-17・実装者環境）

- 当時の共通 core v0.4.1 を参照した状態で `npm test` 24 件成功／`npm run build` 成功。Chrome 系（Browser pane）で B・W の描画と解説モードを目視確認。core はその後更新され、現在は v0.5.1 です。この記録は 2026-10-17 時点の結果であり、現行 core に対する再確認結果ではありません。
- 見せ場の tick: B adjust@1、A adjust@1、W prep@1・walk@1671。
- 未確認: Mac の収録対象ブラウザ、1 倍速での実時間全編、実機との見た目差。
- 【要確認】早歩き時の歩幅表示は runner.walkStrideM 未指定なら 0.75 m（core の既定と同値のはずだが core 内部定数のため複製）。
