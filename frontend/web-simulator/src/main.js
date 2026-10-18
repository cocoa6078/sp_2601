// 画面イベントと状態遷移の接続。計算は playback / engine-adapter（core）に任せ、ここには式を書かない。
import './styles.css';
import { core } from './core-ns.js';
import { createMapView } from './map-view.js';
import { Playback, SPEEDS } from './playback.js';
import { STATUS_LABEL, initialState, statusOf } from './store.js';
import { DEMO_SCENARIOS, defaultRunnerAndControl, getDemo } from './scenarios.js';
import { DEMO_ROUTE_POINTS, FIXTURE_SIGNALS } from './fixtures.js';
import { addVia, draftPoints, draftRoute, matchSignals, moveVia, removeVia, reorderVia } from './route-builder.js';
import { buildRoute, pointAtDistance, validateRoute } from './route-geometry.js';
import { OSM_FIX_URL, WALK_ROUTE_LABEL, WALK_ROUTE_SOURCE, fetchWalkRoute } from './walk-routing.js';
import { expectedFor, isRouteConfig, matchesExpected, planFromMap, runnerView, summaryOf, versions } from './engine-adapter.js';
import { fetchCalibration, fetchSignals } from './api.js';
import { buildReport, buildTimeSeriesCsv, csvFileName, reportFileName } from './report.js';
import { ESTIMATED_LABEL, anyEstimated, apiFailureMessage, buildApiInfo } from './provenance.js';
import { runnerCard } from './metrics-view.js';
import { resultsHtml } from './comparison-view.js';
import { signalDetailHtml } from './signal-view.js';
import { esc, f1 } from './format.js';

const META = typeof __RUNWAVE_META__ !== 'undefined' ? __RUNWAVE_META__ : { gitSha: null };
const S = initialState();
const $ = (id) => document.getElementById(id);

const mapView = createMapView($('map'), {
  onMapClick: (tool, ll) => handleMapClick(tool, ll),
  onDragPoint: (kind, idx, ll) => handleDrag(kind, idx, ll),
  onTileError: () => { S.tileFailed = true; renderBanner(); },
});

// ---------------------------------------------------------------- 計算条件の確定
function runnerAndControl() {
  const rc = defaultRunnerAndControl();
  return { runner: { ...rc.runner, ...(S.runnerOverride || {}) }, control: rc.control };
}

/** 条件（コース・信号・位相・校正）が変わったときに呼ぶ。再生は破棄し両走行をリセットする */
function recompute({ autoApply = false } = {}) {
  S.pb = null;
  S.error = null;
  S.expected = null;
  S.adopted = [];
  S.match = null;
  S.routeErrors = [];
  if (S.courseKind === 'demo') {
    const demo = getDemo(S.demoId);
    S.route = buildRoute(DEMO_ROUTE_POINTS, { id: 'demo', source: 'preset' });
    const config = JSON.parse(JSON.stringify(demo.config));
    if (S.runnerOverride) config.runner = { ...config.runner, ...S.runnerOverride };
    if (S.phaseS != null) config.signal.phaseS = S.phaseS;
    S.initialPhaseS = demo.config.signal.phaseS;
    S.factor = S.route.lengthM / config.route.goalX;
    const s = config.route.crossingX * S.factor;
    const p = pointAtDistance(S.route, s);
    S.adopted = [{ key: `demo:${demo.id}`, signalId: '模式信号', lat: p.lat, lng: p.lng, projPoint: p, s, offsetM: 0, signal: config.signal, origin: 'demo-scenario', originLabel: '固定デモ（模式コース）の信号' }];
    S.plan = { kind: 'single', config };
  } else {
    S.factor = 1;
    if (!S.confirmed) {
      S.route = null;
      S.plan = { kind: 'none', reason: '経路を確定してください' };
    } else {
      // 確定時に取得した経路（OSRM 道沿い、または直線）を使う。ここでは通信しない
      const dr = S.confirmedRoute ? { route: S.confirmedRoute, errors: validateRoute(S.confirmedRoute).errors } : draftRoute(S.draft, 'manual');
      S.route = dr.route;
      S.routeErrors = dr.errors;
      if (dr.errors.length) {
        S.plan = { kind: 'invalid', reason: dr.errors.join(' / ') };
      } else {
        S.match = matchSignals(dr.route, S.candidates, { toleranceM: S.toleranceM, manualExclude: S.manualExclude });
        S.adopted = S.match.adopted.map((a) => ({ ...a, originLabel: originLabel() }));
        if (S.phaseS != null && S.adopted.length === 1) {
          S.initialPhaseS = S.adopted[0].signal.phaseS;
          S.adopted[0] = { ...S.adopted[0], signal: { ...S.adopted[0].signal, phaseS: S.phaseS, phaseReference: 'run-start' } };
        } else S.initialPhaseS = S.adopted[0]?.signal.phaseS ?? null;
        if (S.match.errors.length) {
          S.plan = { kind: 'invalid', reason: S.match.errors.join(' / ') };
        } else {
          const { runner, control } = runnerAndControl();
          S.plan = planFromMap({ route: dr.route, adopted: S.adopted, runner, control, runStartUnixS: (S.runStartUnixS ??= Math.floor(Date.now() / 1000)) });
        }
      }
    }
  }
  if (S.plan.kind === 'single' || S.plan.kind === 'route') {
    try {
      S.expected = expectedFor(S.plan.config);
    } catch (e) {
      S.error = `core の一括計算に失敗: ${e.message}`;
    }
  }
  if (S.plan.kind === 'invalid') S.error = null; // 理由は設定パネルに出す（エラー扱いにしない）
  if (autoApply && (S.plan.kind === 'single' || S.plan.kind === 'route') && !S.error) applyStart(false);
  renderAll();
  redrawMap(true);
}

