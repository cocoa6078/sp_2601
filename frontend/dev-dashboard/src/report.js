// 共有用レポート（JSON / Markdown）。DOM 非依存。
// 確認日時・環境・core バージョン・Git SHA・シナリオ ID・config 全体・データの出所・通常/RUNWAVE の結果・
// API 確認結果・再現手順・メモ・未確認事項を 1 つにまとめる。
import { CHECK_STATUS_LABELS } from './checklist.js';
import { STATUS_LABELS } from './api-client.js';
import { extraSummaryRows } from './core-compat.js';

const MAX_TIME_S = 1800; // core.simulate の既定 maxTimeS
export const REPORT_SCHEMA = 'runwave-dev-dashboard-report/1';

const MODEL_LABEL = { point: 'point（横断地点での信号判定）', length: 'length（横断幅も考慮）' };

function pad(n) {
  return String(n).padStart(2, '0');
}
export function localTimeString(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 手順（再現用） */
export function reproductionSteps({ source, scenarioId, apiBase }) {
  const steps = [
    'リポジトリの frontend/dev-dashboard で `npm.cmd install` → `npm.cmd run dev` を実行し、ブラウザで http://127.0.0.1:5173 を開く',
  ];
  if (source?.kind === 'api') {
    steps.push(
      `backend を別ターミナルで起動する（既定ポート 3001）。画面の「API 確認」で URL を ${source.apiBase ?? apiBase ?? '（不明）'} にして「API を確認」を押す`,
      `信号一覧から ${source.signalId ?? '（不明）'} を選び「比較条件へ適用」を押す（route.crossingX・runner・control は固定シナリオ側の値のまま）`,
    );
  } else {
    steps.push(`固定シナリオ「${scenarioId ?? '（不明）'}」を選び、「適用してリセット」を押す（バックエンドは不要）`);
  }
  steps.push('表示速度を選んで「開始」を押し、両レーンがゴールするまで待つ（または「1 ステップ」で 0.1 秒ずつ進める）', 'この「結果共有」欄から Markdown / JSON を出力する');
  return steps;
}

/** 本画面では確認できないこと・まだ確認していないこと（自動で入れる） */
export function unconfirmedItems({ meta, summary, verification, apiOverall, checklist, source, contract }) {
  const out = [
    'Mac での Xcode ビルド、SwiftUI の表示・動作、Watch 連携、実機動作は本画面では確認できない（Web での再現であり、SwiftUI の互換性確認ではない）',
    '数値は架空信号・固定歩幅によるシミュレーションの推定値。実信号、HealthKit、WatchConnectivity、心拍による制御は今回の対象外',
  ];
  if (contract && !contract.ok) out.push(`core の契約が変わっている（不足: ${contract.missing.join('、')}）。dashboard の更新が必要で、この結果は一部の機能が無効な状態のもの`);
  if (!meta?.gitSha) out.push('Git SHA が不明（取得できなかった）');
  out.push('未コミット変更の有無は記録していない（SHA だけで完全に再現できるとは限らない）');
  if (!summary || !summary.normal.finished || !summary.runwave.finished) out.push('両レーンのゴールまで実行していない（結果は途中経過）');
  if (!verification || verification.status === 'pending') out.push('逐次 step と core.compare の照合は未実施（ゴール後に実施される）');
  else if (verification.status === 'mismatch') out.push('逐次 step と core.compare の照合で不一致あり（core または画面の不具合の可能性。担当へ共有）');
  if (apiOverall === 'unchecked') out.push('API は未確認（固定シナリオのみで確認）');
  else if (apiOverall === 'failure') out.push('API 確認に失敗した項目がある（成功として扱わない）');
  if (source?.kind === 'api') out.push('API の信号はバックエンド側の参考プリセット（JARTIC 車両用データ流用など）で、歩行者信号の実測ではない');
  const unchecked = (checklist ?? []).filter((c) => c.status === 'unchecked');
  if (unchecked.length) out.push(`担当別チェックが未確認: ${unchecked.map((c) => `${c.owner}「${c.title}」`).join('、')}`);
  return out;
}

const apiEntry = (r) => ({
  id: r.id,
  path: r.path,
  url: r.url,
  checkedAt: r.at,
  status: r.status,
  httpStatus: r.httpStatus,
  ms: r.ms,
  contentType: r.contentType,
  summary: r.summary,
  problems: r.problems,
  warnings: r.warnings,
});

/**
 * レポート本体（JSON にそのまま書き出せる形）
 * 引数: { now: Date, env, meta, coreVersion, source, scenarioId, config, tick, summary, description, verification,
 *        apiBase, apiResults, apiOverall, checklist, memo }
 */
export function buildReport(input) {
  const { now = new Date(), env = {}, meta = {}, coreVersion, source, scenarioId, config, tick = 0, summary = null, description = null, verification = null, apiBase = null, apiResults = [], apiOverall = 'unchecked', checklist = [], memo = '', contract = null } = input;
  const done = !!summary && summary.normal.finished && summary.runwave.finished;
  return {
    schema: REPORT_SCHEMA,
    checkedAt: now.toISOString(),
    checkedAtLocal: localTimeString(now),
    environment: { userAgent: env.userAgent ?? '不明', url: env.url ?? '不明' },
    versions: {
      coreVersion: coreVersion ?? '不明',
      gitSha: meta.gitSha ?? null,
      gitBranch: meta.gitBranch ?? null,
      gitNote: '未コミット変更の有無は記録していない。SHA だけで完全に再現できるとは限らない',
    },
    scenarioId: scenarioId ?? null,
    dataSource: source ?? { kind: 'unknown' },
    config,
    configNote: '2 レーンの違いは control.enabled だけ（通常=false / RUNWAVE=true）。ここに示す config は enabled を除いた共通部分',
    simulation: { elapsedS: tick / 10, finished: done, note: '架空信号・固定歩幅によるシミュレーション（モデル上の推定値）。BPM は歩/分（心拍数ではない）' },
    results: summary
      ? {
          normal: summary.normal,
          runwave: summary.runwave,
          stopAvoidance: description?.stopLine ?? null,
          timeDifference: description?.timeLine ?? null,
          timeDifferenceS: description?.timeDiffS ?? null,
          otherSummary: extraSummaryRows(summary), // ダッシュボードが意味を知らない集計（core に増えたもの）
        }
      : null,
    verification: verification
      ? {
          status: verification.status,
          statusLabel: { pending: '照合待ち', match: '一致', mismatch: '不一致' }[verification.status] ?? verification.status,
          mismatches: (verification.items ?? []).filter((i) => !i.ok),
        }
      : { status: 'pending', statusLabel: '照合待ち', mismatches: [] },
    api: {
      base: apiBase,
      overall: apiOverall,
      overallLabel: STATUS_LABELS[apiOverall] ?? apiOverall,
      results: apiResults.map(apiEntry),
    },
    manualChecklist: {
      note: '手動記録（このブラウザの localStorage にだけ保存）。自動検査の結果とは別',
      items: checklist.map(({ owner, id, title, status, note }) => ({ owner, id, title, status, statusLabel: CHECK_STATUS_LABELS[status], note })),
    },
    reproduction: reproductionSteps({ source, scenarioId, apiBase }),
    memo: memo ?? '',
    coreContract: contract ? { ok: contract.ok, missing: contract.missing, warnings: contract.warnings, problems: contract.problems } : null,
    unconfirmed: unconfirmedItems({ meta, summary, verification, apiOverall, checklist, source, contract }),
  };
}

const cell = (v) => String(v ?? '-').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const num = (v, d = 1) => (typeof v === 'number' ? (Math.round(v * 10 ** d) / 10 ** d).toFixed(d) : '-');

/** 貼り付け用の Markdown */
export function reportToMarkdown(r) {
  const L = [];
  L.push('# RUNWAVE 動作確認レポート', '');
  L.push('> 架空信号・固定歩幅によるシミュレーション（モデル上の推定値）。BPM は歩/分（心拍数ではない）。', '');
  L.push('## 基本情報', '');
  L.push(`- 確認日時: ${r.checkedAtLocal}（${r.checkedAt}）`);
  L.push(`- 環境: ${r.environment.userAgent}`);
  L.push(`- 画面 URL: ${r.environment.url}`);
  L.push(`- core バージョン: ${r.versions.coreVersion}`);
  L.push(`- Git SHA: ${r.versions.gitSha ?? '不明'}${r.versions.gitBranch ? `（ブランチ ${r.versions.gitBranch}）` : ''}`);
  L.push(`- ${r.versions.gitNote}`);
  L.push(`- シナリオ ID: ${r.scenarioId ?? '不明'}`);
  const ds = r.dataSource;
  L.push(`- データの出所: ${ds.kind === 'api' ? `API（signalId=${ds.signalId ?? '不明'}、取得 ${ds.fetchedAt ?? '不明'}、${ds.apiBase ?? '不明'}）` : ds.kind === 'fixed' ? `固定シナリオ（${ds.scenarioId ?? r.scenarioId}）` : '不明'}${ds.edited ? '。ただしフォームで値を編集済み（config 全体を参照）' : ''}`);
  L.push('');
  L.push('## 結果', '');
  if (r.results) {
    L.push(`経過 ${num(r.simulation.elapsedS)} 秒 / ${r.simulation.finished ? '両レーンゴール済み' : '途中経過（未完了）'}`, '');
    L.push('| 項目 | 通常走行 | RUNWAVE |', '|---|---|---|');
    const rows = [
      ['停止回数', 'stops', 0],
      ['停止時間（秒）', 'stopTimeS', 1],
      ['所要時間（秒）', 'totalTimeS', 1],
      ['最小BPM（歩/分）', 'minBpm', 0],
      ['最大BPM（歩/分）', 'maxBpm', 0],
      ['BPM変更量の累計', 'totalBpmChange', 0],
      ['終了', 'termination', null],
    ];
    const endLabel = (s) => (s.finished ? 'ゴール' : r.simulation.elapsedS >= MAX_TIME_S ? '時間切れ（到達不能とは断定しない）' : '未ゴール（途中経過）');
    for (const [name, key, d] of rows) {
      const a = r.results.normal[key];
      const b = r.results.runwave[key];
      const [ca, cb] = d === null ? [endLabel(r.results.normal), endLabel(r.results.runwave)] : [num(a, d), num(b, d)];
      L.push(`| ${name} | ${ca} | ${cb} |`);
    }
    L.push('');
    if (r.results.otherSummary?.length) {
      L.push('その他の集計（ダッシュボードが意味を知らない項目。core に追加されたもの）', '', '| 項目 | 通常走行 | RUNWAVE |', '|---|---|---|');
      for (const e of r.results.otherSummary) L.push(`| ${cell(e.key)} | ${cell(e.normal)} | ${cell(e.runwave)} |`);
      L.push('');
    }
    if (r.results.stopAvoidance) L.push(`- ${r.results.stopAvoidance}`);
    if (r.results.timeDifference) L.push(`- ${r.results.timeDifference}`);
    L.push('');
  } else {
    L.push('結果なし（未実行）', '');
  }
  L.push(`逐次 step と core.compare の照合: **${r.verification.statusLabel}**`);
  for (const m of r.verification.mismatches) L.push(`- 不一致: ${m.lane} の ${m.key}（逐次 ${m.sequential} / compare ${m.reference}）`);
  L.push('');
  L.push('## config 全体', '', r.configNote, '', '```json', JSON.stringify(r.config, null, 2), '```', '');
  L.push('## API 確認', '');
  L.push(`- URL: ${r.api.base ?? '未設定'} / まとめ: **${r.api.overallLabel}**`);
  if (r.api.results.length) {
    L.push('', '| エンドポイント | 取得時刻 | HTTP | 状態 | 内容 / 理由 |', '|---|---|---|---|---|');
    for (const a of r.api.results) {
      const detail = [a.summary, ...a.problems, ...a.warnings.map((w) => `注意: ${w}`)].filter(Boolean).join(' / ');
      L.push(`| ${cell(a.path)} | ${cell(a.checkedAt)} | ${cell(a.httpStatus ?? '-')} | ${STATUS_LABELS[a.status] ?? a.status} | ${cell(detail)} |`);
    }
  } else {
    L.push('- 未確認（「API を確認」を押していない）');
  }
  L.push('');
  L.push('## 担当別チェック（手動記録）', '', `> ${r.manualChecklist.note}`, '', '| 担当 | 項目 | 状態 | 証拠・メモ |', '|---|---|---|---|');
  for (const c of r.manualChecklist.items) L.push(`| ${c.owner} | ${cell(c.title)} | ${c.statusLabel} | ${cell(c.note || '')} |`);
  L.push('');
  L.push('## 再現手順', '');
  r.reproduction.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push('');
  L.push('## メモ', '', r.memo ? r.memo : '（なし）', '');
  L.push('## 未確認事項', '');
  for (const u of r.unconfirmed) L.push(`- ${u}`);
  L.push('');
  return L.join('\n');
}

export function reportFileName(r) {
  const stamp = r.checkedAt.replace(/[:.]/g, '-');
  return `runwave-check_${(r.scenarioId ?? 'unknown').replace(/[^\w-]/g, '_')}_${stamp}.json`;
}
