// phaseS の換算を 1 か所に集める（DOM 非依存）。
// API の信号は phaseReference で phaseS の基準を示す:
//   "run-start" … 走行開始（模擬時刻 0）が基準。core にそのまま渡せる
//   "unix-epoch" … Unix 時刻 0 が基準。走行開始の Unix 秒 runStartUnixS を足して周期で折り返す
//   未指定 … run-start 扱い
// core / api-adapter / route-core のどれかに toCorePhaseS が export されていれば、それを優先する【仮】
// （引数は (signal, runStartUnixS) と想定。core 側の署名が決まったら合わせる）。無ければ自前で換算する。
import { core, adapterNs, routeNs } from './core-ns.js';

export const PHASE_REFERENCES = ['run-start', 'unix-epoch'];

/** core 側の同名関数を探す（無ければ null）。呼び出しのたびに探すので、core 改訂後は再起動だけで切り替わる */
export function findCoreConverter() {
  for (const ns of [core, adapterNs, routeNs]) if (typeof ns?.toCorePhaseS === 'function') return ns.toCorePhaseS;
  return null;
}

/** 自前の換算。core に関数が無いとき用（テストから直接呼べるよう export） */
export function toCorePhaseSLocal(signal, runStartUnixS) {
  const { phaseS, cycleS } = signal ?? {};
  if (!Number.isFinite(phaseS)) throw new RangeError('toCorePhaseS: signal.phaseS が数ではありません');
  const ref = signal.phaseReference ?? 'run-start';
  if (ref === 'run-start') return phaseS;
  if (ref !== 'unix-epoch') throw new RangeError(`toCorePhaseS: phaseReference が不明: ${String(ref)}（run-start | unix-epoch）`);
  if (!Number.isFinite(cycleS) || cycleS <= 0) throw new RangeError('toCorePhaseS: unix-epoch の換算には正の cycleS が必要');
  if (!Number.isFinite(runStartUnixS)) throw new RangeError('toCorePhaseS: unix-epoch の換算には runStartUnixS（走行開始の Unix 秒）が必要');
  return (((runStartUnixS + phaseS) % cycleS) + cycleS) % cycleS;
}

/** core に渡す phaseS を返す。API 由来の信号を core に渡す箇所はすべてこれを通す */
export function toCorePhaseS(signal, runStartUnixS) {
  const coreFn = findCoreConverter();
  return coreFn ? coreFn(signal, runStartUnixS) : toCorePhaseSLocal(signal, runStartUnixS);
}

/** 信号オブジェクトを core 用に直す（phaseS を換算し、core が知らない phaseReference は外す）。入力は変更しない */
export function toCoreSignal(signal, runStartUnixS) {
  const { phaseReference, ...rest } = signal;
  return { ...rest, phaseS: toCorePhaseS(signal, runStartUnixS) };
}