function originLabel() {
  return S.candidatesOrigin === 'api'
    ? `API（${S.api.base}）取得${S.api.at ? ` ${S.api.at.slice(11, 19)}` : ''}・車両用データ由来、位相は仮の参考信号。座標の根拠は未確認`
    : '模擬信号 fixture（backend スナップショット由来、位相は仮。API の成功応答ではない）';
}

/** 設定を適用して両走行を用意する（再生はまだしない） */
function applyStart(switchView = true) {
  if (S.plan.kind !== 'single' && S.plan.kind !== 'route') return;
  try {
    S.pb = new Playback(S.plan.config, { signalId: S.adopted[0]?.signalId ?? null });
  } catch (e) {
    S.pb = null;
    S.error = `走行を開始できません: ${e.message}`;
    renderAll();
    return;
  }
  S.autoPaused = false;
  if (switchView) S.view = 'run';
  mapView.clearRunners();
  renderAll();
  renderLive();
}

// ---------------------------------------------------------------- 地図の編集
function handleMapClick(tool, ll) {
  if (statusOf(S) === 'playing' || S.confirmed || S.routing) return;
  if (tool === 'start') { S.draft = { ...S.draft, start: ll }; S.editTool = null; }
  else if (tool === 'end') { S.draft = { ...S.draft, end: ll }; S.editTool = null; }
  else if (tool === 'via') S.draft = addVia(S.draft, ll);
  mapView.setEditMode(S.editTool);
  afterDraftChange();
}

function handleDrag(kind, idx, ll) {
  if (S.confirmed || S.routing) return;
  if (kind === 'start') S.draft = { ...S.draft, start: ll };
  else if (kind === 'end') S.draft = { ...S.draft, end: ll };
  else S.draft = moveVia(S.draft, idx, ll);
  afterDraftChange();
}

function afterDraftChange() {
  S.pb = null;
  S.plan = { kind: 'none', reason: '経路を確定してください' };
  S.error = null;
  renderAll();
  redrawMap(false);
}

function redrawMap(fit) {
  const demo = S.courseKind === 'demo';
  const editable = S.courseKind === 'map' && !S.confirmed && !S.routing;
  const route = S.confirmed || demo ? S.route : null;
  const multi = S.adopted.length > 1;
  const signals = [];
  S.adopted.forEach((a, i) => signals.push({ ...a, kind: 'adopted', orderNo: multi ? i + 1 : null }));
  if (S.match) for (const e of S.match.excluded) {
    const c = S.candidates.find((x) => x.key === e.key);
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) signals.push({ key: c.key, signalId: c.signalId, lat: c.lat, lng: c.lng, kind: 'excluded' });
  }
  mapView.setEditMode(S.courseKind === 'map' && !S.confirmed ? S.editTool : null);
  mapView.setRouteAttribution(S.courseKind === 'map' && S.confirmed && S.routeInfo?.kind === 'osrm');
  mapView.drawCourse({ draft: S.draft, route, editable, signals, fit, demo });
  mapView.clearRunners();
  renderLive();
  renderBanner();
}

