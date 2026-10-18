# runwave-core CONTRACT 案（v0.3.0 / 作業票 v4 準拠・UI担当と要合意）

状態: **案**。✅=実装・テスト済み、❓=チームで合意が必要。
実測入力・ユーザー操作・優先順位（v4 9章 Y11/Y12）は [CONTRACT-ext.md](CONTRACT-ext.md)。

## 単位
時間=秒(s)、距離=m、BPM=歩/分（ケイデンス。1拍=1歩。心拍数ではない）。dt=0.1秒固定、乱数なし。

## 置き場所と読み込み
- `core/runwave-core.js`（ES module、DOM・通信に依存しない）。UI からは `import { createRun, step, ... } from './core/runwave-core.js'`
- API の取得はフロントが行い、`core/api-adapter.js` で検証・変換した config を core に渡す。API なしでも固定 config で同じ計算が動く ✅
- テスト: リポジトリ直下で `npm test`

## config
```js
{
  signal:  { cycleS: 120, greenS: 50, yellowS: 5, redS: 65, phaseS: 100, crossingM: 20 },
  runner:  { strideM: 0.8, baseBpm: 150 },
  route:   { crossingX: 400, goalX: 600 },
  control: { enabled: true, crossingModel: 'point', startMarginS: 3, endMarginS: 5,
             maxDeltaBpm: 20, stepBpm: 2, stepIntervalS: 4, targetIntervalS: 1, horizonS: 3600 },
}
```

### 距離の対応（直接代入しない）❓
| 意味 | core | API | 作業票 v4 の表記 |
|---|---|---|---|
| スタートから横断地点までの位置（400m） | `route.crossingX` | なし（フロントが決める） | `course.crossingM` |
| 横断歩道の長さ（15m など） | `signal.crossingM` | `crossingM` | API の crossingM |

`signal.crossingM`（横断長）は `crossingModel: 'length'` のときだけ使う。既定の `point` では無視する ✅

### 入力検証 ✅（不正なら RangeError）
- 数値は有限（NaN・Infinity・null を拒否）。周期は正、各区間は0以上、`greenS+yellowS+redS` と `cycleS` の差が 1e-9 未満
- `dt` を渡すなら 0.1 のみ。`stepIntervalS`・`targetIntervalS` は 0.1 秒の倍数の正の数
- `horizonS` は予測の上限（計算の打ち切り、既定3600秒）。予測範囲は横断地点までの距離から決めるので、既定のままでは効かない（v0.2.0 以前の「240秒先まで」の意味ではない）
- `crossingModel` は `point` / `length`、`enabled` は true/false、余裕は0以上
- `goalX > crossingX + 横断長`（point では横断長0）、`baseBpm − maxDeltaBpm > 0`
- `signalAt`・`safeGreenWindows`・`requiredBpm`・`calibrate`・`simulate` も引数を検証する

## state（step が返す。UI は読むだけ）
| フィールド | 意味 |
|---|---|
| `tick`, `t` | 経過 tick（整数）と秒（`t = tick/10`） |
| `x` | スタートからの位置 m |
| `bpm`, `targetBpm` | 現在の歩調と目標。**待機中は bpm=0** ✅ |
| `reason` | 目標を選んだ理由（`REASONS`）: `none` 調整不要／`signal` 信号に合わせて調整中／`noMargin` 余裕付きの計画は無いが通常BPMで青に着く見込み／`unavoidable` どの候補でも青に着けない（停止推奨）／`off` 制御OFF（常に）／`waiting` 横断地点で信号待ち／`passed` 横断地点を通過済み。phase が変わった時点で更新 ✅ |
| `mode` | `normal`／`adjusting`／`stopRecommended`／`waiting`／`finished`（表示名は `MODE_LABELS`: 通常／テンポ調整中／停止推奨／信号待ち／ゴール）✅ |
| `phase` | `approach`／`waiting`／`crossing`（length のみ）／`after`／`finished` |
| `signal` | `{color, label, remainingS, cycleProgress}`。color は `green`／`flashing`／`red`、label は 青／青点滅／赤 ❓ |
| `stops`, `stopTimeS`, `stoppedAtT` | 停止回数、再開済みの停止時間の合計、待機を始めた時刻（待機中の表示は `stopTimeS + (t − stoppedAtT)`） |
| `minBpm`, `maxBpm`, `totalBpmChange` | 走行中の BPM 範囲、BPM 変更量の累計（停止・再開の飛びは含めない） |
| `deviationBpmS`, `offBaseTimeS`, `runStartT`, `longestRunS` | リズムの指標：基準BPMからのずれ×時間（BPM·秒）、基準から外れて走った時間、最後に走り始めた時刻、止まらずに走れた最長時間（走行中も毎ステップ更新）。どれもゴールの瞬間までを数える ✅ |
| `finished`, `finishTimeS` | ゴールしたか、総所要時間（ゴールした瞬間の時刻） |
| `history` | 1秒ごとの `{t,x,bpm,targetBpm,mode,reason,phase,color}`（BPM 履歴） |

