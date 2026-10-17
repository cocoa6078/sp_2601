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