// ---------------------------------------------------------------- 描画（状態が変わったとき）
function renderAll() {
  const st = statusOf(S);
  document.body.classList.toggle('rec', S.rec);
  $('tab-setup').classList.toggle('on', S.view === 'setup');
  $('tab-run').classList.toggle('on', S.view === 'run');
  $('rec-toggle').classList.toggle('on', S.rec);
  const core0 = core.CORE_VERSION;
  const originText = S.courseKind === 'demo'
    ? '固定デモ（模式コース）。信号は既存シナリオの定義'
    : originLabel();
  const est = anyEstimated(S.adopted) ? `【${ESTIMATED_LABEL}】` : '';
  $('origin').textContent = `${est}データ: ${originText} ｜ core ${core0}・route-core ${versions().routeVersion}（export 値）@ ${META.gitSha ? META.gitSha.slice(0, 7) : 'SHA 不明'}`;
  renderBar(st);
  renderSetup(st);
  $('setup-panel').hidden = S.view !== 'setup' || S.rec;
  $('run-panel').hidden = S.view !== 'run';
  renderLegend();
  renderBanner();
  renderLive();
}

function renderBar(st) {
  const pb = S.pb;
  const canPlay = pb && (st === 'ready' || st === 'paused');
  const speed = pb ? pb.speed : 1;
  $('bar').innerHTML = `
    <button class="btn primary" data-act="play" ${canPlay ? '' : 'disabled'}>${st === 'paused' ? '再開' : '再生'}</button>
    <button class="btn" data-act="pause" ${st === 'playing' ? '' : 'disabled'}>一時停止</button>
    <button class="btn" data-act="reset" ${pb ? '' : 'disabled'}>リセット</button>
    <span class="speeds">倍率 ${SPEEDS.map((v) => `<button class="btn sp ${v === speed ? 'on' : ''}" data-act="speed" data-v="${v}">${v}×</button>`).join('')}</span>
    <span class="clock" id="clock"></span>
    <span class="chip st-${st}" id="chip">${STATUS_LABEL[st]}</span>
    <span class="grow"></span>
    <button class="btn setup-only" data-act="save-csv" ${pb ? '' : 'disabled'} title="時刻・位置・信号色・目標/現在 BPM・速度・停止/通過を CSV で保存">時系列 CSV を保存</button>
    <button class="btn setup-only" data-act="save" ${pb ? '' : 'disabled'} title="条件・経路・採用/除外・結果・イベントを JSON で保存">結果 JSON を保存</button>`;
}

function renderLegend() {
  $('legend').innerHTML = `
    <span class="lg"><i class="runner normal static"></i>通常</span>
    <span class="lg"><i class="runner runwave static"></i>RUNWAVE</span>
    <span class="lg">信号: 青 / 青点滅 / 赤（文字併記）</span>
    <span class="lg small">${S.overlapShift ? '同地点の重なりをずらして表示（計算位置は同じ）' : '重なるときは左右に小さくずらして表示'}</span>
    <span class="lg small">${legendRouteNote()}</span>`;
}

function legendRouteNote() {
  if (S.courseKind === 'demo') return '模式コース: 実地図から測った距離ではない';
  if (S.confirmed && S.routeInfo?.kind === 'osrm') return '道沿い経路は OSRM 推定（実際の歩道・横断の通行可否・信号待ちは保証しない）';
  return '直線の折れ線は仮想経路（道路距離・歩道通行可能性は保証しない）';
}

/** 経路の種類（確定後、または取得中）を画面に出す */
function routeKindHtml() {
  if (S.routing) return '<div class="muted small">経路を取得中…</div>';
  if (!S.confirmed || !S.routeInfo) return '';
  if (S.routeInfo.kind === 'osrm') {
    return `<div class="small">経路の種類: <b>${esc(WALK_ROUTE_LABEL)}</b>
      <div class="muted">経路: OSRM（FOSSGIS） © OpenStreetMap contributors ／ <a href="${OSM_FIX_URL}" target="_blank" rel="noopener">地図の誤りを OSM で修正する</a></div></div>`;
  }
  return `<div class="small warn">経路の種類: <b>直線（取得失敗: ${esc(S.routeInfo.reason)}）</b></div>`;
}

