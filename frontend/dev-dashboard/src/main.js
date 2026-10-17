// 画面の組み立てとイベント。計算は sim-engine / core、通信は api-client、共有は report、手動記録は checklist に任せる。
import { core, scenariosNs, adapterNs } from './core-ns.js';
import {
  checkCoreContract,
  describeExports,
  extraSummaryRows,
  stateRows,
} from './core-compat.js';
import {
  DEFAULT_SCENARIO_ID,
  FIXED_SCENARIOS,
  SCENARIO_PROBLEMS,
  SPEEDS,
  advance,
  createPair,
  describeResult,
  expectedFor,
  getFixedScenario,
  isPairDone,
  laneView,
  modeLabel,
  pairSummary,
  planTicks,
  verifyPair,
} from './sim-engine.js';
import { FIELDS, MODEL_HELP, configToForm, extraConfigEntries, formsEqual, parseForm } from './config-form.js';
import {
  DEFAULT_API_BASE,
  DEFAULT_TIMEOUT_MS,
  ENDPOINTS,
  STATUS_LABELS,
  applyApiSignal,
  checkAll,
  overallStatus,
} from './api-client.js';
import { SENSOR_FIELDS, buildPreviewModel, sensorText } from './device-preview.js';
import { buildReport, reportFileName, reportToMarkdown } from './report.js';
import {
  CHECK_STATUSES,
  CHECK_STATUS_LABELS,
  checklistCounts,
  loadChecklist,
  saveChecklist,
  setNote,
  setStatus,
} from './checklist.js';
import './styles.css';

/* ---------- core の契約チェック（起動時に 1 回） ---------- */
const CORE_VERSION = core.CORE_VERSION ?? '不明';
let contract;
try {
  contract = checkCoreContract(core, { adapter: adapterNs, scenarios: scenariosNs, probeConfig: FIXED_SCENARIOS[0]?.config });
} catch (e) {
  contract = { ok: false, features: { sim: false, form: false, preview: false, api: false, scenarios: false }, missing: [`契約チェック自体が例外: ${e.message}`], warnings: [], problems: [] };
}
const F = contract.features; // 機能ごとの有効/無効（false の機能だけ止める）

/* ---------- 小さな補助 ---------- */
const META = typeof __RUNWAVE_META__ !== 'undefined' ? __RUNWAVE_META__ : { gitSha: null, gitBranch: null, builtAt: null };
const API_BASE_ENV = import.meta.env.VITE_RUNWAVE_API_BASE;
const LS_API_BASE = 'runwave-dev-dashboard:apiBase';
const LS_API_TIMEOUT = 'runwave-dev-dashboard:apiTimeoutMs';
const LS_MEMO = 'runwave-dev-dashboard:memo';

function lsGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { window.localStorage.setItem(key, value); return true; } catch { return false; }
}
const storage = (() => {
  try { return window.localStorage; } catch { return null; }
})();

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
/** replaceChildren の null / false 除外版（null が文字列 "null" として出ないように） */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const f1 = (v) => (v == null ? '-' : (Math.round(v * 10) / 10).toFixed(1));
const f0 = (v) => (v == null ? '-' : String(Math.round(v)));
const badge = (status, label) => h('span', { class: `badge ${status}`, text: label ?? STATUS_LABELS[status] ?? status });
const timeOnly = (iso) => (iso ? new Date(iso).toLocaleTimeString('ja-JP') : '未実施');

/* ---------- 状態 ---------- */
const app = {
  source: { kind: 'fixed', scenarioId: DEFAULT_SCENARIO_ID },
  baseKey: '',
  config: null,
  form: {},
  formErrors: [],
  pair: null,
  running: false,
  speed: 1,
  carry: 0,
  lastTs: null,
  rafId: 0,
  runError: null,
  verification: { status: 'pending', items: [] },
  completedAt: null,
  api: {
    base: API_BASE_ENV || lsGet(LS_API_BASE) || DEFAULT_API_BASE,
    timeoutMs: Number(lsGet(LS_API_TIMEOUT)) || DEFAULT_TIMEOUT_MS,
    results: [],
    checking: false,
    selected: null,
    applyMessage: null,
    checkedAt: null,
    resultsBase: null, // 結果を取得したときの URL（入力欄を後で変えても、結果と一緒に記録する）
  },
  previewLane: 'runwave',
  sensors: Object.fromEntries(SENSOR_FIELDS.map((f) => [f.id, { text: '', missing: false }])),
  checklist: loadChecklist(storage),
  memo: lsGet(LS_MEMO) ?? '',
  expectedReady: {},
};

const configKey = (config) => JSON.stringify(configToForm(config));
const isDirty = () => !!app.config && !formsEqual(app.form, configToForm(app.config));
const isDone = () => !!app.pair && isPairDone(app.pair);
const isEdited = () => !!app.config && configKey(app.config) !== app.baseKey;
const scenarioLabel = () => (app.source.kind === 'api' ? `API:${app.source.signalId}` : app.source.scenarioId);

/* ---------- 設定の適用・リセット ---------- */
function stopLoop() {
  app.running = false;
  if (app.rafId) cancelAnimationFrame(app.rafId);
  app.rafId = 0;
}

/** config から比較ペアを作り直す。作れなければ例外（呼び出し側で表示する） */
function resetRun(config = app.config) {
  const pair = createPair(config);
  stopLoop();
  app.pair = pair;
  app.carry = 0;
  app.lastTs = null;
  app.runError = null;
  app.verification = { status: 'pending', items: [] };
  app.completedAt = null;
}

/** 設定を丸ごと差し替えて両レーンをリセットする（シナリオ選択・API 適用・フォーム適用のすべてがここを通る） */
function setConfig(config, source, { keepBase = false } = {}) {
  try {
    resetRun(config);
  } catch (e) {
    // 作れなかったときは設定を差し替えない（直前の状態のまま、理由だけ表示する）
    app.runError = `比較を作れませんでした: ${e.message}`;
    renderAll();
    return;
  }
  app.config = config;
  if (source) app.source = source;
  if (!keepBase) app.baseKey = configKey(config);
  app.form = configToForm(config);
  app.formErrors = [];
  renderAll();
}

function loadScenario(id) {
  const sc = getFixedScenario(id);
  if (!sc || !F.sim) return;
  setConfig(sc.config, { kind: 'fixed', scenarioId: id });
}

