# runwave-core CONTRACT 案（v0.1.0 / UI担当と要合意）

状態: **案**。✅=実装・テスト済み、❓=チームで合意が必要。

## 単位
時間=秒(s)、距離=m、BPM=歩/分（1拍=1歩。心拍数ではない）。dt=0.1秒固定、乱数なし。

## 置き場所と読み込み
- `core/runwave-core.js`（ES module、DOM非依存）。UI からは `import { createRun, step, ... } from './core/runwave-core.js'`
- ルートの `package.json` に `"type": "module"`。

## config
```js
{
  signal:  { cycleS: 120, greenS: 50, yellowS: 5, redS: 65, phaseS: 20, crossingM: 20 },
  runner:  { strideM: 0.8, baseBpm: 150 },
  route:   { crossingX: 400, goalX: 600 },      // 停止線の位置 / ゴール位置（m、開始点から）
  control: { enabled: true, startMarginS: 3, endMarginS: 5, maxDeltaBpm: 20, stepBpm: 2, stepIntervalS: 4, horizonS: 240 },
}
```
- `greenS+yellowS+redS` と `cycleS` の差が 1e-9 未満であることを検証する。不正な値は `RangeError` ✅
- `crossingM` は**横断距離**（長さ）。0 にすると点通過モデルになる。位置は `route.crossingX` ✅
- ❓ `yellowS` は歩行者信号の**青点滅**の秒数として扱う（日本の歩行者信号に黄は無い）。フィールド名は仕様 F-02 との互換のため残す。

## state（step が返す。UI は読むだけ）
| フィールド | 意味 |
|---|---|
| `tick`, `t` | 経過 tick（整数）と秒（`t = tick/10`） |
| `x` | 開始点からの位置 m |
| `bpm`, `targetBpm` | 現在の歩調と目標。**停止中も bpm は保持**（停止は `phase` で表す） |
| `mode` | `'normal'｜'adjusting'｜'stopRecommended'｜'waiting'｜'goal'`（表示名は `MODE_LABELS`） |
| `phase` | `'approach'｜'waiting'｜'crossing'｜'after'｜'goal'` |
| `signal` | `signalAt` の結果 `{color, label, remainingS, cycleProgress}`。color は `'green'｜'flashing'｜'red'`、label は 青/青点滅/赤 |
| `stops`, `stopTimeS` | 停止回数、停止時間の合計（再開済みの分。停止中は `t - stoppedAtT` を足して表示） |
| `minBpm`, `maxBpm`, `totalBpmChange` | 走行中のBPM範囲、BPM変更量の累計 |
| `finished`, `finishTimeS` | ゴールしたか、総所要時間 |
| `history` | 1秒ごとの `{t,x,bpm,targetBpm,mode,phase,color}` |

## 関数
| 関数 | 契約 |
|---|---|
| `calibrate({distanceM, steps, timeS})` | `{strideM, baseBpm, speedMps}` ✅ |
| `signalAt(signal, t)` | 区間は半開。青[0,g) 青点滅[g,g+y) 赤[g+y,cycle)。境界ちょうどは次の色。負や周期を超える phase も正規化 ✅ |
| `safeGreenWindows(signal, fromT, untilT, control)` | **進入**してよい時刻の窓 `[青開始+startMarginS, 青終了−crossTimeS−endMarginS)`。範囲と重なる窓を返し、開始は fromT で切り詰める ✅ |
| `requiredBpm(D, L, T)` | 60D/(L·T)。一定BPMでの換算値。**到達できるかの判定には使わない** ✅ |
| `chooseTarget(state, config)` | 候補 C0−20〜C0+20 の整数BPMについて、段階調整込みで到着時刻を予測し、安全窓に入るものを選ぶ。順位は (1) 通常BPMとの差が小さい (2) 同じ差なら低い方（減速寄り）。現在の目標がまだ有効なら維持する。候補が無ければ `stopRecommended` ✅ |
| `limitRate(bpm, target, state, config)` | 変更は t=4,8,12…秒のときだけ（t=0 では変えない）、1回±2以内、C0±20 にクランプ ✅ |
| `createRun(config)` / `step(state, config)` | step は**入力を変更せず新しい state を返す**。ゴール後は同じ state を返す ✅ |
| `simulate(config)` | `{state, summary}`。`compare(config)` は制御OFF/ON の summary を返す ✅ |

