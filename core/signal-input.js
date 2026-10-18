// 信号データの入力まわり（要件 v2）：走りの下限・推定データの判定・位相の換算
// runwave-core.js の公開名を増やさないため別ファイルにしている（dev-dashboard の互換チェックが core の新しい名前を検出する）

// 走りの下限BPM：max(80, 通常BPM − maxDeltaBpm)（要件 v2 PACE-03）。
// 通常BPMが80未満なら通常BPM（下限が通常を超えないように）。推定データで減速するときの下限もこれと同じ
export const MIN_RUN_BPM = 80;
export const runLowBpm = (baseBpm, maxDeltaBpm) => Math.max(Math.min(MIN_RUN_BPM, baseBpm), baseBpm - maxDeltaBpm);

// 推定の信号データか（要件 v2 SAFE-03）。isEstimated === true か phaseBasis === 'estimated'
export const isEstimatedSignal = (x) => x?.isEstimated === true || x?.phaseBasis === 'estimated';

// API の phaseS を core の phaseS（走行開始 t=0 の時点で周期の何秒目か）に換算する。phaseReference で分ける
//   'unix-epoch'：phaseS_api は UNIX 時刻 0 秒の時点の周期内位置 → (走行開始の UNIX 秒 + phaseS_api) mod cycleS
//   'run-start' ：phaseS_api は走行開始の時点の周期内位置 → そのまま（UNIX 秒は足さない）
// 'unix-epoch' の結果は 0 以上 cycleS 未満。'run-start' は値を変えない。runStartUnixS は 'unix-epoch' のときだけ使う（必須）
export const PHASE_REFERENCES = ['unix-epoch', 'run-start'];
export function phaseAtRunStart({ phaseS, cycleS, phaseReference }, runStartUnixS) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!num(phaseS)) throw new RangeError('phaseS は数');
  if (!num(cycleS) || cycleS <= 0) throw new RangeError('cycleS は正の数');
  if (!PHASE_REFERENCES.includes(phaseReference)) throw new RangeError(`phaseReference は ${PHASE_REFERENCES.join(' / ')}`);
  if (phaseReference === 'run-start') return phaseS;
  if (!num(runStartUnixS)) throw new RangeError("phaseReference が 'unix-epoch' のときは走行開始の UNIX 秒が必要");
  const r = (runStartUnixS + phaseS) % cycleS;
  return r < 0 ? r + cycleS : r;
}