/* ---------- 実行ループ（描画は requestAnimationFrame、計算は 0.1 秒 tick） ---------- */
function frame(ts) {
  if (!app.running) return;
  const elapsed = app.lastTs == null ? 0 : ts - app.lastTs;
  app.lastTs = ts;
  try {
    const plan = planTicks({ carry: app.carry, elapsedMs: elapsed, speed: app.speed });
    app.carry = plan.carry;
    if (plan.n > 0) app.pair = advance(app.pair, plan.n);
  } catch (e) {
    stopLoop();
    app.runError = `計算中にエラーが起きました: ${e.message}`;
    renderAll();
    return;
  }
  renderSim();
  if (isDone()) {
    onDone();
    return;
  }
  app.rafId = requestAnimationFrame(frame);
}

function startLoop() {
  if (app.running || isDone() || !canRun()) return;
  app.running = true;
  app.lastTs = null; // 一時停止していた時間は数えない
  app.rafId = requestAnimationFrame(frame);
  renderControls();
}

function pauseLoop() {
  stopLoop();
  renderControls();
}

function stepOnce() {
  if (app.running || isDone() || !canRun()) return;
  try {
    app.pair = advance(app.pair, 1);
  } catch (e) {
    app.runError = `計算中にエラーが起きました: ${e.message}`;
  }
  renderSim();
  renderControls();
  if (isDone()) onDone();
}

function onDone() {
  stopLoop();
  app.completedAt = new Date().toISOString();
  app.verification = { status: 'checking', items: [] };
  renderAll();
  const target = app.pair;
  // core.compare の再計算は重いことがある（B-length は約 1 秒）ので、描画の後に行う
  setTimeout(() => {
    if (app.pair !== target) return; // その間にリセットされた
    app.verification = verifyPair(target);
    renderAll();
  }, 30);
}

function canRun() {
  return F.sim && !!app.pair && app.formErrors.length === 0 && !isDirty() && !app.runError;
}

/* ---------- 描画: 上部の状態 ---------- */
function renderStatus() {
  const chip = (k, v) => h('span', { class: 'chip' }, h('span', { class: 'k', text: k }), h('b', { text: v }));
  const runState = !app.pair ? '利用不可' : isDone() ? '完了' : app.running ? '実行中' : app.pair.tick > 0 ? '一時停止' : '未開始';
  const verif = app.verification.status === 'checking' ? '照合中…' : { pending: '照合待ち', match: '一致', mismatch: '不一致' }[app.verification.status];
  const apiOverall = overallStatus(app.api.results);
  const src = app.source.kind === 'api' ? `API（${app.source.signalId}）` : '固定値';
  $('status').replaceChildren(
    chip('シナリオ', `${scenarioLabel()}${isEdited() ? '（編集済み）' : ''}`),
    chip('データの出所', src),
    chip('core', CORE_VERSION === '不明' ? 'バージョン不明' : `v${CORE_VERSION}`),
    chip('Git', META.gitSha ? `${META.gitSha.slice(0, 7)}${META.gitBranch ? ` (${META.gitBranch})` : ''}` : '不明'),
    chip('比較', runState),
    chip('逐次=compare 照合', verif),
    chip('比較の完了時刻', app.completedAt ? timeOnly(app.completedAt) : '未実施'),
    chip('API', `${STATUS_LABELS[apiOverall]}${app.api.checkedAt ? `（${timeOnly(app.api.checkedAt)}）` : ''}`),
  );
}

/* ---------- 描画: シナリオ選択と期待値 ---------- */
function buildScenarioPicker() {
  const box = $('scenario-picker');
  box.replaceChildren(
    ...FIXED_SCENARIOS.map((sc) =>
      h('button', { type: 'button', 'data-id': sc.id, title: sc.expectNote, onclick: () => loadScenario(sc.id) }, sc.title),
    ),
  );
}

function renderScenarioPicker() {
  for (const b of $('scenario-picker').querySelectorAll('button[data-id]')) {
    b.setAttribute('aria-pressed', String(app.source.kind === 'fixed' && app.source.scenarioId === b.dataset.id));
    b.disabled = app.running || !F.sim || !F.scenarios;
  }
}

function renderExpected() {
  const rows = FIXED_SCENARIOS.map((sc) => {
    const done = app.expectedReady[sc.id];
    if (!done) return h('tr', null, h('td', { text: sc.title }), h('td', { colspan: 3, text: '計算中…' }), h('td', { text: sc.expectNote }));
    let e;
    let d;
    try {
      e = expectedFor(sc.id);
      d = describeResult(e);
    } catch (err) {
      return h('tr', null, h('td', { text: sc.title }), h('td', { colspan: 3, text: `計算できません: ${err.message}` }), h('td', { text: sc.expectNote }));
    }
    const cell = (x) => `${x.stops} 回 / ${f1(x.stopTimeS)} 秒 / ${f1(x.totalTimeS)} 秒`;
    return h('tr', null, h('td', { text: sc.title }), h('td', { text: cell(e.normal) }), h('td', { text: cell(e.runwave) }), h('td', { text: `${d.stopLine}／${d.timeLine}` }), h('td', null, sc.expectNote, sc.known ? null : h('span', { class: 'badge warn', text: '新規' })));
  });
  fill($('expected'),
    FIXED_SCENARIOS.length === 0 ? h('div', { class: 'msg error', text: '使えるシナリオがありません（core/scenarios.js の SCENARIOS を確認してください）。' }) : null,
    h('h3', { text: 'core.compare による期待値（画面表示時に core を実行して算出。値は画面に固定で書いていません）' }),
    h('div', { class: 'table-scroll' },
      h('table', null,
        h('thead', null, h('tr', null, ['シナリオ', '通常 停止回数/停止時間/所要時間', 'RUNWAVE 停止回数/停止時間/所要時間', '読み方', '想定'].map((t) => h('th', { text: t })))),
        h('tbody', null, rows),
      ),
    ),
  );
}

function scheduleExpected() {
  const queue = FIXED_SCENARIOS.map((s) => s.id);
  const next = () => {
    const id = queue.shift();
    if (!id) return;
    try { expectedFor(id); } catch { /* 表示は「計算中」のまま */ }
    app.expectedReady[id] = true;
    renderExpected();
    setTimeout(next, 0);
  };
  setTimeout(next, 50);
}