## 関数
| 関数 | 契約 |
|---|---|
| `calibrate({distanceM, steps, timeS})` | `{strideM, baseBpm, speedMps}`。160m/200歩/80秒 → 0.8m・150BPM・2m/s ✅ |
| `signalAt(signal, t)` | 区間は半開。青[0,g) 青点滅[g,g+y) 赤[g+y,cycle)。境界ちょうどは次の色。浮動小数の誤差は安全側（赤→青の境界は「まだ赤」）。判定は丸めず、丸めは表示用の remainingS だけ。負や周期を超える phase も正規化 ✅ |
| `safeGreenWindows(signal, fromT, untilT, control)` | 横断地点に着いてよい時刻の窓 `[青開始+startMarginS, 青終了−crossTimeS−endMarginS)`。point では crossTimeS=0 ✅ |
| `requiredBpm(D, L, T)` | 60D/(L·T)。D は残り距離、T は**到着までの残り秒**（絶対時刻ではない）。D=0 は0、T≤0 は拒否。目標の確定には使わない ✅ |
| `chooseTarget(state, config)` | 候補 C0−20〜C0+20 の整数BPMを、**4秒/2BPM の段階調整込みで到着時刻を予測**し、安全窓に入るものを選ぶ。順位は (1) 通常BPMとの差が小さい (2) 同じ差なら低い方（減速寄り）。**毎秒選び直す**（通常に近い目標で済むようになればそちらへ）。同じ差の候補が両方使えるときは今の目標を保つ。予測は**横断地点に着くまで必ず行う**（固定の予測範囲は無い）。最速と最遅の到着の間に安全窓が無ければ全候補を試さず判断する。候補なしのとき、通常BPMで青に着けるなら `normal`（reason=noMargin）、着けなければ `stopRecommended`（reason=unavoidable） ✅ |
| `limitRate(bpm, target, state, config)` | 変更は t=4,8,12…秒のときだけ、1回最大2、C0±20 にクランプ ✅ |
| `createRun(config)` / `step(state, config)` | step は**入力を変更せず**、走行中は新しい state、ゴール後は同じ state を返す ✅ |
| `simulate(config, {maxTimeS=1800})` | `{state, summary}`。summary に `termination: 'finished'｜'timeLimit'`（時間切れは到達不能と断定しない）、リズムの指標 `deviationBpmS`・`offBaseTimeS`・`longestRunS` ✅ |
| `compare(config)` | 制御 OFF/ON の summary。差は `control.enabled` だけ ✅ |

## 挙動規則（通常走行と RUNWAVE で共通）
1. **横断地点の判定（point）**: 横断地点に着いた時刻の信号が青なら通過、それ以外（青点滅・赤）は止まる。1ステップでまたぐ場合も到達時刻で判定 ✅
2. **length モデル（拡張）**: 上に加えて、残りの青のうちに渡り切れるときだけ進入。横断中は信号が変わっても止まらず、BPM を保つ ✅ ❓（採用は要合意）
3. **再計算の周期**: 目標BPMの再計算は1秒ごと、BPM の変更は4秒ごと（別の周期）✅
4. **停止推奨**: どの候補でも青に着けず、通常BPMでも非青に着くときだけ。その場では止まらず、**走りの下限（通常BPM−20）へ段階的に下げながら**横断地点まで進み、非青ならそこで止まる（改善ループ c07a・要合意：以前は通常BPMへ戻していた。遅く着くほど待つ時間が短く、余裕なしで青に着いて止まらずに済む場合もある）。**早歩きが使えて、その先に信号が無い（最後の信号・1信号）ときは、最も遅い早歩きで近づく**（改善ループ c08b・要合意。途中の信号では使わない：遅れが後ろの信号に響くため）✅
5. **待機と再開**: 待機中は速度0・bpm=0。青になったら通常BPMで即時再開（**段階調整・±20 の検証から除く例外**）✅ ❓
6. **横断後**: 通常BPMへ段階調整で戻る ✅
7. **安全余裕**: 青開始後3秒・終了前5秒は RUNWAVE が狙う到着時刻にだけ使う。通常走行は青なら通過する ❓
9. **渡り切りの優先（改善ループ c02e・要合意）**: point モデルでも、RUNWAVE はその速さで横断を渡り切る青が残る時間帯（青終了 − 横断時間 − 終了前の余裕 まで）に着ける候補があれば、そちらを先に選ぶ。無ければ従来どおり「横断地点で青なら入れる」時間帯で選ぶ。進入の判定（規則1）は変えない。通常BPMでも止まらない場合に、渡り切るため小さく調整することがある（例：シナリオ A を 1000m に置くと 150→152）
8. **ゴール後**は統計を増やさない ✅

