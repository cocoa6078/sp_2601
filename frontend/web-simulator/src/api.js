// API 読み込み（GET のみ・手動実行）。形式検証は core/api-adapter.js の extractSignals / extractRunner を使う。
// URL 組み立てと既定値は dev-dashboard の DOM 非依存クライアントを import して再利用（dashboard 側は変更しない）。
// POST /api/logs は使わない（結果は JSON をローカル保存）。
import { DEFAULT_API_BASE, DEFAULT_TIMEOUT_MS, buildUrl } from '../../dev-dashboard/src/api-client.js';
import { adapterNs, core } from './core-ns.js';

export { DEFAULT_API_BASE, DEFAULT_TIMEOUT_MS };

async function getJson(base, path, { fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = DEFAULT_TIMEOUT_MS, now = () => new Date() } = {}) {
  const out = { at: now().toISOString(), url: null, ok: false, httpStatus: null, json: null, error: null };
  try {
    out.url = buildUrl(base, path);
  } catch (e) {
    out.error = e.message;
    return out;
  }
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  try {
    const res = await fetchImpl(out.url, { method: 'GET', cache: 'no-store', headers: { accept: 'application/json' }, signal: ctrl.signal });
    out.httpStatus = res.status;
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      out.error = `HTTP ${res.status}`;
      return out;
    }
    try {
      out.json = JSON.parse(text);
    } catch (e) {
      out.error = `本文が JSON として読めない: ${e.message}`;
      return out;
    }
    out.ok = true;
  } catch (e) {
    out.error = timedOut
      ? `タイムアウト（${timeoutMs}ms 以内に応答なし）`
      : `接続できません（サーバー停止・URL・ポート違い、またはブラウザの CORS 拒否の可能性。ブラウザでは区別できません）: ${e.name}: ${e.message}`;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/**
 * GET /api/signals を読み、地図に対応付けられる候補信号にする。
 * 候補 = { key, region, signalId, lat, lng, signal, origin:'api', note }。座標が無い／不正なものは lat/lng が NaN のまま
 * 返し（後段で「座標が不明」として除外理由を出す）、信号の値が不正なものは invalid に分ける。
 */
export async function fetchSignals(base, opts = {}) {
  const r = await getJson(base, '/api/signals', opts);
  const res = { ok: false, at: r.at, url: r.url, error: r.error, candidates: [], invalid: [] };
  if (!r.ok) return res;
  const { data, problems } = adapterNs.unwrap(r.json);
  if (problems.length) {
    res.error = problems.join(' / ');
    return res;
  }
  const raws = Array.isArray(data) ? data : Array.isArray(data?.signals) ? data.signals : [];
  const items = adapterNs.extractSignals(r.json);
  if (raws.length === 0 || items[0]?.index === -1) {
    res.error = '信号データが空、または読めない形（0 件）';
    return res;
  }
  items.forEach((it, i) => {
    const raw = raws[i] ?? {};
    if (!it.signal) {
      res.invalid.push({ index: i, id: it.id, problems: it.problems });
      return;
    }
    try {
      core.validateSignal(it.signal);
    } catch (e) {
      res.invalid.push({ index: i, id: it.id, problems: [`core が受け付けない: ${e.message}`] });
      return;
    }
    const region = raw.region ?? 'api';
    res.candidates.push({
      key: `${region}:${it.id ?? `#${i}`}`,
      region,
      signalId: it.id ?? `#${i}`,
      lat: it.lat ?? NaN,   // adapter の値（数値でなければ null → NaN にして後段で除外理由を出す）
      lng: it.lon ?? NaN,
      signal: it.signal,
      origin: 'api',
      note: it.note ?? '車両用データ由来・位相は仮の参考信号',
    });
  });
  res.ok = res.candidates.length > 0;
  if (!res.ok) res.error = '使える信号が 0 件（全件が不正）';
  return res;
}

/** GET /api/calibration → { runner } か { error }（校正値は別ボタンで適用する） */
export async function fetchCalibration(base, opts = {}) {
  const r = await getJson(base, '/api/calibration', opts);
  if (!r.ok) return { ok: false, at: r.at, url: r.url, error: r.error };
  const ex = adapterNs.extractRunner(r.json);
  if (!ex.runner) return { ok: false, at: r.at, url: r.url, error: ex.problems.join(' / ') };
  return { ok: true, at: r.at, url: r.url, runner: ex.runner };
}