/* ---------- 描画: シミュレーター ---------- */
let simControls = null;
function onReset() {
  if (!F.sim || !app.config) return;
  try {
    resetRun();
  } catch (e) {
    app.runError = `比較を作れませんでした: ${e.message}`;
  }
  renderAll();
}
function buildSimControls() {
  const startBtn = h('button', { type: 'button', class: 'primary', onclick: () => (app.running ? pauseLoop() : startLoop()) }, '開始');
  const stepBtn = h('button', { type: 'button', onclick: stepOnce }, '1 ステップ（0.1 秒）');
  const resetBtn = h('button', { type: 'button', onclick: onReset }, 'リセット');
  const speed = h('select', { id: 'speed', 'aria-label': '表示速度', onchange: (e) => { app.speed = Number(e.target.value); } },
    SPEEDS.map((s) => h('option', { value: String(s), text: `${s} 倍` })));
  speed.value = String(app.speed);
  simControls = { startBtn, stepBtn, resetBtn, speed };
  $('sim-controls').replaceChildren(
    startBtn, stepBtn, resetBtn,
    h('label', null, '表示速度', speed),
    h('span', { class: 'hint', text: '表示速度は「何 tick 進めるか」だけを変えます。計算の刻み（dt）は常に 0.1 秒で、結果は変わりません。' }),
  );
}

function renderControls() {
  const { startBtn, stepBtn, resetBtn, speed } = simControls;
  const done = isDone();
  const off = !F.sim || !app.pair;
  startBtn.textContent = app.running ? '一時停止' : app.pair?.tick > 0 && !done ? '再開' : '開始';
  startBtn.disabled = off || done || (!app.running && !canRun());
  startBtn.title = off ? 'core の契約が変わったため、比較シミュレーターは使えません' : done ? 'ゴール済みです。リセットで最初から実行できます' : !canRun() ? '設定にエラーまたは未適用の変更があります' : '';
  stepBtn.disabled = off || app.running || done || !canRun();
  resetBtn.disabled = off;
  speed.value = String(app.speed);
  renderScenarioPicker();
  renderStatus(); // 「比較」欄（未開始 / 実行中 / 一時停止 / 完了）
}

function laneEl(key, title) {
  return h('div', { class: `lane ${key}`, 'data-lane': key },
    h('div', { class: 'lane-title' }, h('span', { text: title }), h('small', { 'data-role': 'lane-sub' })),
    h('div', { class: 'track' }),
  );
}

function renderLane(key, title, state, config, view) {
  let el = $('lanes').querySelector(`[data-lane="${key}"]`);
  if (!el) {
    el = laneEl(key, title);
    $('lanes').append(el);
  }
  const goalX = config.route.goalX;
  const pct = (x) => `${Math.min(100, Math.max(0, (x / goalX) * 100))}%`;
  const model = config.control.crossingModel;
  const zoneWidth = model === 'length' ? `${(config.signal.crossingM / goalX) * 100}%` : '3px';
  el.querySelector('[data-role="lane-sub"]').textContent = view.finished
    ? `ゴール ${f1(view.finishTimeS)} 秒`
    : view.waiting ? `信号待ち（停止 ${f1(view.stopTimeS)} 秒）` : modeLabel(view.mode);
  el.querySelector('.track').replaceChildren(
    h('div', { class: 'track-line' }),
    h('div', { class: `zone ${model}`, style: `left:${pct(config.route.crossingX)};width:${zoneWidth}`, title: model === 'length' ? `横断幅 ${config.signal.crossingM} m` : '横断地点' }),
    h('div', { class: `signal ${view.signal.color}`, style: `left:${pct(config.route.crossingX)}`, title: `信号: ${view.signal.label}` }),
    h('span', { class: 'signal-label', style: `left:${pct(config.route.crossingX)}`, text: `${view.signal.label}（残り ${f1(view.signal.remainingS)} 秒）` }),
    h('div', { class: 'goal', style: `left:100%` }),
    h('span', { class: 'goal-label', style: 'left:100%', text: `ゴール ${f0(goalX)} m` }),
    h('div', { class: `runner${view.waiting ? ' waiting' : ''}${view.finished ? ' finished' : ''}`, style: `left:${pct(view.x)}`, title: `${f1(view.x)} m` }),
    h('span', { class: 'pos-label', style: `left:${pct(view.x)}`, text: `${f1(view.x)} m` }),
  );
}

function renderSim() {
  const err = $('sim-error');
  err.hidden = !app.runError;
  err.textContent = app.runError ?? '';
  if (!app.pair) {
    $('lanes').replaceChildren(h('div', { class: 'msg error', text: '比較シミュレーターは使えません（core の契約が変わっています。画面上部の赤い帯を確認してください）。' }));
    $('metrics').replaceChildren();
    $('result').replaceChildren();
    $('state-table').replaceChildren();
    renderPreview();
    return;
  }
  const { pair } = app;
  const vN = laneView(pair.normal, pair.configs.normal, pair.tick);
  const vR = laneView(pair.runwave, pair.configs.runwave, pair.tick);
  renderLane('normal', '通常走行（制御 OFF）', pair.normal, pair.configs.normal, vN);
  renderLane('runwave', 'RUNWAVE（制御 ON）', pair.runwave, pair.configs.runwave, vR);

  const bpmText = (v) => (v.waiting ? '0（待機中）' : v.finished ? `${f0(v.bpm)}（ゴール）` : f0(v.bpm));
  const rowDefs = [
    ['共通の経過時間（秒）', () => f1(vN.elapsedS), () => f1(vR.elapsedS)],
    ['位置（m）', (v) => f1(v.x), (v) => f1(v.x)],
    ['現在ケイデンス（歩/分）', bpmText, bpmText],
    ['目標ケイデンス（歩/分）', (v) => f0(v.targetBpm), (v) => f0(v.targetBpm)],
    ['モード', (v) => modeLabel(v.mode), (v) => modeLabel(v.mode)],
    ['信号色（共通の時計）', (v) => `${v.signal.label}（残り ${f1(v.signal.remainingS)} 秒）`, (v) => `${v.signal.label}（残り ${f1(v.signal.remainingS)} 秒）`],
    ['停止回数', (v) => String(v.stops), (v) => String(v.stops)],
    ['停止時間（秒・待機中の経過を含む）', (v) => f1(v.stopTimeS), (v) => f1(v.stopTimeS)],
    ['ゴール時の所要時間（秒）', (v) => (v.finished ? f1(v.finishTimeS) : '未ゴール'), (v) => (v.finished ? f1(v.finishTimeS) : '未ゴール')],
  ];
  $('metrics').replaceChildren(
    h('div', { class: 'table-scroll' },
      h('table', null,
        h('thead', null, h('tr', null, h('th', { text: '項目' }), h('th', { class: 'num', text: '通常走行' }), h('th', { class: 'num', text: 'RUNWAVE' }))),
        h('tbody', null, rowDefs.map(([name, fn, fr], i) => {
          const a = i === 0 ? fn() : fn(vN);
          const b = i === 0 ? fr() : fr(vR);
          return h('tr', null, h('th', { text: name }), h('td', { class: 'num', text: a }), h('td', { class: 'num', text: b }));
        })),
      ),
    ),
  );
  renderResult();
  renderStateTable();
  renderPreview();
}