## 挙動規則（通常走行と RUNWAVE で共通）
1. **進入判定**: 停止線への到着時刻に「青、かつ残りの青で横断し終えられる」なら進入する。そうでなければ停止線で待機する。青点滅・赤では進入しない ✅
2. **横断中**は信号が変わっても止まらず、進入時の BPM を保持する ✅
3. **待機からの再開**: 青になり横断できるなら、通常BPMで即時に再開する。**これは段階調整（4秒/2BPM）の例外**で、停止中は走行テンポの制限の対象外 ✅
4. **横断後**は通常BPMへ段階調整で戻る ✅
5. 停止推奨（`stopRecommended`）: その場では止まらず、通常BPMへ戻しながら停止線まで走り、そこで判定する ✅
6. startMarginS（青開始+3秒）は RUNWAVE が狙う到着時刻にだけ使う。通常走行は青ならすぐ進入する ❓
7. 目標の再計算は4秒ごと（BPMの変更機会と同じ） ✅

## 合意が必要な項目 ❓
- 横断距離 `crossingM` の値（計画書に無い）。**シナリオBの結果がこの値で変わる**（下記）
- `yellowS` を青点滅として扱うこと、color 値 `'flashing'`、表示名
- mode/phase の値、state のフィールド名（UI の描画と1対1で対応させる）
- 規則6（通常走行には余裕を課さない）

## 比較結果（core v0.1.0、`npm run scenarios`、Node v24.19.0）
条件: 歩幅0.8m、通常150BPM、停止線400m、ゴール600m、周期120/青50/青点滅5/赤65、余裕3/5秒、dt=0.1秒。
**原文で「仮」とされている値（余裕・dt）と、原文に無い追加の仮定（横断距離、横断時間を引いた安全窓、通常走行には開始余裕を課さない規則6）の上での結果。** これらが変われば結果も変わる。

| シナリオ | 横断距離 | 通常: 停止回数/停止時間/総時間 | RUNWAVE: 停止回数/停止時間/総時間 | RUNWAVE BPM範囲 |
|---|---|---|---|---|
| A phaseS=20 | 20m | 1回 / 20s / 320.0s | 0回 / 0s / 326.3s | 133–150（減速） |
| A phaseS=20 | 0m | 1回 / 20s / 320.0s | 0回 / 0s / 325.0s | 133–150 |
| B phaseS=100 | 20m | 1回 / 60s / 360.0s | **1回 / 60s / 360.0s**（回避不可） | 150 |
| B phaseS=100 | 0m | 1回 / 60s / 360.0s | 0回 / 0s / 282.9s | 150–164（加速） |

### デモ推奨（10/17 提案・未合意。`DEMO` in scenarios.js）
A/B と同じ道のり（400m/600m、横断20m、信号120/50/5/65、余裕3/5）で、位相だけ変える。

| 案 | phaseS | 通常 | RUNWAVE | BPM | 頑健性 |
|---|---|---|---|---|---|
| **main（加速）** | 90 | 1回 / 70s停止 / 370.0s | 0回 / 283.4s（87秒早い） | 150–163 | 位相±5秒で成立 |
| sub（減速） | 26 | 1回 / 14s停止 / 314.0s | 0回 / 319.8s（5.8秒遅い） | 137–150 | 位相±5秒で成立 |

- 動画: 比較画面を12倍速にすると main は約31秒（通常側が370秒で終わるまで）
- 条件は歩幅0.8m・通常150BPM に合わせたもの。歩幅を実測値に替えると成立しないことがある

読み方（発表用の注意）:
- A は**停止はなくなるが、総時間は通常より約6秒長い**（減速して次の青を待つため）。「時間短縮」と言わず、「止まらずに走り続けられる」と説明する。
- B は横断距離20mだと、横断時間と余裕を引いた窓に±20BPMでは届かない。加速で停止を回避できるのは点通過モデルのときだけ。
- いずれも架空信号・歩幅一定の**モデル上の推定値**。

## テスト
- 実行: `npm test`（= `node --test "core/*.test.js"`）。**`node --test core/` は Node 24 では動かない**（ディレクトリを1つのファイルとして実行しようとして失敗する。確認済み）
- 内容: 手計算（calibrate、159.6）、信号の境界と位相、安全窓、limitRate、位相17通り×横断距離2通り×ON/OFFでの性質（BPM範囲、4秒/2BPM、非青で進入しない、横断中は常に青）、ゴール後、再現性、入力を変更しないこと、シナリオA/B