/** 経路確定。道沿い経路を 1 回だけ取得し、失敗・不正なら従来の直線に戻す（編集中のプレビューは常に直線） */
async function confirmRoute() {
  const pts = draftPoints(S.draft);
  if (!pts || S.routing) return;
  S.routing = true;
  S.editTool = null;
  renderAll();
  redrawMap(false);
  let route = null;
  let info = null;
  try {
    const walked = await fetchWalkRoute(pts);
    const candidate = buildRoute(walked, { id: 'manual', source: WALK_ROUTE_SOURCE });
    const v = validateRoute(candidate);
    if (v.ok) {
      route = candidate;
      info = { kind: 'osrm', reason: null };
    } else {
      info = { kind: 'polyline', reason: `道沿い経路が経路条件に合いません: ${v.errors.slice(0, 2).join(' / ')}` };
    }
  } catch (e) {
    info = { kind: 'polyline', reason: e.message };
  }
  S.routing = false;
  S.confirmedRoute = route ?? draftRoute(S.draft, 'manual').route;
  S.routeInfo = info;
  S.confirmed = true;
  S.phaseS = null;
  S.manualExclude = new Set();
  recompute();
}

function renderBanner() {
  const msgs = [];
  if (S.tileFailed) msgs.push('背景地図を取得できません。経路・信号・ランナーは座標平面で表示し、計算は続けます。');
  if (S.plan.kind === 'none' && S.courseKind === 'map' && S.confirmed) msgs.push(S.plan.reason);
  const b = $('map-banner');
  b.hidden = msgs.length === 0;
  b.innerHTML = msgs.map(esc).join('<br>');
}