function renderResult() {
  const box = $('result');
  if (!isDone()) {
    box.replaceChildren(h('p', { class: 'hint', text: '両レーンがゴールすると、停止回避と所要時間の差を別々に表示します。' }));
    return;
  }
  const summary = pairSummary(app.pair);
  const d = describeResult(summary);
  const v = app.verification;
  const timeLimit = !summary.normal.finished || !summary.runwave.finished;
  const extraRows = extraSummaryRows(summary);
  box.replaceChildren(
    ...[
    timeLimit ? h('div', { class: 'msg warn', text: `最大時間（${app.pair.tick / 10} 秒）までにゴールしませんでした（到達不能とは断定しません）。` }) : null,
    h('div', { class: 'line', text: d.stopLine }),
    h('div', { class: 'line', text: d.timeLine }),
    h('div', { class: 'line' },
      '逐次 step と core.compare の照合: ',
      v.status === 'checking' ? badge('pending', '照合中…') : v.status === 'match' ? badge('success', '一致') : v.status === 'mismatch' ? badge('failure', '不一致') : badge('pending', '照合待ち'),
    ),
    extraRows.length
      ? h('div', null,
          h('h3', { text: 'その他の集計（ダッシュボードが意味を知らない項目。core に追加されたもの）' }),
          h('table', null,
            h('thead', null, h('tr', null, ['項目', '通常走行', 'RUNWAVE'].map((t) => h('th', { text: t })))),
            h('tbody', null, extraRows.map((r) => h('tr', null, h('th', { text: r.key }), h('td', { text: r.normal }), h('td', { text: r.runwave })))),
          ),
        )
      : null,
    v.status === 'mismatch'
      ? h('div', { class: 'msg error' }, '不一致の項目があります（core または画面の不具合の可能性）。', h('ul', null, v.items.filter((i) => !i.ok).map((i) => h('li', { text: `${i.lane}.${i.key}: 逐次 ${i.sequential} / compare ${i.reference}` }))))
      : null,
    ].filter(Boolean),
  );
}

