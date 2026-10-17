// バックエンドAPIの結合確認
// 使い方:
//   node tools/api-check.js <BASE_URL>            … GET だけ（データを書き込まない）
//   node tools/api-check.js <BASE_URL> --write    … POST の正常系・異常系も実行（test:true 付きでログが1件増える）
// 結果は画面に表示し、work/api-check/<時刻>.json に保存する。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CORE_VERSION, validateConfig, compare } from '../core/runwave-core.js';
import { extractSignals, extractRunner } from '../core/api-adapter.js';
import { DEMO } from '../core/scenarios.js';

const CONFIG_URL = new URL('./api-check.config.json', import.meta.url);

// 1件のリクエストを送り、ステータス・Content-Type・JSON として読めるかを記録する
async function request(baseUrl, check, timeoutMs) {
  const url = new URL(check.path, baseUrl).toString();
  const init = { method: check.method, headers: {}, signal: AbortSignal.timeout(timeoutMs) };
  if (check.rawBody !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = check.rawBody;
  } else if (check.body !== undefined && !check.noBody) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(check.body);
  }
  const started = Date.now();
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json, jsonError = null;
    try { json = JSON.parse(text); } catch (e) { jsonError = e.message; }
    return {
      url, status: res.status, ms: Date.now() - started,
      contentType: res.headers.get('content-type') || '',
      cors: res.headers.get('access-control-allow-origin'),
      json, jsonError, textHead: jsonError ? text.slice(0, 200) : undefined,
    };
  } catch (e) {
    return { url, error: e.name === 'TimeoutError' ? `タイムアウト（${timeoutMs}ms）` : `${e.name}: ${e.message}`, ms: Date.now() - started };
  }
}

function judge(check, r) {
  const problems = [];
  if (r.error) return [r.error];
  const cls = `${String(r.status)[0]}xx`;
  if (cls !== check.expect) problems.push(`ステータス ${r.status}（期待 ${check.expect}）`);
  if (r.status >= 500) problems.push('サーバーエラー（落ちている可能性）');
  if (!/application\/json/i.test(r.contentType)) problems.push(`Content-Type が JSON でない（${r.contentType || 'なし'}）`);
  if (r.jsonError) problems.push(`本文が JSON として読めない: ${r.jsonError}`);
  // ガイドの形 { ステータス: "成功" | ... }。HTTP は成功でも本文が失敗なら NG
  const st = r.json && typeof r.json === 'object' ? r.json['ステータス'] : undefined;
  if (check.expect === '2xx' && st !== undefined && st !== '成功') problems.push(`本文のステータスが「${st}」`);
  return problems;
}

// API から取った信号・歩幅を core に通して、シミュレーションが最後まで走るか確かめる
function coreIntegration(results) {
  const out = { signals: [], runner: null };
  const sig = results.find((x) => x.use === 'signals' && x.response?.json !== undefined);
  const cal = results.find((x) => x.use === 'runner' && x.response?.json !== undefined);
  const runnerInfo = cal ? extractRunner(cal.response.json) : null;
  out.runner = runnerInfo;
  const runner = runnerInfo?.runner || DEMO.main.runner;
  if (sig) {
    for (const s of extractSignals(sig.response.json)) {
      const item = { index: s.index, id: s.id, note: s.note, problems: [...s.problems] };
      if (s.signal) {
        const config = { ...DEMO.main, signal: s.signal, runner };
        try {
          validateConfig(config);
          item.summary = compare(config); // { normal, runwave }
        } catch (e) {
          item.problems.push(`core が受け付けない: ${e.message}`);
        }
      }
      out.signals.push(item);
    }
  }
  return out;
}

export async function runChecks(baseUrl, { write = false, config = JSON.parse(readFileSync(CONFIG_URL, 'utf8')) } = {}) {
  const results = [];
  for (const check of config.checks) {
    if (check.kind === 'write' && !write) {
      results.push({ id: check.id, skipped: '書き込み（--write で実行）' });
      continue;
    }
    const response = await request(baseUrl, check, config.timeoutMs);
    const problems = judge(check, response);
    // Node からの確認ではブラウザの CORS 制限がかからない。ヘッダーが無ければ注意だけ出す（NG にはしない）
    const warnings = !response.error && !response.cors ? ['CORS ヘッダー無し（ブラウザの画面から呼ぶと失敗する可能性）'] : [];
    results.push({ id: check.id, method: check.method, path: check.path, expect: check.expect, use: check.use, ok: problems.length === 0, problems, warnings, response });
  }
  return { baseUrl, write, coreVersion: CORE_VERSION, at: new Date().toISOString(), results, core: coreIntegration(results) };
}

function printReport(rep) {
  console.log(`API確認: ${rep.baseUrl}（書き込み: ${rep.write ? 'あり' : 'なし'}）`);
  for (const r of rep.results) {
    if (r.skipped) { console.log(`  -  ${r.id}: スキップ（${r.skipped}）`); continue; }
    const st = r.response.error ? '---' : r.response.status;
    console.log(`  ${r.ok ? 'OK' : 'NG'} ${r.id}: ${r.method} ${r.path} → ${st}（${r.response.ms}ms）${r.problems.length ? ' / ' + r.problems.join(' / ') : ''}${r.warnings.length ? ' ⚠ ' + r.warnings.join(' / ') : ''}`);
  }
  const c = rep.core;
  if (c.runner) console.log(`  歩幅・BPM: ${c.runner.runner ? JSON.stringify(c.runner.runner) : 'NG / ' + c.runner.problems.join(' / ')}`);
  console.log(`  信号プリセット: ${c.signals.length}件`);
  for (const s of c.signals) {
    console.log(`    [${s.index}] ${s.id ?? ''} ${s.problems.length ? 'NG / ' + s.problems.join(' / ') : `OK（通常 ${s.summary.normal.stops}回停止・${s.summary.normal.totalTimeS}s ／ RUNWAVE ${s.summary.runwave.stops}回停止・${s.summary.runwave.totalTimeS}s）`}`);
  }
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [baseUrl] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!baseUrl) {
    console.error('使い方: node tools/api-check.js <BASE_URL> [--write]');
    process.exit(2);
  }
  const rep = await runChecks(baseUrl, { write: process.argv.includes('--write') });
  printReport(rep);
  const dir = new URL('../work/api-check/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`${rep.at.replace(/[:.]/g, '-')}.json`, dir);
  writeFileSync(file, JSON.stringify(rep, null, 2));
  console.log(`保存: ${fileURLToPath(file)}`);
  process.exit(rep.results.every((r) => r.skipped || r.ok) ? 0 : 1);
}