## 合意が必要な項目 ❓
- 距離の名前（`route.crossingX` と v4 の `course.crossingM`）
- 横断モデル（point を既定、length は拡張）
- `yellowS` を青点滅として扱うこと、color 値 `flashing`、表示名
- 再開の例外、安全余裕の適用範囲（規則5・7）
- 候補の「変化が小さい」の基準（今は通常BPMとの差）

## 早歩きフェーズ（v0.4.0・v0.4.1 から既定で有効）
> v0.4.1: 既定を `walk.enabled: true` に変更（10/17 チーム決定）。従来の数値が必要な config は `walk: { enabled: false }` を明示する。
走り（通常BPM±maxDeltaBpm）では安全な青に間に合わず止まるしかないときだけ、時速5.3〜5.8km の早歩きでつなぐ。既定は `control.walk.enabled: true`（v0.4.1・10/17 チーム決定）。`walk: { enabled: false }` を明示すれば従来（走りのみ）と完全に同じ結果で、state・summary に新しい項目も出ない。

- 設定：`control.walk = { enabled, minKmh: 5.3, maxKmh: 5.8, stepKmh: 0.1 }`、`runner.walkStrideM`（早歩きの歩幅、既定0.75m【仮】。API の calibration の `walkStrideM` から受け取れる）
- 判断の順番：走りの候補で間に合う → 今まで通り ／ 通常BPMなら余裕なしで青（noMargin）→ 今まで通り ／ **早歩き**（mode `walking`、reason `walkBridge`）／ それでも無理 → 停止推奨
- 早歩きの決め方：「あと1秒走ってからでも早歩きで間に合う」うちは走りの下限へ向けて走り続け（mode `adjusting`、reason `walkBridge`）、間に合わなくなる直前に切り替える。速さは安全な時間帯の中央に近く着くもの（同程度なら速いほう）。早歩き中も1秒ごとに速さを見直す。一度歩いたら横断を渡り終えるまで歩く
- 早歩きの安全な時間帯：point モデルでも横断時間（横断長 ÷ 早歩きの速さ）を数える：`[青開始+3秒, 青終了−横断時間−終了前の余裕)`
- 切り替え：走り→早歩きはすぐ（段階調整の例外）。point モデルでも横断長ぶんは歩いて渡り、渡り終えた瞬間に通常BPMの走りへ戻す（例外）
- 出力（有効時のみ）：`gait`（run/walk）、`speedMps`、`targetSpeedKmh`、早歩き中の `bpm`・`targetBpm` は 速さ×60÷walkStrideM（Watch のテンポ用の目安）、`walkCount`・`walkTimeS`・`walkDistanceM`・`walkMinBpm`・`walkMaxBpm`（summary にも）。history に `gait`・`speedMps`。`minBpm`・`maxBpm`・`totalBpmChange`・`deviationBpmS`・`offBaseTimeS` は走りの間だけ
- 早歩きを使うときは `goalX > crossingX + 横断長`（横断の途中をゴールにしない）
- 比較シナリオ：`SCENARIOS_WALK.W`（400m・位相5：走りだけでは35秒停止 → 早歩き81秒・120mで停止なし）

| 横断地点まで（位相120通り・point） | 通常走行 | RUNWAVE（走りだけ） | RUNWAVE（早歩きあり） | 早歩きの回数・平均 |
|---|---|---|---|---|
| 400m（余裕3/5秒） | 70回止まる | 30回 | **0回** | 28回・118秒・173m |
| 600m（余裕3/5秒） | 70回 | 3回 | **0回** | 0回（走りの下限まで減速するだけで回避） |
| 800m（余裕3/8秒） | 71回 | 0回 | 0回 | 0回 |
（length モデル・400m：36回 → 0回、早歩き34回）

