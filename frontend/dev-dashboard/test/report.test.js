import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_VERSION } from '../../../core/runwave-core.js';
import { buildReport, reportToMarkdown, reportFileName } from '../src/report.js';
import {
  CHECKLIST_STORAGE_KEY,
  defaultChecklist,
  loadChecklist,
  saveChecklist,
  setNote,
  setStatus,
} from '../src/checklist.js';
import { createPair, advance, describeResult, getFixedScenario, isPairDone, pairSummary, verifyPair } from '../src/sim-engine.js';

function finishedPair(id) {
  let pair = createPair(getFixedScenario(id).config);
  while (!isPairDone(pair)) pair = advance(pair, 50);
  return pair;
}

function reportFor(pair, extra = {}) {
  const summary = pairSummary(pair);
  return buildReport({
    now: new Date('2026-10-17T03:04:05.000Z'),
    env: { userAgent: 'TestAgent/1.0', url: 'http://127.0.0.1:5173/' },
    meta: { gitSha: null, gitBranch: null },
    coreVersion: CORE_VERSION,
    source: { kind: 'fixed', scenarioId: 'A' },
    scenarioId: 'A',
    config: pair.config,
    tick: pair.tick,
    summary,
    description: describeResult(summary),
    verification: verifyPair(pair),
    apiBase: 'http://localhost:3001',
    apiResults: [],
    apiOverall: 'unchecked',
    checklist: defaultChecklist(),
    memo: '手元メモ',
    ...extra,
  });
}

test('report: config 全体・結果・出所・未確認事項が入り、JSON にして戻せる', () => {
  const pair = finishedPair('A');
  const r = reportFor(pair);
  assert.equal(r.versions.coreVersion, CORE_VERSION);
  assert.equal(r.versions.gitSha, null);
  assert.equal(r.scenarioId, 'A');
  assert.deepEqual(r.config, pair.config);
  assert.equal(r.results.normal.stops, 1);
  assert.equal(r.results.runwave.stops, 0);
  assert.match(r.results.timeDifference, /遅い/);
  assert.equal(r.verification.status, 'match');
  assert.equal(r.memo, '手元メモ');
  assert.ok(r.reproduction.length >= 3);
  // 未確認事項
  const un = r.unconfirmed.join('\n');
  assert.match(un, /Mac/);
  assert.match(un, /実機/);
  assert.match(un, /Git SHA が不明/);
  assert.match(un, /未コミット変更/);
  assert.match(un, /API は未確認/);
  assert.match(un, /担当別チェックが未確認/);
  const back = JSON.parse(JSON.stringify(r));
  assert.deepEqual(back, r);
  assert.match(reportFileName(r), /^runwave-check_A_2026-10-17T03-04-05-000Z\.json$/);
});

test('report: Markdown に config・結果・API・チェック・未確認事項の各節が入る', () => {
  const r = reportFor(finishedPair('B'), { scenarioId: 'B', source: { kind: 'fixed', scenarioId: 'B' } });
  const md = reportToMarkdown(r);
  for (const h of ['## 基本情報', '## 結果', '## config 全体', '## API 確認', '## 担当別チェック（手動記録）', '## 再現手順', '## メモ', '## 未確認事項']) {
    assert.ok(md.includes(h), h);
  }
  assert.ok(md.includes('"phaseS": 100'), 'config の中身');
  assert.ok(md.includes('Git SHA: 不明'));
  assert.ok(md.includes('固定シナリオ（B）'));
  assert.ok(md.includes('| 停止回数 | 1 | 0 |'));
  assert.ok(md.includes('照合: **一致**'));
});

test('report: Git SHA・API の結果・API 由来の出所が入る。ゴール前は途中経過・照合待ちと明記する', () => {
  const pair = advance(createPair(getFixedScenario('B').config), 100);
  const summary = pairSummary(pair);
  const r = buildReport({
    env: {},
    meta: { gitSha: 'd8046f8d8046f8d8046f8d8046f8d8046f8d8046', gitBranch: 'main' },
    coreVersion: CORE_VERSION,
    source: { kind: 'api', signalId: 'sapporo_3', fetchedAt: '2026-10-17T03:00:00.000Z', apiBase: 'http://localhost:3001' },
    scenarioId: 'B',
    config: pair.config,
    tick: pair.tick,
    summary,
    description: describeResult(summary),
    verification: verifyPair(pair),
    apiBase: 'http://localhost:3001',
    apiResults: [{ id: 'signals', path: '/api/signals', url: 'http://localhost:3001/api/signals', at: '2026-10-17T03:00:00.000Z', status: 'failure', httpStatus: 200, ms: 5, problems: ['使える信号が 0 件'], warnings: [], summary: '' }],
    apiOverall: 'failure',
    checklist: defaultChecklist(),
  });
  const md = reportToMarkdown(r);
  assert.ok(md.includes('d8046f8d8046f8d8046f8d8046f8d8046f8d8046'));
  assert.ok(md.includes('API（signalId=sapporo_3'));
  assert.ok(md.includes('途中経過（未完了）'));
  assert.ok(md.includes('未ゴール（途中経過）'), '終了欄が timeLimit のままになっていない');
  assert.ok(md.includes('照合待ち'));
  assert.ok(md.includes('使える信号が 0 件'));
  const un = r.unconfirmed.join('\n');
  assert.match(un, /ゴールまで実行していない/);
  assert.match(un, /API 確認に失敗/);
  assert.match(un, /歩行者信号の実測ではない/);
  assert.doesNotMatch(un, /Git SHA が不明/);
});