/* ---------- 描画: 設定フォーム ---------- */
const fieldInputs = {};
function buildForm() {
  const mk = (f) => {
    const wrap = h('div', { class: 'field' });
    wrap.append(h('label', { for: `f-${f.id}`, text: `${f.label}${f.unit ? `（${f.unit}）` : ''}` }));
    let input;
    if (f.kind === 'select') {
      input = h('select', { id: `f-${f.id}` }, f.options.map((o) => h('option', { value: o, text: o })));
    } else {
      input = h('input', { id: `f-${f.id}`, type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false' });
    }
    input.addEventListener('input', () => onFormInput(f.id, input.value));
    input.addEventListener('change', () => onFormInput(f.id, input.value));
    fieldInputs[f.id] = input;
    wrap.append(input);
    if (f.help) wrap.append(h('small', { text: f.help }));
    return wrap;
  };
  const group = (g) => h('div', { class: 'form-grid' }, FIELDS.filter((f) => f.group === g).map(mk));
  const mainGroup = group('main');
  const signalGroup = group('signal');
  const advancedGroup = group('advanced');
  $('form').replaceChildren(
    h('h3', { text: '走者・コース' }), mainGroup,
    h('h3', { text: '信号' }), signalGroup,
    h('div', { id: 'model-help', class: 'model-help' }),
    h('div', { id: 'extra-config', class: 'hint' }),
    h('details', null, h('summary', { text: '詳細設定（余裕時間・調整上限・変更周期・目標再計算周期など）' }), advancedGroup),
    h('div', { id: 'form-errors', class: 'msg error', role: 'alert', hidden: true }),
    h('div', { id: 'form-dirty', class: 'msg info', hidden: true }),
    h('div', { class: 'controls' },
      h('button', { type: 'button', id: 'btn-apply', class: 'primary', onclick: onApply }, '適用してリセット'),
      h('button', { type: 'button', id: 'btn-revert', onclick: onRevert }, '入力を現在の設定に戻す'),
    ),
  );
}

function onFormInput(id, value) {
  if (app.running) return;
  app.form = { ...app.form, [id]: value };
  validateForm();
  renderForm();
  renderControls();
  renderStatus();
}

function validateForm() {
  app.formErrors = parseForm(app.form, app.config).errors;
}

function onApply() {
  if (app.running) return;
  const { config, errors } = parseForm(app.form, app.config);
  app.formErrors = errors;
  if (errors.length) {
    renderForm();
    renderControls();
    return;
  }
  setConfig(config, undefined, { keepBase: true });
}

function onRevert() {
  if (app.running) return;
  app.form = configToForm(app.config);
  app.formErrors = [];
  renderAll();
}

function renderForm() {
  const bad = new Set(app.formErrors.map((e) => e.field).filter(Boolean));
  for (const f of FIELDS) {
    const el = fieldInputs[f.id];
    if (el.value !== app.form[f.id]) el.value = app.form[f.id] ?? '';
    el.disabled = app.running;
    el.classList.toggle('invalid', bad.has(f.id));
    el.setAttribute('aria-invalid', String(bad.has(f.id)));
  }
  const model = app.form.crossingModel;
  $('model-help').replaceChildren(
    h('div', { text: MODEL_HELP.point, style: model === 'point' ? 'font-weight:600' : '' }),
    h('div', { text: MODEL_HELP.length, style: model === 'length' ? 'font-weight:600' : '' }),
  );
  // 横断モデルが core に増えた場合: 説明が無いことを示す（選択肢は core の CROSSING_MODELS から自動で出る）
  if (model && !(model in MODEL_HELP)) {
    $('model-help').append(h('div', { text: `${model}: このモデルの説明はダッシュボードにありません（core/CONTRACT.md を参照）。`, style: 'font-weight:600' }));
  }
  const extra = app.config ? extraConfigEntries(app.config) : [];
  $('extra-config').replaceChildren(
    ...(extra.length
      ? [h('b', { text: '編集欄にない設定（そのまま保持されます）: ' }), extra.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' / ')]
      : []),
  );
  const errBox = $('form-errors');
  errBox.hidden = app.formErrors.length === 0;
  errBox.replaceChildren(
    ...(app.formErrors.length
      ? [h('div', { text: '入力を直してください（直すまで開始・適用はできません）:' }), h('ul', null, app.formErrors.map((e) => h('li', { text: e.message })))]
      : []),
  );
  const dirty = isDirty();
  const dirtyBox = $('form-dirty');
  dirtyBox.hidden = !dirty || app.formErrors.length > 0;
  dirtyBox.textContent = '未適用の変更があります。「適用してリセット」を押すと、この値で両レーンを作り直します（押すまで開始できません）。';
  $('btn-apply').disabled = app.running || !F.form || !F.sim || app.formErrors.length > 0 || !dirty;
  $('btn-revert').disabled = app.running || !dirty;
}

/* ---------- 描画: API ---------- */
function buildApi() {
  const base = h('input', { type: 'text', id: 'api-base', value: app.api.base, 'aria-label': 'API の URL', spellcheck: 'false' });
  const timeout = h('input', { type: 'number', id: 'api-timeout', value: String(app.api.timeoutMs), min: '100', step: '100', 'aria-label': 'タイムアウト（ミリ秒）' });
  base.addEventListener('input', () => { app.api.base = base.value; lsSet(LS_API_BASE, base.value); });
  timeout.addEventListener('input', () => { app.api.timeoutMs = Number(timeout.value) || DEFAULT_TIMEOUT_MS; lsSet(LS_API_TIMEOUT, String(app.api.timeoutMs)); });
  $('api').replaceChildren(
    h('p', { class: 'hint' },
      '「API を確認」を押したときだけ、次の 3 つに GET を送ります（常時ポーリングはしません。POST は送りません）。バックエンドが止まっていても、1〜3 の固定シナリオは動きます。',
    ),
    h('div', { class: 'api-row' },
      h('label', { for: 'api-base', text: 'API の URL' }), base,
      h('label', { for: 'api-timeout', text: 'タイムアウト（ms）' }), timeout,
      h('button', { type: 'button', id: 'btn-api', class: 'primary', onclick: onCheckApi }, 'API を確認'),
    ),
    h('div', { id: 'api-results' }),
    h('div', { id: 'api-signals' }),
  );
}

async function onCheckApi() {
  if (app.api.checking) return;
  app.api.checking = true;
  app.api.applyMessage = null;
  renderApi();
  try {
    const base = app.api.base;
    app.api.results = await checkAll(base, { timeoutMs: app.api.timeoutMs });
    app.api.resultsBase = base;
  } catch (e) {
    app.api.results = [];
    app.api.applyMessage = { kind: 'error', text: `確認中に想定外のエラー: ${e.message}` };
  }
  app.api.checkedAt = new Date().toISOString();
  app.api.checking = false;
  const sig = app.api.results.find((r) => r.id === 'signals');
  const first = sig?.status === 'success' ? sig.data.signals.find((x) => x.signal) : null;
  if (!first || !sig.data.signals.some((x) => x.signal && x.index === app.api.selected)) app.api.selected = first ? first.index : null;
  renderApi();
  renderStatus();
}

function renderApi() {
  const btn = $('btn-api');
  const anyFail = app.api.results.some((r) => r.status === 'failure');
  btn.disabled = app.api.checking || !F.api;
  btn.title = F.api ? '' : 'core / api-adapter の契約が変わったため、API 確認は使えません';
  btn.textContent = app.api.checking ? '確認中…' : anyFail ? '再試行（API を確認）' : 'API を確認';

  const rows = ENDPOINTS.map((ep) => {
    const r = app.api.results.find((x) => x.id === ep.id);
    if (!r) return h('tr', null, h('td', { text: `GET ${ep.path}` }), h('td', { text: '-' }), h('td', { text: '-' }), h('td', null, badge('unchecked')), h('td', { text: ep.label }));
    return h('tr', null,
      h('td', null, `GET ${r.path}`, h('br'), h('small', { text: r.url ?? '' })),
      h('td', { text: new Date(r.at).toLocaleTimeString('ja-JP') }),
      h('td', { text: r.httpStatus == null ? '応答なし' : `${r.httpStatus}${r.ms != null ? `（${r.ms}ms）` : ''}` }),
      h('td', null, badge(r.status)),
      h('td', null,
        r.summary ? h('div', { text: r.summary }) : null,
        r.problems.length ? h('ul', { class: 'api-problems' }, r.problems.map((p) => h('li', { text: p }))) : null,
        r.warnings.length ? h('ul', { class: 'api-warnings' }, r.warnings.map((p) => h('li', { text: `注意: ${p}` }))) : null,
      ),
    );
  });
  const overall = overallStatus(app.api.results);
  $('api-results').replaceChildren(
    h('div', { class: 'table-scroll' },
      h('table', null,
        h('thead', null, h('tr', null, ['エンドポイント', '取得時刻', 'HTTP', '判定', '内容・理由'].map((t) => h('th', { text: t })))),
        h('tbody', null, rows),
      ),
    ),
    h('p', null, 'まとめ: ', badge(overall), app.api.results.length ? '　（HTTP 200 でも、形式が不正・空の信号なら失敗です。失敗した接続を成功として記録しません）' : ''),
  );

  // 信号一覧と「比較条件へ適用」
  const sig = app.api.results.find((r) => r.id === 'signals');
  const box = $('api-signals');
  const kids = [];
  if (sig?.status === 'success') {
    const list = sig.data.signals;
    kids.push(
      h('h3', { text: '信号一覧から 1 件を選んで、比較条件へ適用' }),
      h('p', { class: 'hint', text: '受信しただけでは固定シナリオの条件を上書きしません。API の crossingM は「横断幅」として signal.crossingM に入ります（横断地点までの距離 route.crossingX は変わりません）。' }),
      h('div', { class: 'signal-list' },
        list.map((x) => {
          const ok = !!x.signal;
          const radio = h('input', { type: 'radio', name: 'api-signal', id: `sig-${x.index}`, disabled: !ok || app.running, checked: ok && app.api.selected === x.index });
          radio.addEventListener('change', () => { app.api.selected = x.index; });
          return h('label', { class: `signal-item${ok ? '' : ' invalid'}`, for: `sig-${x.index}` },
            radio,
            h('span', null,
              h('b', { text: x.id ?? `#${x.index}` }),
              ok
                ? `　周期 ${x.signal.cycleS} 秒（青 ${x.signal.greenS} / 青点滅 ${x.signal.yellowS} / 赤 ${x.signal.redS}）・位相 ${x.signal.phaseS} 秒・横断幅 ${x.signal.crossingM} m`
                : `　使えません: ${x.problems.join(' / ')}`,
              x.note ? h('br') : null,
              x.note ? h('small', { text: x.note }) : null,
            ),
          );
        }),
      ),
      h('div', { class: 'controls' },
        h('button', { type: 'button', class: 'primary', id: 'btn-api-apply', disabled: app.running || !F.sim || !F.form || app.api.selected == null, onclick: onApplyApiSignal }, '比較条件へ適用'),
        app.running ? h('span', { class: 'hint', text: '実行中は適用できません。一時停止してください。' }) : null,
      ),
    );
  } else if (sig) {
    kids.push(h('div', { class: 'msg error', text: 'API から使える信号を取得できていません。固定シナリオで比較を続けられます（API の値には切り替わりません）。' }));
  }
  if (app.api.applyMessage) kids.push(h('div', { class: `msg ${app.api.applyMessage.kind}`, text: app.api.applyMessage.text }));
  if (app.source.kind === 'api') {
    kids.push(
      h('div', { class: 'msg info' },
        `現在の比較条件は API の信号「${app.source.signalId}」（取得 ${timeOnly(app.source.fetchedAt)}）です。 `,
        h('button', { type: 'button', disabled: app.running, onclick: () => loadScenario(DEFAULT_SCENARIO_ID) }, '固定シナリオに戻す'),
      ),
    );
  }
  box.replaceChildren(...kids);
}

function onApplyApiSignal() {
  if (app.running || !app.config || !F.sim) return;
  const sig = app.api.results.find((r) => r.id === 'signals');
  const item = sig?.data?.signals.find((x) => x.index === app.api.selected && x.signal);
  if (!item) {
    app.api.applyMessage = { kind: 'error', text: '適用する信号を選んでください' };
    renderApi();
    return;
  }
  const r = applyApiSignal(app.config, item.signal);
  if (r.error) {
    app.api.applyMessage = { kind: 'error', text: r.error };
    renderApi();
    return;
  }
  app.api.applyMessage = { kind: 'ok', text: `API の信号「${item.id}」を比較条件に適用し、両レーンをリセットしました。` };
  setConfig(r.config, { kind: 'api', signalId: item.id ?? `#${item.index}`, fetchedAt: sig.at, apiBase: app.api.base, note: item.note ?? null });
}

/* ---------- 描画: 共有 ---------- */
function currentReport() {
  const summary = app.pair ? pairSummary(app.pair) : null;
  const source = { ...app.source, edited: isEdited() };
  return buildReport({
    now: new Date(),
    env: { userAgent: navigator.userAgent, url: location.href },
    meta: META,
    coreVersion: CORE_VERSION,
    source,
    scenarioId: scenarioLabel(),
    config: app.config ?? {},
    tick: app.pair?.tick ?? 0,
    contract,
    summary,
    description: summary ? describeResult(summary) : null,
    verification: isDone() ? (app.verification.status === 'checking' ? { status: 'pending', items: [] } : app.verification) : { status: 'pending', items: [] },
    apiBase: app.api.resultsBase ?? app.api.base,
    apiResults: app.api.results,
    apiOverall: overallStatus(app.api.results),
    checklist: app.checklist,
    memo: app.memo,
  });
}

function buildShare() {
  const memo = h('textarea', { id: 'memo', rows: '3', 'aria-label': 'メモ', placeholder: '確認時のメモ（使用ブラウザ、気づいた点など）' });
  memo.value = app.memo;
  memo.addEventListener('input', () => { app.memo = memo.value; lsSet(LS_MEMO, memo.value); });
  $('share').replaceChildren(
    h('p', { class: 'hint', text: '現在の画面の状態（ゴール前なら途中経過）を、確認日時・環境・core バージョン・Git SHA・config 全体・結果・API 確認結果・再現手順・未確認事項つきで出力します。' }),
    h('label', { for: 'memo', text: 'メモ' }), memo,
    h('div', { class: 'controls' },
      h('button', { type: 'button', class: 'primary', onclick: onCopyMarkdown }, 'Markdown をコピー'),
      h('button', { type: 'button', onclick: onDownloadJson }, 'JSON をダウンロード'),
      h('button', { type: 'button', onclick: () => { fillPreview(); $('report-details').open = true; } }, 'プレビューを更新'),
    ),
    h('div', { id: 'share-msg', class: 'msg info', hidden: true, role: 'status' }),
    h('details', { id: 'report-details' },
      h('summary', { text: 'Markdown プレビュー（コピーできない場合はここを選択してコピー）' }),
      h('textarea', { id: 'report-text', class: 'report', readonly: true, 'aria-label': 'Markdown レポート' }),
    ),
  );
}

function shareMessage(kind, text) {
  const el = $('share-msg');
  el.hidden = false;
  el.className = `msg ${kind}`;
  el.textContent = text;
}

function fillPreview() {
  const md = reportToMarkdown(currentReport());
  $('report-text').value = md;
  return md;
}

async function onCopyMarkdown() {
  const md = fillPreview();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API が使えません');
    await navigator.clipboard.writeText(md);
    shareMessage('ok', 'Markdown をクリップボードにコピーしました。');
  } catch (e) {
    $('report-details').open = true;
    const ta = $('report-text');
    ta.focus();
    ta.select();
    shareMessage('warn', `自動コピーに失敗しました（${e.message}）。下の欄を全選択してあるので、Ctrl+C でコピーしてください。`);
  }
}