// 設定パネル（入力欄を持つので、アクションのあとだけ描き直す）
function renderSetup(st) {
  const locked = st === 'playing' || S.routing;
  const demoOpts = DEMO_SCENARIOS.map((d) => `<option value="${d.id}" ${d.id === S.demoId ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
  const tools = [['start', '開始地点を置く'], ['end', '終了地点を置く'], ['via', '経由点追加']]
    .map(([k, l]) => `<button class="btn ${S.editTool === k ? 'on' : ''}" data-act="tool" data-v="${k}" ${S.confirmed ? 'disabled' : ''}>${l}</button>`).join('');
  const viaList = S.draft.via.map((_, i) => `<li>経由点 ${i + 1}
      <button class="mini" data-act="via-up" data-i="${i}" ${S.confirmed ? 'disabled' : ''}>↑</button>
      <button class="mini" data-act="via-down" data-i="${i}" ${S.confirmed ? 'disabled' : ''}>↓</button>
      <button class="mini" data-act="via-del" data-i="${i}" ${S.confirmed ? 'disabled' : ''}>削除</button></li>`).join('');
  const pre = S.courseKind === 'map' && !S.confirmed ? draftRoute(S.draft) : null;
  const lenText = S.route ? `${f1(S.route.lengthM)} m` : pre?.route ? `${f1(pre.route.lengthM)} m（未確定）` : '—';
  const errs = (S.courseKind === 'map' && !S.confirmed ? (pre?.route ? pre.errors : []) : S.routeErrors);

  let sigSection = '';
  if (S.courseKind === 'map' && S.confirmed) {
    const m = S.match;
    const rows = [];
    if (m) {
      S.adopted.forEach((a, i) => rows.push(`<li><label><input type="checkbox" data-act="exclude" data-k="${esc(a.key)}" checked> ${S.adopted.length > 1 ? `信号${i + 1} ` : ''}<b>${esc(a.signalId)}</b></label> 経路上 ${f1(a.s)} m・ずれ ${f1(a.offsetM)} m・周期 ${a.signal.cycleS}s</li>`));
      for (const e of m.excluded) {
        const re = e.code === 'manual' ? `<label><input type="checkbox" data-act="include" data-k="${esc(e.key)}"> ${esc(e.signalId)}</label>` : `${esc(e.signalId)}`;
        rows.push(`<li class="ex">${re} — 除外: ${esc(e.reason)}</li>`);
      }
    }
    sigSection = `<ul class="siglist">${rows.join('') || '<li class="muted">候補なし</li>'}</ul>
      ${m?.none ? `<div class="warn">この経路に対応する信号なし。<button class="btn" data-act="to-demo">固定デモに戻る</button> / 地図設定で経路を変えるか、許容距離を広げてください</div>` : ''}
      ${m?.errors.length ? `<div class="warn">${m.errors.map(esc).join('<br>')}</div>` : ''}
      ${S.adopted.length > 1 ? '<div class="muted">複数信号: route-core で連続走行します（BPM・時刻・歩き方を信号間で引き継ぎ）。</div>' : ''}`;
  } else if (S.courseKind === 'demo') {
    sigSection = '<div class="muted">固定デモの信号は既存シナリオの定義（模式コース）。</div>';
  } else {
    sigSection = '<div class="muted">経路を確定すると、近くの信号候補を表示します。</div>';
  }

  const single = S.plan.kind === 'single';
  const playable = single || S.plan.kind === 'route';
  const phaseVal = single ? S.plan.config.signal.phaseS : '';
  const calib = S.api.calib;
  $('setup-panel').innerHTML = `<fieldset ${locked ? 'disabled' : ''} class="fs">
    <section class="blk"><h4>1. コース</h4>
      <label class="rad"><input type="radio" name="ck" value="demo" ${S.courseKind === 'demo' ? 'checked' : ''}> 固定デモ（模式コース）</label>
      <select data-act="demo" ${S.courseKind === 'demo' ? '' : 'disabled'}>${demoOpts}</select>
      <label class="rad"><input type="radio" name="ck" value="map" ${S.courseKind === 'map' ? 'checked' : ''}> 地図でコース作成（置いた点を結ぶ。経路確定で道沿いに置き換え）</label>
      ${S.courseKind === 'map' ? `<div class="tools">${tools}
        <button class="btn" data-act="undo" ${S.confirmed ? 'disabled' : ''}>最後の点を取り消す</button>
        <button class="btn" data-act="clear">クリア</button></div>
        ${S.editTool ? `<div class="hint">地図をクリックして${{ start: '開始地点', end: '終了地点', via: '経由点（続けて追加できます）' }[S.editTool]}を置きます。点はドラッグで修正できます。</div>` : ''}
        <ul class="vialist">${viaList}</ul>
        <div>距離: <b>${lenText}</b></div>
        ${routeKindHtml()}
        ${errs.length ? `<div class="warn">${errs.map(esc).join('<br>')}</div>` : ''}
        ${S.confirmed ? '<button class="btn" data-act="unconfirm">経路を編集に戻す</button>' : `<button class="btn primary" data-act="confirm" ${pre?.route && !pre.errors.length && !S.routing ? '' : 'disabled'}>${S.routing ? '経路を取得中…' : '経路確定'}</button>`}` : ''}
    </section>
    <section class="blk"><h4>2. 信号</h4>${sigSection}
      <div class="row">許容距離 <input type="number" min="5" max="200" step="5" value="${S.toleranceM}" data-act="tol"> m <span class="muted small">【UI 設計値。精度保証ではない】</span></div>
      <div class="row">位相 phaseS <input type="number" step="1" value="${phaseVal}" data-act="phase" ${single ? '' : 'disabled'}> 秒
        <span class="muted small">模擬条件の編集（元: ${S.initialPhaseS ?? '—'}）。変更すると両走行をリセット</span></div>
    </section>
    <section class="blk diag"><h4>3. API（任意）</h4>
      <div class="row">URL <input type="text" class="wide" value="${esc(S.api.base)}" data-act="apiurl"></div>
      <div class="row"><button class="btn" data-act="api-signals">参考信号を取得</button>
        <button class="btn" data-act="use-fixture" ${S.candidatesOrigin === 'fixture' ? 'disabled' : ''}>fixture に戻す</button>
        <button class="btn" data-act="api-calib">校正値を取得</button>
        <button class="btn" data-act="apply-calib" ${calib ? '' : 'disabled'}>校正値を適用</button>
        ${S.runnerOverride ? '<button class="btn" data-act="clear-calib">校正値を外す</button>' : ''}</div>
      <div class="small ${S.api.ok === false ? 'warn' : 'muted'}">${esc(S.api.message || '未取得（起動条件ではありません。固定デモはそのまま動きます）')}</div>
      <div class="small muted">候補の出所: ${S.candidatesOrigin === 'api' ? 'API' : '模擬信号 fixture'}（${S.candidates.length} 件）</div>
    </section>
    <section class="blk"><button class="btn primary big" data-act="apply" ${playable ? '' : 'disabled'}>設定を適用して開始</button>
      ${S.plan.kind === 'invalid' ? `<div class="warn">${esc(S.plan.reason)}</div>` : ''}
      ${S.plan.kind === 'none' ? `<div class="muted">${esc(S.plan.reason)}</div>` : ''}
      ${S.error ? `<div class="warn">${esc(S.error)}</div>` : ''}</section>
  </fieldset>`;
}

// ---------------------------------------------------------------- 描画（毎 tick）
function renderLive() {
  const pb = S.pb;
  const st = statusOf(S);
  const chip = $('chip');
  if (chip) {
    chip.className = `chip st-${st}`;
    chip.textContent = pb?.lagging ? '計算中' : STATUS_LABEL[st];
  }
  const clock = $('clock');
  if (clock) clock.textContent = pb ? `模擬時刻 ${f1(pb.timeS)} s / 最大 1800 s` : '模擬時刻 —';

  const infoAt = (i) => S.adopted[Math.min(i, S.adopted.length - 1)] ?? null;
  if (!pb) {
    $('sigbox').innerHTML = S.adopted[0] ? signalDetailHtml(S.adopted[0], 0) : '';
    $('run-panel').innerHTML = `<div class="card empty"><h3>比較は未開始</h3>
      <p>設定を適用すると、通常と RUNWAVE の 2 走行を並べて表示します。</p></div>`;
    $('bottom').innerHTML = resultsHtml({ phase: 'ready', live: null, expected: S.expected });
    return;
  }
  const t = pb.timeS;
  const goalX = isRouteConfig(pb.config) ? pb.config.goalM : pb.config.route.goalX;
  const info = infoAt(runwaveIdx());
  const views = { normal: runnerView(pb.pair.normal, t), runwave: runnerView(pb.pair.runwave, t) };
  $('run-panel').innerHTML = `${runnerCard({ lane: 'normal', title: '通常走行', view: views.normal, goalX })}
    ${runnerCard({ lane: 'runwave', title: 'RUNWAVE', view: views.runwave, goalX })}`;
  $('sigbox').innerHTML = signalDetailHtml(info, t);

  const done = pb.status === 'completed';
  const live = { normal: { ...views.normal, ...pick(summaryOf(pb.pair.normal)) }, runwave: { ...views.runwave, ...pick(summaryOf(pb.pair.runwave)) } };
  const matches = done && S.expected ? matchesExpected(pb.pair, S.expected) : null;
  $('bottom').innerHTML = resultsHtml({ phase: done ? 'done' : st === 'ready' ? 'ready' : 'running', live, expected: S.expected, matches, timedOut: pb.timedOut,
    perSignal: isRouteConfig(pb.config) ? { normal: views.normal.perSignal, runwave: views.runwave.perSignal } : null });

  // 地図: ランナーと信号色（位置は計算上の距離 → 経路上の距離へ変換した描画用）
  if (S.route) {
    const pos = (x) => pointAtDistance(S.route, x * S.factor);
    S.overlapShift = mapView.setRunners({ normal: pos(pb.pair.normal.state.x), runwave: pos(pb.pair.runwave.state.x) });
    const colors = {};
    if (isRouteConfig(pb.config)) for (const g of pb.config.signals) colors[g.id] = core.signalAt(g.signal, t).color;
    else if (info) colors[info.key] = core.signalAt(pb.config.signal, t).color;
    mapView.setSignalColors(colors);
  }
}
const runwaveIdx = () => (isRouteConfig(S.pb.config) ? S.pb.pair.runwave.state.signalIndex : 0);
const pick = (s) => ({ totalTimeS: s.totalTimeS, walkCount: s.walkCount, walkTimeS: s.walkTimeS, walkDistanceM: s.walkDistanceM });

// ---------------------------------------------------------------- 操作
function saveReport() {
  const pb = S.pb;
  if (!pb) return;
  const done = pb.status === 'completed';
  const summaries = { normal: summaryOf(pb.pair.normal), runwave: summaryOf(pb.pair.runwave) };
  const rep = buildReport({
    ...versions(),
    perSignal: isRouteConfig(pb.config) ? { normal: summaries.normal.signals, runwave: summaries.runwave.signals } : null,
    gitSha: META.gitSha,
    courseKind: S.courseKind,
    route: S.route,
    signals: { adopted: S.adopted, excluded: S.match?.excluded ?? [] },
    config: pb.config,
    expected: S.expected,
    pair: pb.pair,
    summaries,
    events: pb.events,
    apiInfo: currentApiInfo(),
    termination: done ? (pb.timedOut ? 'timeLimit' : 'finished') : 'incomplete',
    matches: done && S.expected ? matchesExpected(pb.pair, S.expected) : null,
  });
  download(JSON.stringify(rep, null, 2), 'application/json', reportFileName());
}

/** データの出所（結果 JSON と CSV で共通）。固定デモ・fixture は source='fixture'、取得失敗の記録は lastApiAttempt に残す */
function currentApiInfo() {
  const lastApiAttempt = S.api.lastAttempt;
  if (S.candidatesOrigin === 'api') return buildApiInfo({ source: 'api', base: S.api.base, url: S.api.signalsUrl, at: S.api.signalsAt, note: '車両用データ由来・位相は仮の参考信号', lastApiAttempt });
  const note = S.courseKind === 'demo' ? '固定デモ（模式コース）の信号。既存シナリオの定義で、実 API の成功応答ではない' : '模擬信号 fixture（推定データ）。実 API の成功応答ではない';
  return buildApiInfo({ source: 'fixture', base: S.api.base, note, lastApiAttempt });
}

function download(text, type, name) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function saveCsv() {
  const pb = S.pb;
  if (!pb) return;
  const info = currentApiInfo();
  download(buildTimeSeriesCsv(pb.series, { source: info.source, isEstimated: anyEstimated(S.adopted) }), 'text/csv;charset=utf-8', csvFileName());
}

async function doApiSignals() {
  S.api.message = '取得中…';
  renderAll();
  const r = await fetchSignals(S.api.base);
  S.api.at = r.at;
  S.api.lastAttempt = { ok: r.ok, url: r.url ?? null, at: r.at, error: r.error ?? null };
  if (!r.ok) {
    S.api.ok = false;
    // 取得失敗時は黙って API 候補を残さず、fixture（推定データ）に戻して明示する
    S.candidates = FIXTURE_SIGNALS;
    S.candidatesOrigin = 'fixture';
    S.manualExclude = new Set();
    S.phaseS = null;
    S.api.message = apiFailureMessage('参考信号', r, { usingFixture: true });
    if (S.courseKind === 'map' && S.confirmed) recompute();
    else renderAll();
    return;
  }
  S.api.signalsAt = r.at;
  S.api.signalsUrl = r.url;
  S.api.ok = true;
  S.api.message = `取得成功 ${r.url} ${r.at.slice(11, 19)}: 候補 ${r.candidates.length} 件${r.invalid.length ? `（不正 ${r.invalid.length} 件は除外）` : ''}。「地図でコース作成」で近い信号を対応付けます。`;
  S.candidates = r.candidates;
  S.candidatesOrigin = 'api';
  S.manualExclude = new Set();
  S.phaseS = null;
  if (S.courseKind === 'map' && S.confirmed) recompute();
  else renderAll();
}

async function doApiCalib() {
  const r = await fetchCalibration(S.api.base);
  S.api.at = r.at;
  if (!r.ok) {
    S.api.ok = false;
    S.api.calib = null;
    S.api.message = `${apiFailureMessage('校正値', r, { usingFixture: false })} 校正値は適用されず、既定の走者設定のままです。`;
  } else {
    S.api.ok = true;
    S.api.calib = r.runner;
    S.api.message = `校正値を取得: 歩幅 ${r.runner.strideM} m・通常 ${r.runner.baseBpm} 歩/分（「校正値を適用」で反映）`;
  }
  renderAll();
}

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const pb = S.pb;
  switch (act) {
    case 'play': pb?.play(); S.autoPaused = false; renderAll(); break;
    case 'pause': pb?.pause(); renderAll(); break;
    case 'reset': pb?.reset(); mapView.clearRunners(); renderAll(); break;
    case 'speed': pb?.setSpeed(Number(el.dataset.v)); renderBar(statusOf(S)); break;
    case 'save': saveReport(); break;
    case 'save-csv': saveCsv(); break;
    case 'tool': S.editTool = S.editTool === el.dataset.v ? null : el.dataset.v; mapView.setEditMode(S.editTool); renderAll(); break;
    case 'undo':
      if (S.draft.via.length) S.draft = removeVia(S.draft, S.draft.via.length - 1);
      else if (S.draft.end) S.draft = { ...S.draft, end: null };
      else S.draft = { ...S.draft, start: null };
      afterDraftChange();
      break;
    case 'clear': S.draft = { start: null, end: null, via: [] }; S.confirmed = false; S.confirmedRoute = null; S.routeInfo = null; S.phaseS = null; S.manualExclude = new Set(); recompute(); break;
    case 'via-up': S.draft = reorderVia(S.draft, Number(el.dataset.i), -1); afterDraftChange(); break;
    case 'via-down': S.draft = reorderVia(S.draft, Number(el.dataset.i), 1); afterDraftChange(); break;
    case 'via-del': S.draft = removeVia(S.draft, Number(el.dataset.i)); afterDraftChange(); break;
    case 'confirm': confirmRoute(); break;
    case 'unconfirm': S.confirmed = false; S.confirmedRoute = null; S.routeInfo = null; S.phaseS = null; recompute(); break;
    case 'to-demo': S.courseKind = 'demo'; S.confirmed = false; S.confirmedRoute = null; S.routeInfo = null; S.phaseS = null; recompute({ autoApply: true }); break;
    case 'apply': applyStart(true); break;
    case 'api-signals': doApiSignals(); break;
    case 'api-calib': doApiCalib(); break;
    case 'apply-calib': S.runnerOverride = { ...S.api.calib }; S.api.message = '校正値を適用しました（両走行をリセット）'; recompute({ autoApply: S.courseKind === 'demo' }); break;
    case 'clear-calib': S.runnerOverride = null; recompute({ autoApply: S.courseKind === 'demo' }); break;
    case 'use-fixture': S.candidates = FIXTURE_SIGNALS; S.candidatesOrigin = 'fixture'; S.manualExclude = new Set(); S.api.message = 'fixture に戻しました'; if (S.confirmed) recompute(); else renderAll(); break;
    default: break;
  }
}

function onChange(e) {
  const el = e.target;
  const act = el.dataset?.act;
  if (el.name === 'ck') {
    S.courseKind = el.value;
    S.phaseS = null;
    S.editTool = null;
    recompute({ autoApply: S.courseKind === 'demo' });
    return;
  }
  switch (act) {
    case 'demo': S.demoId = el.value; S.phaseS = null; recompute({ autoApply: true }); break;
    case 'tol': {
      const v = Number(el.value);
      if (Number.isFinite(v) && v >= 5 && v <= 200) { S.toleranceM = v; S.phaseS = null; recompute(); } else renderAll();
      break;
    }
    case 'phase': {
      const v = Number(el.value);
      if (el.value !== '' && Number.isFinite(v)) { S.phaseS = v; recompute({ autoApply: S.courseKind === 'demo' }); } else renderAll();
      break;
    }
    case 'apiurl': S.api.base = el.value.trim(); break;
    case 'exclude': S.manualExclude.add(el.dataset.k); S.phaseS = null; recompute(); break;
    case 'include': S.manualExclude.delete(el.dataset.k); S.phaseS = null; recompute(); break;
    default: break;
  }
}

document.addEventListener('click', onClick);
document.addEventListener('change', onChange);
$('tab-setup').addEventListener('click', () => { S.rec = false; S.view = 'setup'; renderAll(); mapView.invalidate(); });
$('tab-run').addEventListener('click', () => { S.view = 'run'; renderAll(); });
$('rec-toggle').addEventListener('click', () => {
  S.rec = !S.rec;
  if (S.rec) S.view = 'run';
  renderAll();
  setTimeout(() => mapView.invalidate(), 50);
});

// バックグラウンド化で自動一時停止（復帰時は手動再開。隠れていた時間はまとめて計算しない）
document.addEventListener('visibilitychange', () => {
  if (document.hidden && S.pb?.status === 'playing') {
    S.pb.pause();
    S.autoPaused = true;
    renderAll();
  }
});

let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;
  requestAnimationFrame(loop);
  const pb = S.pb;
  if (pb && pb.status === 'playing') {
    try {
      const before = pb.status;
      const n = pb.frame(dt);
      if (n > 0 || pb.lagging) renderLive();
      if (pb.status !== before) renderAll();
    } catch (e) {
      // 計算・描画で例外が出ても画面を止めない。理由を出して一時停止する
      pb.pause();
      S.error = `計算中にエラー: ${e.message}`;
      renderAll();
    }
  }
}

// 起動: 即再生可能な固定デモ B（API 取得を起動条件にしない）
recompute({ autoApply: true });
requestAnimationFrame(loop);

// デバッグ・ブラウザ確認用（読み取り）
window.__runwave = { S, mapView, renderAll };
