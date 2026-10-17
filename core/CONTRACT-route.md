# route-core CONTRACT（複数信号の連続走行・route-core v0.1.0・実装済み／Web担当・バックエンド担当と最終確認する）

作成：core 担当（安原）。基準：main `f095bf0`。`CORE_VERSION` をコミット名に合わせて `0.4.1` に修正（実装は `core/route-core.js`、テストは `core/route-core.test.js`）。
Web 担当の依頼（RUNWAVE_WEB_DESIGN_Leaflet_v1.md §4.2）の関数名・入力形と一致。
単位は既存 core と同じ（時間=秒、距離=m、BPM=歩/分、dt=0.1秒固定）。

## 方針
- **既存の1信号 core（`runwave-core.js`）の判定をそのまま使う**。信号判定 `signalAt`、目標の選び方、BPM の段階調整、早歩きは同じもの
- **時刻・位置・BPM・歩き方・集計は交差点ごとに初期化しない**。次の信号に向かうとき、判定に使う「今の信号」と「横断地点の位置」だけを差し替える
- 信号が1つなら、既存の `compare` と停止回数・停止時間・所要時間が一致する（互換テストで確認）
- 表示する色と通過の判定は、同じ `signalAt(signal, t)` と共通の時刻 t を使う

## 入力（config）
```js
{
  runner:  { strideM: 0.8, baseBpm: 150, walkStrideM: 0.75 },   // 既存と同じ
  control: { ...既存の control },                               // 既存と同じ（早歩きは既定有効）
  goalM: 1400,                                                  // ゴールの位置（スタートから経路に沿って m）
  signals: [                                                    // 経路の順（atM の小さい順）
    { id: 'sapporo_3', atM: 270, signal: { cycleS, greenS, yellowS, redS, phaseS, crossingM },
      meta: { source: 'api', isEstimated: true, note: '…' } },  // meta は任意。そのまま出力に残す
  ],
}
```
- `atM`：**横断地点の位置**（スタートから経路に沿った距離、m）。`signal.crossingM`：**横断歩道の幅**（m）。別物。直接代入しない
- `signal` の形・意味は既存 core と同じ（`phaseS` は時刻0のときにサイクルの何秒目か。**全信号で共通の時刻0**）
- 入力検証（不正なら RangeError）：`atM` は正で、前の信号の `atM + crossingM` より先（横断が重ならない）、`goalM` は最後の信号の先、`id` は重複しない、各 `signal` は既存の検証を通る
- API の `distanceFromStartM` は `atM` に対応する。ただし API のデモ5交差点は最初が 0m なので、そのままでは使えない（スタート地点をどこにするかは Web/バックエンドと決める）

## 関数
| 関数 | 内容 |
|---|---|
| `createRouteRun(config)` | 最初の状態を返す（入力検証つき） |
| `stepRoute(state, config)` | 0.1秒進めた新しい状態を返す（入力の state は変更しない。ゴール後は同じ state） |
| `summarizeRoute(state, config)` | 全体と信号ごとの集計 |
| `compareRoute(config)` | 制御 OFF（通常走行）と ON（RUNWAVE）を最後まで走らせた集計。差は `control.enabled` だけ。`{ normal, runwave }` と Web 側の名前 `{ off, on }` の両方で返す（中身は同じ） |
| `simulateRoute(config, {maxTimeS=3600})` | 最後まで走らせて `{ state, summary }` |
| `validateRouteConfig(config)` | 入力検証（不正なら RangeError） |

## 出力（state）
既存 core の state の項目（`tick`・`t`・`x`・`bpm`・`targetBpm`・`mode`・`reason`・`phase`・`gait`・`speedMps`・`targetSpeedKmh`・停止と早歩きの集計・リズムの指標・`history`）をそのまま持つ。`x` は**経路上の累積距離**。追加するもの：

| 項目 | 意味 |
|---|---|
| `signalIndex` | 今向かっている（または待っている・渡っている）信号の番号。全部通過したら `signals.length` |
| `nextSignalId` | 今向かっている信号の id（全部通過したら null） |
| `signal` | 今向かっている信号の `signalAt` の結果（既存と同じ形）。全部通過後は最後の信号 |
| `events` | 信号ごとのイベントの一覧（下記）。発生順 |
| `finished`・`finishTimeS` | ゴールしたか・ゴールした時刻（既存と同じ） |

## イベント（`events[]`）
```js
{ signalId, type, t, atM, color, gait,   // 全部のイベント（gait は 'run' / 'walk'）
  passed,                                 // arrive のみ：止まらずに入れたか
  waitS }                                 // waitEnd のみ：待った秒数
```
| type | いつ |
|---|---|
| `arrive` | 横断地点（`atM`）に着いた瞬間（通過でも停止でも） |
| `waitStart` | 非青で止まった（`arrive` と同じ時刻） |
| `waitEnd` | 青になって再開した |
| `crossStart` | 横断に入った（止まらなければ `arrive` と同じ時刻） |
| `crossEnd` | 横断を渡り終えた（`atM + crossingM`） |

- `t` はステップの途中でも、その瞬間の時刻（既存 core の到着時刻の計算と同じ）
- `color` はその時刻の `signalAt(signal, t).color`
- point モデルでも `crossEnd` は `atM + crossingM` の位置で出す（早歩きの横断と同じ扱い）

## 集計（`summarizeRoute`）
- 全体：既存の summary と同じ項目（停止回数・停止時間・所要時間・BPM範囲・リズムの指標・早歩きの集計）
- 信号ごと（`summary.signals[]`）：`{ signalId, atM, meta, arriveT, crossStartT, crossEndT, waited, waitS, colorAtArrive, colorAtCross, passed, gaitAtCross }`
- `coreVersion`・`routeVersion` も入る

## 挙動規則（既存と同じ／追加）
1. 判定は、今向かっている信号だけで行う（先の信号はまだ見ない）。既存の1信号の規則（安全な時間帯、候補の選び方、早歩きへの切り替え）をそのまま使う
2. 信号を渡り終えたら、次の信号に向けて目標を選び直す。BPM は段階調整のまま引き継ぐ（急に変えない）。早歩きから走りへの戻り方は既存の規則のまま
3. 信号の間の距離が短く、早歩きのまま次の信号の判断に入る場合も、状態を引き継ぐ
4. 全部の信号を渡ったあとは、通常BPMへ戻してゴールまで走る

## 対応する横断モデル
- point（既定）と length の両方。既存と同じ `control.crossingModel` で切り替える

## 座標（api-adapter）
- `extractSignals` の結果に、API と同じ名前の `lat` / `lon` を追加（数値でなければ null）。信号の判定には使わず、地図の表示用。Web 側の回避（生の応答から読む）はやめられる

## 決めたいこと（Web 担当・バックエンド担当と）
1. 上の入力・出力・イベントの名前でよいか（特に `events` の type 名。Web 側の関数名・入力形とは一致済み）
2. API のデモ5交差点をつなぐとき、スタート地点（`atM` の基準）をどうするか（最初の交差点が 0m）
3. 1回目の `stepRoute` を何回呼ぶか（既存の `step` と同じ0.1秒ごと）でよいか
4. 先の信号まで見て計画する（次の信号も考えて BPM を選ぶ）のは今回はしない、でよいか（今回は「今向かっている信号だけ」）