function onDownloadJson() {
  const report = currentReport();
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: reportFileName(report) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  shareMessage('ok', `JSON を保存しました（${reportFileName(report)}）。`);
}

/* ---------- 描画: 担当別チェック ---------- */
function buildChecklist() {
  $('checklist').replaceChildren(
    h('div', { class: 'msg warn' },
      '手動で記録する欄です。自動検査（逐次=compare の照合・API 確認）の結果では更新されません。メモを書いても状態は変わりません。',
      h('br'),
      'このブラウザの localStorage にだけ保存します（共有・送信はしません）。別の PC・ブラウザには引き継がれません。',
    ),
    h('div', { id: 'check-summary', class: 'hint' }),
    h('div', { class: 'table-scroll' }, h('table', { class: 'check-table', id: 'check-table' })),
  );
}

function renderChecklist() {
  const counts = checklistCounts(app.checklist);
  $('check-summary').textContent = `未確認 ${counts.unchecked} / 確認中 ${counts.checking} / 成功 ${counts.success} / 失敗 ${counts.failure}（手動記録）`;
  const table = $('check-table');
  // 入力中のフォーカスを失わないよう、構造は 1 度だけ作り、値だけを更新する
  if (!table.dataset.built) {
    table.dataset.built = '1';
    table.replaceChildren(
      h('thead', null, h('tr', null, ['担当', '項目', '状態', '証拠・メモ'].map((t) => h('th', { text: t })))),
      h('tbody', null, app.checklist.map((c) => {
        const sel = h('select', { 'aria-label': `${c.owner}: ${c.title} の状態`, 'data-check': c.id },
          CHECK_STATUSES.map((s) => h('option', { value: s, text: CHECK_STATUS_LABELS[s] })));
        sel.addEventListener('change', () => {
          app.checklist = setStatus(app.checklist, c.id, sel.value);
          persistChecklist();
          renderChecklist();
        });
        const note = h('input', { type: 'text', 'aria-label': `${c.owner}: ${c.title} の証拠・メモ`, 'data-note': c.id, placeholder: 'ログの場所、スクリーンショット名など' });
        note.addEventListener('input', () => {
          app.checklist = setNote(app.checklist, c.id, note.value);
          persistChecklist();
        });
        return h('tr', null, h('td', { text: c.owner }), h('td', { text: c.title }), h('td', { class: 'status-cell' }, sel), h('td', null, note));
      })),
    );
  }
  for (const c of app.checklist) {
    const sel = table.querySelector(`[data-check="${c.id}"]`);
    const note = table.querySelector(`[data-note="${c.id}"]`);
    if (sel.value !== c.status) sel.value = c.status;
    if (note.value !== c.note) note.value = c.note;
  }
}

