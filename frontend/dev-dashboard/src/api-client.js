// API 接続確認（GET のみ・手動実行・DOM 非依存）。fetch は引数で差し替えられる（テストでは実サーバーを使う）。
// 変換と形式検証は core/api-adapter.js の関数を再利用する。tools/api-check.js の judge の考え方を移植したが、
// CLI のコード（node:fs などを読む）はブラウザに持ち込まない。
// POST は実装しない（設定・ログを書き込まない）。
import { validateConfig, validateSignal } from '../../../core/runwave-core.js';
import { extractSignals, extractRunner, unwrap } from '../../../core/api-adapter.js';

export const DEFAULT_API_BASE = 'http://localhost:3001';
export const DEFAULT_TIMEOUT_MS = 5000;

export const ENDPOINTS = [
  { id: 'signals', path: '/api/signals', label: '信号一覧' },
  { id: 'calibration', path: '/api/calibration', label: 'キャリブレーション（歩幅・通常BPM）' },
  { id: 'logs', path: '/api/logs', label: '走行ログ一覧' },
];

export const STATUS_LABELS = { unchecked: '未確認', success: '成功', failure: '失敗' };

/** base と path を連結する。base が URL として読めなければ例外 */
export function buildUrl(base, path) {
  const b = String(base ?? '').trim();
  if (!/^https?:\/\//i.test(b)) throw new TypeError(`API の URL は http:// か https:// で始めてください（入力: "${b}"）`);
  return new URL(path, b.endsWith('/') ? b : `${b}/`).toString();
}

/** 形式の検証。{ problems, warnings, data, summary } を返す。problems が 1 つでもあれば失敗扱い */
function validateBody(endpointId, json) {
  const problems = [];
  const warnings = [];
  let data = null;
  let summary = '';

  if (endpointId === 'signals') {
    const items = extractSignals(json);
    const list = [];
    for (const it of items) {
      const itemProblems = [...it.problems];
      if (it.signal) {
        try {
          validateSignal(it.signal); // core が受け付けない値（負の周期など）
        } catch (e) {
          itemProblems.push(`core が受け付けない: ${e.message}`);
        }
      }
      list.push({ index: it.index, id: it.id, note: it.note, signal: itemProblems.length ? null : it.signal, problems: itemProblems });
    }
    const valid = list.filter((x) => x.signal);
    const invalid = list.filter((x) => !x.signal);
    if (valid.length === 0) {
      if (list.length === 1 && list[0].index === -1) problems.push(...list[0].problems.filter(notStatusProblem));
      else problems.push('使える信号が 0 件（全件が不正）', ...invalid.map(labelProblems));
    } else {
      for (const x of invalid) warnings.push(labelProblems(x));
    }
    data = { signals: list };
    summary = `信号 ${valid.length} 件が使える${invalid.length ? `（不正 ${invalid.length} 件）` : ''}`;
  } else if (endpointId === 'calibration') {
    const r = extractRunner(json);
    if (!r.runner) problems.push(...r.problems.filter(notStatusProblem));
    data = { runner: r.runner };
    summary = r.runner ? `歩幅 ${r.runner.strideM} m・通常 ${r.runner.baseBpm} 歩/分` : '';
  } else if (endpointId === 'logs') {
    const u = unwrap(json);
    if (!Array.isArray(u.data)) problems.push('データが配列ではない');
    else summary = `ログ ${u.data.length} 件`;
    data = { count: Array.isArray(u.data) ? u.data.length : null };
  }
  return { problems, warnings, data, summary };
}

// 「ステータスが…」は checkEndpoint 側で「本文のステータスが…」として 1 回だけ出す
const notStatusProblem = (p) => !/^ステータスが/.test(p);
const labelProblems = (x) => `${x.id ?? `#${x.index}`}: ${x.problems.join(' / ')}`;

/**
 * 1 エンドポイントを GET して判定する。必ず結果オブジェクトを返し、例外は投げない。
 * status: 'success' | 'failure'（未確認は呼ぶ前の状態）
 */
export async function checkEndpoint(base, endpoint, { fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = DEFAULT_TIMEOUT_MS, now = () => new Date() } = {}) {
  const result = {
    id: endpoint.id,
    label: endpoint.label ?? endpoint.id,
    path: endpoint.path,
    url: null,
    at: now().toISOString(),
    status: 'failure',
    httpStatus: null,
    ms: null,
    contentType: null,
    problems: [],
    warnings: [],
    summary: '',
    data: null,
  };
  let url;
  try {
    url = buildUrl(base, endpoint.path);
  } catch (e) {
    result.problems.push(e.message);
    return result;
  }
  result.url = url;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const started = Date.now();
  let text;
  try {
    const res = await fetchImpl(url, { method: 'GET', cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal });
    result.httpStatus = res.status;
    result.contentType = res.headers.get('content-type') || '';
    text = await res.text(); // 本文の読み取りも同じタイムアウトで打ち切る
  } catch (e) {
    result.ms = Date.now() - started;
    result.problems.push(
      timedOut
        ? `タイムアウト（${timeoutMs}ms 以内に応答なし）`
        : `接続できません（サーバー停止・URL・ポート違い、またはブラウザの CORS 拒否の可能性）: ${e.name}: ${e.message}`,
    );
    return result;
  } finally {
    clearTimeout(timer);
  }
  result.ms = Date.now() - started;

  if (result.httpStatus < 200 || result.httpStatus >= 300) result.problems.push(`HTTP ${result.httpStatus}（2xx ではない）`);
  if (!/application\/json/i.test(result.contentType)) result.problems.push(`Content-Type が JSON ではない（${result.contentType || 'なし'}）`);
  let json;
  let parsed = false;
  try {
    json = JSON.parse(text);
    parsed = true;
  } catch (e) {
    result.problems.push(`本文が JSON として読めない: ${e.message}（先頭: ${JSON.stringify(text.slice(0, 80))}）`);
  }
  const is2xx = result.httpStatus >= 200 && result.httpStatus < 300;
  if (parsed) {
    const st = json && typeof json === 'object' && !Array.isArray(json) ? json['ステータス'] : undefined;
    if (st !== undefined && st !== '成功') result.problems.push(`本文のステータスが「${st}」`);
    if (is2xx && st === undefined) {
      result.warnings.push('本文に ステータス がない（API 連携ガイドの形ではない）');
    }
    // HTTP が 2xx でも形式検証は必ず行う（空信号・不正値を「利用可能」にしないため）。2xx 以外は理由が明らかなので省く
    if (is2xx) {
      const v = validateBody(endpoint.id, json);
      result.problems.push(...v.problems);
      result.warnings.push(...v.warnings);
      result.data = v.data;
      result.summary = v.summary;
    }
  }
  result.status = result.problems.length === 0 ? 'success' : 'failure';
  return result;
}

/** 3 本を同時に確認する（常時ポーリングはしない。ボタンを押したときだけ呼ぶ）。結果は ENDPOINTS の順 */
export async function checkAll(base, opts = {}) {
  return Promise.all(ENDPOINTS.map((ep) => checkEndpoint(base, ep, opts)));
}

/** 3 本のまとめ: 未確認（まだ実行していない）／成功（3 本とも成功）／失敗（1 本でも失敗） */
export function overallStatus(results) {
  if (!results || results.length === 0) return 'unchecked';
  if (results.some((r) => r.status === 'failure')) return 'failure';
  return results.length === ENDPOINTS.length && results.every((r) => r.status === 'success') ? 'success' : 'unchecked';
}

/**
 * API の信号 1 件を比較条件に適用する。API の crossingM は「横断幅」なので signal.crossingM に入れる。
 * route.crossingX（スタートから横断地点まで）・runner・control は変えない。
 * 戻り値 { config } か { error }（core の検証に通らない場合）
 */
export function applyApiSignal(config, signal) {
  const next = { ...config, signal: { ...config.signal, ...signal } };
  try {
    validateConfig(next);
  } catch (e) {
    return { error: `この信号は現在の条件では使えません: ${e.message}` };
  }
  return { config: next };
}