## 比較結果（core v0.3.0、`npm run scenarios`、Node v24.19.0）
条件（v4 5章）: 歩幅0.8m、通常150BPM、横断地点400m、ゴール600m、周期120/青50/青点滅5/赤65、余裕3/5秒、±20BPM・4秒で最大2、目標再計算1秒、dt=0.1秒。

| シナリオ | 横断モデル | 通常: 停止回数/停止時間/総時間 | RUNWAVE: 停止回数/停止時間/総時間 | RUNWAVE BPM |
|---|---|---|---|---|
| A phaseS=20 | point | 1回 / 20s / 320.0s | 0回 / 0s / 324.6s | 133–150（減速） |
| B phaseS=100 | point | 1回 / 60s / 360.0s | 0回 / 0s / 284.1s | 150–164（加速） |
| A | length（横断20m） | 1回 / 20s / 320.0s | 0回 / 0s / 325.9s | 133–150 |
| B | length（横断20m） | 1回 / 60s / 360.0s | 0回 / 0s / 366.8s（v0.4.1 早歩き1回。walk:false なら 1回 / 60s / 360.0s・回避不可） | 150 |

- v4 の想定どおり、point モデルでは **A は減速、B は加速で停止を回避**できた
- RUNWAVE の目的は止まらずに走り続けること（総時間は参考値）
- デモ推奨（`DEMO`、未合意）: main = シナリオB（位相±5秒でも成立）、sub = 位相26（通常14秒停止 → RUNWAVE 停止なし、位相±5秒でも成立）
### 改定案（10/17・未合意）：横断地点 800m・余裕 開始後3秒/終了前8秒・横断長15m（`SCENARIOS_800M`・`DEMO_800M`）
400m では ±20BPM で到着をずらせる幅が約48秒しかなく、位相120通りのうち30通りで止まるのが避けられない（アルゴリズムの取りこぼしではない）。調整を始める距離を延ばすと解消する（600m で3通り、620m 以上で0通り）。

| シナリオ | 横断モデル | 通常: 停止回数/停止時間/総時間 | RUNWAVE: 停止回数/停止時間/総時間 | RUNWAVE BPM |
|---|---|---|---|---|
| A phaseS=59 | point | 1回 / 21s / 521.0s | 0回 / 0s / 524.3s | 141–150（減速） |
| B phaseS=24 | point | 1回 / 56s / 556.0s | 0回 / 0s / 477.4s | 150–159（加速） |
| A | length（横断15m） | 1回 / 21s / 521.0s | 0回 / 0s / 524.5s | 141–150 |
| B | length（横断15m） | 1回 / 56s / 556.0s | 0回 / 0s / 469.5s | 150–163 |

- **位相0〜119の全120通りで、RUNWAVE は止まらない**（point・length とも）
- 通過するときは、15m を渡り切る（約7〜8秒）以上の青が残る
- `SCENARIOS` / `DEMO` への切り替えは、ダッシュボード（frontend/dev-dashboard）のテストが旧シナリオを前提にしているため、担当者と確認してから行う
- core の `endMarginS` の既定値は 8秒（`SCENARIOS` の旧条件は 5秒を明示しているので結果は変わらない）

- 数値はすべて、架空信号・固定歩幅の**モデル上の推定値**。API の信号（JARTIC 車両用の参考プリセット）でこの config を自動上書きしない

## テスト
- 実行: `npm test`（= `node --test "core/*.test.js" "tools/*.test.js"`）。`node --test core/` は Node 24 では動かない
- 内容: v4 6章の手計算（159.57・139.53・calibrate）、信号の境界と位相・複数周期、安全窓、limitRate、位相17通り×横断モデル2通り×ON/OFF での性質（BPM範囲、4秒/2BPM、待機中0、再開の例外、非青で通過しない、停止回数）、目標の再計算1秒、point で横断長を使わないこと、ゴール後、時間切れ、入力検証、再現性、入力を変更しないこと、シナリオA/B・デモ、v0.3.0 の回帰（遠い横断地点で不要な加速・誤った停止推奨をしない、赤の終わり直前を青にしない、ゴール時刻が手計算と一致、リズムの指標）