test('チェックリスト: 初期項目はすべて未確認。メモを付けても状態は自動で変わらない', () => {
  const list = defaultChecklist();
  assert.ok(list.length >= 10);
  assert.ok(list.every((c) => c.status === 'unchecked' && c.note === ''));
  assert.deepEqual([...new Set(list.map((c) => c.owner))], ['安原', 'ふぁん', '蝦名', '陸斗']);
  assert.ok(list.some((c) => /Mac/.test(c.title) && c.status === 'unchecked'));
  assert.ok(list.some((c) => /実機/.test(c.title) && c.status === 'unchecked'));

  const withNote = setNote(list, 'ebina-mac-build', 'ビルドログ貼り付け済み');
  const target = withNote.find((c) => c.id === 'ebina-mac-build');
  assert.equal(target.note, 'ビルドログ貼り付け済み');
  assert.equal(target.status, 'unchecked', 'メモを書いても成功にならない');
  assert.ok(list.every((c) => c.note === ''), '元の配列は変更されない');

  const ok = setStatus(withNote, 'ebina-mac-build', 'success');
  assert.equal(ok.find((c) => c.id === 'ebina-mac-build').status, 'success');
  assert.equal(ok.filter((c) => c.status === 'success').length, 1, '他の項目は変わらない');
  assert.throws(() => setStatus(list, 'ebina-mac-build', 'done'), RangeError);
});

test('チェックリストの保存: localStorage 相当に保存して読み戻せる。壊れた値・使えない storage でも動く', () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  let list = setStatus(defaultChecklist(), 'rikuto-windows', 'checking');
  list = setNote(list, 'rikuto-windows', 'Edge で確認中');
  assert.equal(saveChecklist(storage, list), true);
  const loaded = loadChecklist(storage);
  assert.equal(loaded.find((c) => c.id === 'rikuto-windows').status, 'checking');
  assert.equal(loaded.find((c) => c.id === 'rikuto-windows').note, 'Edge で確認中');
  assert.equal(loaded.find((c) => c.id === 'ebina-device').status, 'unchecked');

  store.set(CHECKLIST_STORAGE_KEY, '{broken');
  assert.deepEqual(loadChecklist(storage), defaultChecklist());
  store.set(CHECKLIST_STORAGE_KEY, JSON.stringify([{ id: 'rikuto-windows', status: 'bogus', note: 5 }]));
  const odd = loadChecklist(storage).find((c) => c.id === 'rikuto-windows');
  assert.equal(odd.status, 'unchecked');
  assert.equal(odd.note, '');

  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadChecklist(broken), defaultChecklist());
  assert.equal(saveChecklist(broken, list), false);
  assert.deepEqual(loadChecklist(undefined), defaultChecklist());
});

test('report: ダッシュボードが知らない集計は「その他の集計」に、契約が崩れているときは未確認事項に入る', () => {
  const pair = finishedPair('A');
  const summary = pairSummary(pair);
  summary.runwave = { ...summary.runwave, energyKcal: 12.5 };
  const r = buildReport({
    config: pair.config, tick: pair.tick, summary, description: describeResult(summary), verification: verifyPair(pair),
    contract: { ok: false, missing: ['step（関数）', 'state.phase'], warnings: [], problems: [] },
  });
  assert.deepEqual(r.results.otherSummary, [{ key: 'energyKcal', normal: '（なし）', runwave: '12.5' }]);
  const md = reportToMarkdown(r);
  assert.ok(md.includes('その他の集計'));
  assert.ok(md.includes('| energyKcal | （なし） | 12.5 |'));
  assert.match(r.unconfirmed.join('\n'), /core の契約が変わっている（不足: step（関数）、state\.phase）/);
  assert.equal(r.coreContract.ok, false);
  // 契約が正常なら、その項目は出ない
  const ok = buildReport({ config: pair.config, summary: pairSummary(pair), contract: { ok: true, missing: [], warnings: [], problems: [] } });
  assert.doesNotMatch(ok.unconfirmed.join('\n'), /契約が変わっている/);
});
