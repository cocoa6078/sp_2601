// 経路の編集（開始/終了/経由点）と、経路上の信号の採用・検証（DOM 非依存）
import { core } from './core-ns.js';
import { buildRoute, isFiniteLL, projectOnRoute, validateRoute } from './route-geometry.js';

export const DEFAULT_TOLERANCE_M = 30;   // 【UI 設計値。精度保証ではない】
export const MAX_SIGNALS = 5;
export const EDGE_MARGIN_M = 15;         // スタート/ゴール直上とみなす距離

/** draft = { start, end, via: [] } → 折れ線の点列。start/end が揃わなければ null */
export function draftPoints(draft) {
  if (!draft.start || !draft.end) return null;
  return [draft.start, ...draft.via, draft.end];
}

export function draftRoute(draft, id = 'manual') {
  const pts = draftPoints(draft);
  if (!pts) return { route: null, errors: ['開始地点と終了地点を置いてください'] };
  let route;
  try {
    route = buildRoute(pts, { id, source: 'manual-polyline' });
  } catch (e) {
    return { route: null, errors: [e.message] };
  }
  const v = validateRoute(route);
  return { route, errors: v.errors };
}

// 経由点の編集（不変更新）
export const addVia = (draft, p) => ({ ...draft, via: [...draft.via, p] });
export const moveVia = (draft, i, p) => ({ ...draft, via: draft.via.map((v, k) => (k === i ? p : v)) });
export const removeVia = (draft, i) => ({ ...draft, via: draft.via.filter((_, k) => k !== i) });
export function reorderVia(draft, i, delta) {
  const j = i + delta;
  if (j < 0 || j >= draft.via.length) return draft;
  const via = [...draft.via];
  [via[i], via[j]] = [via[j], via[i]];
  return { ...draft, via };
}

/**
 * 候補信号 candidates（{ key, signalId, region, lat, lng, signal }）を経路へ対応付ける。
 * - 垂直距離が toleranceM 以内のものを「候補（採用）」にする。同一 key は最近の投影 1 件だけ
 * - manualExclude（Set<key>）に入れたものは除外（ユーザーの手動操作）
 * - 経路上の距離 s の昇順で並べる。勝手に削除せず、不正条件は errors に出す
 */
export function matchSignals(route, candidates, { toleranceM = DEFAULT_TOLERANCE_M, maxSignals = MAX_SIGNALS, manualExclude = new Set() } = {}) {
  const excluded = [];
  const projected = [];
  for (const c of candidates) {
    const label = c.signalId ?? c.key;
    if (!isFiniteLL(c)) {
      excluded.push({ key: c.key, signalId: label, code: 'invalid-coordinates', reason: '座標が不明または数値でない' });
      continue;
    }
    try {
      core.validateSignal(c.signal);
    } catch (e) {
      excluded.push({ key: c.key, signalId: label, code: 'invalid-signal', reason: `信号の値が不正: ${e.message}` });
      continue;
    }
    const pr = projectOnRoute(route, c);
    projected.push({ ...c, s: pr.s, offsetM: pr.distM, projPoint: pr.point });
  }
  // 同一 key は最も近い投影を 1 件だけ
  const bestByKey = new Map();
  for (const p of projected) {
    const cur = bestByKey.get(p.key);
    if (!cur || p.offsetM < cur.offsetM) bestByKey.set(p.key, p);
  }
  const kept = [];
  for (const p of projected) {
    if (bestByKey.get(p.key) !== p) {
      excluded.push({ key: p.key, signalId: p.signalId ?? p.key, code: 'duplicate', reason: '同じ信号の遠い側の投影（最も近い 1 件だけ採用）' });
    } else if (p.offsetM > toleranceM) {
      excluded.push({ key: p.key, signalId: p.signalId ?? p.key, code: 'too-far', reason: `経路から ${p.offsetM.toFixed(0)} m 離れている（許容 ${toleranceM} m）` });
    } else if (manualExclude.has(p.key)) {
      excluded.push({ key: p.key, signalId: p.signalId ?? p.key, code: 'manual', reason: '手動で除外' });
    } else kept.push(p);
  }
  kept.sort((a, b) => a.s - b.s);
  const errors = [];
  if (kept.length > maxSignals) errors.push(`信号が ${kept.length} 件あります（初版は最大 ${maxSignals} 件。不要なものを除外してください）`);
  for (const p of kept) {
    if (p.s < EDGE_MARGIN_M) errors.push(`${p.signalId}: スタート直上です（${p.s.toFixed(0)} m）。開始地点を離してください`);
    if (route.lengthM - p.s < EDGE_MARGIN_M) errors.push(`${p.signalId}: ゴール直上です（残り ${(route.lengthM - p.s).toFixed(0)} m）。終了地点を離してください`);
  }
  for (let i = 1; i < kept.length; i++) {
    const gap = kept[i].s - kept[i - 1].s;
    const need = Math.max(kept[i - 1].signal.crossingM, 1);
    if (gap < need) errors.push(`${kept[i - 1].signalId} と ${kept[i].signalId} が近すぎます（${gap.toFixed(0)} m < 横断幅 ${need} m。横断区間が重なる）`);
  }
  return { adopted: kept, excluded, errors, none: kept.length === 0 };
}
