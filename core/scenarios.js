// 比較シナリオ（仮の条件。値はチームで合意後に更新する）
// crossingM（横断距離）は計画に値が無いため仮置き。結果はこの値で変わる（CONTRACT.md 参照）
const base = {
  runner: { strideM: 0.8, baseBpm: 150 },
  route: { crossingX: 400, goalX: 600 },
  control: { startMarginS: 3, endMarginS: 5, maxDeltaBpm: 20, stepBpm: 2, stepIntervalS: 4 },
};
const signal = (phaseS, crossingM) => ({ cycleS: 120, greenS: 50, yellowS: 5, redS: 65, phaseS, crossingM });

export const SCENARIOS = {
  A: { ...base, signal: signal(20, 20) },
  B: { ...base, signal: signal(100, 20) },
};

// デモ推奨（10/17 提案・未合意）。A/B と同じ道のりで位相だけ変える。位相±5秒でも成立を確認済み
export const DEMO = {
  main: { ...base, signal: signal(90, 20) },   // 加速: 通常は70秒停止、RUNWAVE は止まらず早く着く
  sub: { ...base, signal: signal(26, 20) },    // 減速: 通常は14秒停止、RUNWAVE は止まらない（総時間は少し長い）
};

// 横断距離の感度確認用
export const withCrossing = (config, crossingM) => ({ ...config, signal: { ...config.signal, crossingM } });