function persistChecklist() {
  if (!saveChecklist(storage, app.checklist)) {
    const el = $('check-summary');
    el.textContent += '　※ localStorage が使えないため、この記録はページを閉じると消えます';
  }
}

/* ---------- 描画: 端末風プレビュー（P1） ---------- */
function buildPreview() {
  const laneSel = h('select', { id: 'preview-lane', 'aria-label': '表示元のレーン', onchange: (e) => { app.previewLane = e.target.value; renderPreview(); } },
    h('option', { value: 'runwave', text: 'RUNWAVE レーン' }), h('option', { value: 'normal', text: '通常走行レーン' }));
  const rows = SENSOR_FIELDS.map((f) => {
    const input = h('input', { type: 'text', inputmode: 'decimal', id: `sensor-${f.id}`, autocomplete: 'off', 'aria-label': `模擬 ${f.label}（${f.unit}）`, placeholder: '空欄 = 未計測' });
    const miss = h('input', { type: 'checkbox', id: `sensor-${f.id}-missing` });
    const update = () => {
      app.sensors[f.id] = { text: input.value, missing: miss.checked };
      renderPreview();
    };
    input.addEventListener('input', update);
    miss.addEventListener('change', update);
    return h('div', { class: 'field' },
      h('label', { for: `sensor-${f.id}`, text: `模擬 ${f.label}（${f.unit}）` }),
      input,
      h('label', { class: 'check-inline' }, miss, ' 欠測'),
    );
  });
  $('preview').replaceChildren(
    h('div', { class: 'msg warn' },
      'SwiftUI とは独立した Web プレビューです。実機（iPhone / Watch）の画面を再現するものではありません。',
    ),
    h('div', { class: 'msg info' },
      '模擬値は表示確認のみ。core の計算には使っていません（目標ケイデンスや信号の判定は、上の比較シミュレーターの core state をそのまま表示しています）。',
      h('br'),
      '心拍の閾値判定や自動減速は実装していません（CONTRACT-ext.md は設計のみ・未合意）。',
    ),
    h('div', { class: 'controls' }, h('label', null, '表示元', laneSel)),
    h('h3', null, '模擬センサー入力 ', h('span', { class: 'badge warn', text: '模擬入力' })),
    h('div', { class: 'form-grid' }, rows),
    h('div', { id: 'sensor-errors', class: 'msg error', role: 'alert', hidden: true }),
    h('div', { id: 'preview-cards', class: 'device-cards' }),
  );
}

function renderPreview() {
  if (!F.preview || !app.pair) {
    $('preview-cards').replaceChildren(h('div', { class: 'msg error', text: '端末風プレビューは使えません（core の契約が変わっています）。' }));
    return;
  }
  const key = app.previewLane;
  const state = app.pair[key];
  const config = app.pair.configs[key];
  const view = laneView(state, config, app.pair.tick);
  const m = buildPreviewModel({ view, config, sensors: app.sensors });
  const modeText = modeLabel(m.target.mode);

  const invalid = ['speed', 'cadence', 'heartRate'].map((k) => m.measured[k]).filter((p) => p.state === 'invalid');
  const errBox = $('sensor-errors');
  errBox.hidden = invalid.length === 0;
  errBox.textContent = invalid.map((p) => p.message).join(' / ');

  const sig = h('span', { class: `sig-dot ${m.target.signal.color}`, title: m.target.signal.label });
  const sigText = `${m.target.signal.label}（残り ${f1(m.target.signal.remainingS)} 秒）`;
  const kv = (k, v, note) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('b', { text: v }), note ? h('small', { text: note }) : null);
  const simBadge = () => h('span', { class: 'badge warn', text: '模擬入力' });

  const phone = h('div', { class: 'device phone', 'aria-label': 'iPhone 風カード' },
    h('div', { class: 'device-title', text: 'iPhone 風（Web プレビュー）' }),
    h('div', { class: 'section-label', text: '目標値（core の targetBpm）' }),
    h('div', { class: 'big' }, String(f0(m.target.bpm)), h('small', { text: ' 歩/分' })),
    h('div', { class: 'mode', text: modeText }),
    h('div', { class: 'sigline' }, sig, sigText),
    h('div', { class: 'section-label', text: 'core の推定値（歩幅 × 現在ケイデンスからの計算）' }),
    kv('現在ケイデンス', m.target.waiting ? '0 歩/分（待機中）' : `${f0(m.core.bpm)} 歩/分`),
    kv('推定速度', `${(Math.round(m.core.speedMps * 100) / 100).toFixed(2)} m/s`),
    kv('推定ペース', m.core.pace.text),
    h('div', { class: 'section-label' }, '模擬実測値 ', simBadge()),
    kv('速度', sensorText(m.measured.speed, 'm/s', 2)),
    kv('実測ケイデンス', sensorText(m.measured.cadence, '歩/分', 0)),
    kv('心拍', sensorText(m.measured.heartRate, '拍/分', 0)),
    kv('ペース（模擬速度から）', m.measured.pace.text),
  );

  const watch = h('div', { class: 'device watch', 'aria-label': 'Watch 風カード' },
    h('div', { class: 'device-title', text: 'Watch 風（Web プレビュー）' }),
    h('div', { class: 'section-label', text: '目標' }),
    h('div', { class: 'big' }, String(f0(m.target.bpm)), h('small', { text: ' 歩/分' })),
    h('div', { class: 'mode', text: modeText }),
    h('div', { class: 'sigline' }, sig.cloneNode(true), sigText),
    h('div', { class: 'section-label' }, '心拍 ', simBadge()),
    h('div', { class: 'kv' }, h('b', { text: sensorText(m.measured.heartRate, '拍/分', 0) })),
  );
  $('preview-cards').replaceChildren(
    phone,
    watch,
    h('p', { class: 'hint', text: `表示元: ${key === 'runwave' ? 'RUNWAVE' : '通常走行'}レーンの core state（共通の経過 ${f1(app.pair.tick / 10)} 秒）。ケイデンスの単位は歩/分で、心拍数ではありません。` }),
  );
}

