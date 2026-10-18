// 信号データの出所表示（DOM 非依存）。API が返した項目はそのまま通し、無ければ null。
export const ESTIMATED_LABEL = 'シミュレーション（推定信号）';

const orNull = (v) => (v === undefined ? null : v);

/** API の生の 1 件から、出所表示に使う項目だけを取り出す（変換しない） */
export function pickApiMeta(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    isEstimated: orNull(r.isEstimated),
    signalType: orNull(r.signalType),
    phaseBasis: orNull(r.phaseBasis),
    positionAccuracyM: orNull(r.positionAccuracyM),
    fetchedAt: orNull(r.fetchedAt),
    crossingDirection: orNull(r.crossingDirection),
    // phaseS の基準（run-start | unix-epoch）。API が返したときだけ保持し、換算は phase.js の toCorePhaseS を通す
    ...(r.phaseReference !== undefined ? { phaseReference: r.phaseReference } : {}),
  };
}

/** API が isEstimated:false と明示した信号だけ「推定でない」。それ以外（fixture・模式・未指定）は推定として扱う */
export const isEstimatedSignal = (s) => s?.apiMeta?.isEstimated !== false;

/** 採用信号 1 件の出所（結果 JSON と画面で共通） */
export function signalProvenance(s) {
  const m = s?.apiMeta ?? pickApiMeta(null);
  return {
    isEstimated: isEstimatedSignal(s),
    signalType: orNull(m.signalType),
    phaseBasis: orNull(m.phaseBasis),
    positionAccuracyM: orNull(m.positionAccuracyM),
    fetchedAt: orNull(m.fetchedAt),
    crossingDirection: orNull(m.crossingDirection),
  };
}

export const anyEstimated = (adopted) => (adopted ?? []).some(isEstimatedSignal);

/**
 * データの出所。source は 'api' | 'fixture' | 'none'。
 * lastApiAttempt は直近の API 取得の結果（失敗して fixture に戻ったときの根拠として残す）
 */
export function buildApiInfo({ source, url = null, at = null, base = null, note = null, lastApiAttempt = null } = {}) {
  const src = source === 'api' || source === 'fixture' ? source : 'none';
  return { source: src, url: orNull(url), at: orNull(at), base: orNull(base), note: orNull(note), lastApiAttempt: orNull(lastApiAttempt) };
}

/** 取得失敗時の表示文（DATA-04）。fixture を使っていることを必ず書く */
export function apiFailureMessage(what, r, { usingFixture = true } = {}) {
  const t = r?.at ? String(r.at).slice(11, 19) : '';
  const head = `${what}の取得失敗 ${r?.url ?? ''} ${t}: ${r?.error ?? '理由不明'}`;
  return usingFixture
    ? `取得失敗・fixture（推定データ）を使用。${head}`
    : `${head}。既存の設定は変更していません。`;
}
