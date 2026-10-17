// 比較シナリオ（作業票 v4 5章の仮条件。値はチームで合意後に更新する）
// 横断モデルは既定の point（横断地点での通過判定）。signal.crossingM（横断長）は length モデルのときだけ使う
const base = {
  runner: { strideM: 0.8, baseBpm: 150 },
  route: { crossingX: 400, goalX: 600 },   // 横断地点の位置 / ゴール位置（スタートからの m）
  control: { startMarginS: 3, endMarginS: 5, maxDeltaBpm: 20, stepBpm: 2, stepIntervalS: 4, targetIntervalS: 1 },
};
const signal = (phaseS, crossingM) => ({ cycleS: 120, greenS: 50, yellowS: 5, redS: 65, phaseS, crossingM });

export const SCENARIOS = {
  A: { ...base, signal: signal(20, 20) },
  B: { ...base, signal: signal(100, 20) },
};

// デモ推奨（未合意）。point モデルで位相±5秒でも成立を確認済み
export const DEMO = {
  main: SCENARIOS.B,                          // 加速: 通常は60秒停止、RUNWAVE は止まらず早く着く
  sub: { ...base, signal: signal(26, 20) },   // 減速: 通常は14秒停止、RUNWAVE は止まらない（総時間は少し長い）
};

export const withCrossing = (config, crossingM) => ({ ...config, signal: { ...config.signal, crossingM } });
export const withModel = (config, crossingModel) => ({ ...config, control: { ...config.control, crossingModel } });

// ---------- 改定案（10/17・未合意）：横断地点 800m・余裕 開始後3秒/終了前8秒・横断長15m ----------
// 400m では ±20BPM で到着をずらせる幅が約48秒しかなく、位相120通りのうち30通りで止まるのが避けられない。
// 800m なら全120通りで RUNWAVE は止まらない（point・length とも。モデル上）。
// 終了前8秒は、15m を渡り切るのに必要な時間（約7〜8秒）を青の残りで確保するため。
// ダッシュボード（frontend/dev-dashboard）は SCENARIOS / DEMO を前提にしたテストがあるので、
// 切り替えは担当者と確認してから行う（docs の変更確認リスト参照）
const base800 = {
  runner: { strideM: 0.8, baseBpm: 150 },
  route: { crossingX: 800, goalX: 1000 },
  control: { startMarginS: 3, endMarginS: 8, maxDeltaBpm: 20, stepBpm: 2, stepIntervalS: 4, targetIntervalS: 1 },
};
export const SCENARIOS_800M = {
  A: { ...base800, signal: signal(59, 15) },   // 減速で停止を回避（減速で回避できる位相 43〜75 の中央）
  B: { ...base800, signal: signal(24, 15) },   // 加速で停止を回避（加速で回避できる位相 15〜32 の中央）
};
export const DEMO_800M = {
  main: SCENARIOS_800M.B,
  sub: SCENARIOS_800M.A,
};

// ---------- 早歩きフェーズの比較シナリオ（v0.4.0・未合意） ----------
// 今のデモと同じ 400m・余裕3/5秒・横断長15m で、走りだけでは止まる位相に早歩きを有効にした例。
// 既存の SCENARIOS / DEMO は変えない（ダッシュボードが対応してから切り替える）
const baseWalk = {
  runner: { strideM: 0.8, baseBpm: 150, walkStrideM: 0.75 },
  route: { crossingX: 400, goalX: 600 },
  control: { startMarginS: 3, endMarginS: 5, maxDeltaBpm: 20, stepBpm: 2, stepIntervalS: 4, targetIntervalS: 1, walk: { enabled: true } },
};
export const SCENARIOS_WALK = {
  W: { ...baseWalk, signal: signal(5, 15) },   // 走りだけでは止まる（30通りのうちの1つ）→ 早歩きでつなぐ
};