/* ---------- 全体 ---------- */
function renderAll() {
  renderStatus();
  renderScenarioPicker();
  renderControls();
  renderSim();
  renderForm();
  renderApi();
  renderChecklist();
}

/* ---------- 契約の帯・core の自動表示 ---------- */
const FEATURE_NAMES = { sim: '比較シミュレーター', form: '設定フォームの適用', preview: '端末風プレビュー', api: 'API 確認', scenarios: 'シナリオ選択' };

function renderBanner() {
  const kids = [];
  if (!contract.ok) {
    const off = Object.entries(F).filter(([, on]) => !on).map(([k]) => FEATURE_NAMES[k] ?? k);
    kids.push(
      h('div', { class: 'band error', role: 'alert' },
        h('b', { text: `core の契約が変わりました（不足: ${[...contract.missing, ...contract.problems].join('、')}）。dashboard の更新が必要です` }),
        off.length ? h('div', { text: `無効にしている機能: ${off.join('、')}。それ以外は使えます。` }) : null,
      ),
    );
  }
  if (contract.warnings.length) {
    kids.push(h('div', { class: 'band warn' }, `core の一部の export が見つかりません（該当の表示は簡易になります）: ${contract.warnings.join(' / ')}`));
  }
  if (SCENARIO_PROBLEMS.length) {
    kids.push(h('div', { class: 'band warn' }, `シナリオの一部を読み込めませんでした: ${SCENARIO_PROBLEMS.join(' / ')}`));
  }
  $('contract-banner').replaceChildren(...kids);
}

/** core state の全項目（history 除く）を汎用表示する。既知の項目は「詳細」、未知のキーは「新しい項目」 */
function renderStateTable() {
  const det = $('state-details');
  if (!det || !det.open) return; // 開いているときだけ毎フレーム更新する
  if (!app.pair) return;
  const rows = stateRows(app.pair.normal, app.pair.runwave);
  const fresh = rows.filter((r) => !r.known).length;
  fill($('state-table'),
    fresh ? h('div', { class: 'msg info', text: `ダッシュボードが意味を知らない項目が ${fresh} 件あります（core に追加された可能性）。` }) : null,
    h('div', { class: 'table-scroll' },
      h('table', null,
        h('thead', null, h('tr', null, ['項目', '区分', '通常走行', 'RUNWAVE'].map((t) => h('th', { text: t })))),
        h('tbody', null, rows.map((r) =>
          h('tr', null,
            h('th', { text: r.key }),
            h('td', null, r.known ? '詳細' : h('span', { class: 'badge warn', text: '新しい項目' })),
            h('td', { text: r.normal }),
            h('td', { text: r.runwave }),
          ))),
      ),
    ),
  );
}

/** core の公開 export を、ダッシュボードで使用中／未使用に分けて出す（起動時に 1 回） */
function buildExports() {
  const { used, unused } = describeExports(core);
  const table = (rows, withNew) =>
    h('div', { class: 'table-scroll' },
      h('table', null,
        h('thead', null, h('tr', null, ['名前', '種類', '引数の数'].map((t) => h('th', { text: t })))),
        h('tbody', null, rows.map((r) =>
          h('tr', null,
            h('th', null, r.name, withNew && r.possiblyNew ? h('span', { class: 'badge warn', text: '新規の可能性' }) : null),
            h('td', { text: r.kind }),
            h('td', { text: r.arity == null ? '-' : String(r.arity) }),
          ))),
      ),
    );
  $('core-exports').replaceChildren(
    h('p', { class: 'hint', text: `core/runwave-core.js の export は全部で ${used.length + unused.length} 件。core に関数が増えると、ここに自動で出ます（「新規の可能性」はダッシュボードが把握していない名前）。` }),
    h('h3', { text: `ダッシュボードで使用中（${used.length}）` }),
    table(used, false),
    h('h3', { text: `未使用（${unused.length}）` }),
    table(unused, true),
  );
}

function init() {
  buildScenarioPicker();
  buildSimControls();
  buildForm();
  buildApi();
  buildShare();
  buildPreview();
  buildChecklist();
  buildExports();
  $('state-details').addEventListener('toggle', renderStateTable);
  renderBanner();
  renderExpected();
  if (F.sim && F.scenarios && DEFAULT_SCENARIO_ID) {
    loadScenario(DEFAULT_SCENARIO_ID);
    scheduleExpected();
  } else {
    renderAll(); // 比較シミュレーターは無効。他の機能（API・チェックなど）は使える
  }
}

function showFatal(err, where) {
  try {
    const box = document.getElementById('fatal');
    box.hidden = false;
    box.replaceChildren(
      h('b', { text: `ダッシュボードでエラーが発生しました（${where}）。画面の一部が動かない可能性があります。` }),
      h('pre', { text: String(err?.stack || err?.message || err) }),
    );
  } catch { /* 表示自体に失敗しても何もしない */ }
}

try {
  init();
} catch (e) {
  showFatal(e, '起動処理');
}
