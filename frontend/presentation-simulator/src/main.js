// 初期化・操作イベント・描画ループ。計算は simulation.js（core）に任せ、描画は同じフレームの view-model だけを読む。
// ズーム・字幕は表示だけの演出（state・時計・tick には触れない）。
import { SCENARIO_LIST, getScenario, highlightsFor } from './scenarios.js';
import { createSession, SPEEDS, DEMO_SPEED } from './simulation.js';
import { buildFrame } from './demo-view-model.js';
import { createExplanation, startExplanation, resetDemo } from './explanation-controller.js';
import { createWorldView, createHud, createProgressBar, WORLD_VIEW, RUNNER_X } from './world-view.js';
import { createFlowView } from './flow-view.js';
import { createPhoneView } from './phone-view.js';
import { createWatchView } from './watch-view.js';
import { STATUS_NAMES } from './status-names.js';
import { createTour } from './tour.js';
import { zoomFor, zoomCss } from './zoom.js';

const $ = (id) => document.getElementById(id);
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

let scenarioId = 'B';
const session = createSession(getScenario('B').config);
const explanation = createExplanation();

let world = null;
let progress = null;
const hud = createHud($('hud'), $('signal-panel'));
const flow = createFlowView($('flow'));
const phone = createPhoneView(flow.phoneSlot);
const watch = createWatchView(flow.watchSlot);

let prevKey = null;
let hlIdx = -1;
let jumpUntil = 0;
let jumpText = '';
let zoomOn = true;
let tourStartMs = null;
let tourMeasuredS = null;

function mountWorld() {
  world = createWorldView($('world-svg'), session.config);
  progress = createProgressBar($('progress'), session.config);
}
mountWorld();

// 表示の演出（ズーム・字幕・発光）を即座に初期状態へ戻す
function resetPresentation() {
  const z = $('zoom');
  z.classList.add('snap');
  z.style.transform = 'none';
  requestAnimationFrame(() => requestAnimationFrame(() => z.classList.remove('snap')));
  lastStage = null;
  zoomRects = null;
  prevKey = null;
  jumpUntil = 0;
  explanation.clear();
}

const tour = createTour({
  session,
  explanation,
  onCut: () => { prevKey = null; explanation.clear(); },
  onSegment: (sg) => {
    scenarioId = sg.id;
    hlIdx = -1;
    mountWorld();
    resetPresentation();
  },
});

// ---------- 操作の組み立て ----------
function buildControls() {
  const sp = $('grp-speed');
  sp.innerHTML = '';
  for (const key of [DEMO_SPEED, ...SPEEDS]) {
    const b = document.createElement('button');
    b.dataset.speed = String(key);
    b.textContent = key === DEMO_SPEED ? '30秒' : `${key}倍`;
    b.addEventListener('click', () => { if (!tour.active) session.setSpeed(key); });
    sp.appendChild(b);
  }
  const sc = $('grp-scn');
  sc.innerHTML = '';
  const tb = document.createElement('button');
  tb.dataset.scn = 'tour';
  tb.textContent = '通しデモ';
  tb.title = 'B → A → W を自動で続けて再生';
  tb.addEventListener('click', () => { if (!session.running) enterTour(); });
  sc.appendChild(tb);
  for (const s of SCENARIO_LIST) {
    const b = document.createElement('button');
    b.dataset.scn = s.id;
    b.textContent = s.id;
    b.title = `${s.name}：${s.blurb}`;
    b.addEventListener('click', () => switchScenario(s.id));
    sc.appendChild(b);
  }
}
buildControls();

function enterTour() {
  tourStartMs = null;
  tourMeasuredS = null;
  explanation.cancel();
  session.setHold(false);
  tour.arm();
  showMsg(null);
}

function switchScenario(id) {
  if (session.running) return; // シナリオ切替は停止中のみ
  const sc = getScenario(id);
  try {
    explanation.cancel();
    resetDemo(session, explanation, sc.config);
  } catch (e) {
    showMsg(`この条件では開始できません: ${e.message}`);
    return;
  }
  tour.stop();
  session.setSpeed(DEMO_SPEED);
  scenarioId = id;
  hlIdx = -1;
  showMsg(null);
  mountWorld();
  resetPresentation();
}

function doReset() {
  if (tour.active) { enterTour(); resetPresentation(); return; }
  try {
    resetDemo(session, explanation, session.config);
  } catch (e) {
    showMsg(`リセットできません: ${e.message}`);
    return;
  }
  hlIdx = -1;
  showMsg(null);
  resetPresentation();
}

function showMsg(text) {
  const el = $('world-msg');
  el.hidden = !text;
  if (text) el.textContent = text;
}

$('btn-play').addEventListener('click', () => {
  if (tour.active) tour.notePlay(performance.now());
  else session.play();
});
$('btn-pause').addEventListener('click', () => { session.pause(); tour.notePause(); });
$('btn-reset').addEventListener('click', doReset);
$('btn-explain').addEventListener('click', () => {
  if (tour.active) tour.notePause(); // 解説のあとは自動再開せず、再生は操作者が行う
  startExplanation(session, explanation, performance.now());
});
$('btn-jump').addEventListener('click', () => {
  const hs = highlightsFor(scenarioId);
  if (tour.active || !hs.length || session.running || explanation.active) return;
  hlIdx = (hlIdx + 1) % hs.length;
  const h = hs[hlIdx];
  session.jumpTo(h.tick); // 初期状態から core を逐次 step して得た state
  prevKey = null;
  explanation.clear();
  jumpText = `場面ジャンプ：${h.label}`;
  jumpUntil = performance.now() + 4000;
});
$('btn-zoom').addEventListener('click', () => {
  zoomOn = !zoomOn;
  $('btn-zoom').setAttribute('aria-pressed', String(zoomOn));
  setText($('btn-zoom'), `ズーム演出 ${zoomOn ? 'ON' : 'OFF'}`);
});

// タブ非表示で自動停止。ズーム・字幕・演出キューも即座に消す（復帰しても停止を維持し、裏で経過した時間は加算しない）
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  explanation.cancel();
  session.setHold(false);
  tour.interrupt();
  session.hide();
  tour.notePause();
  resetPresentation();
});

// ---------- ズーム領域（ステージ座標。transform の影響を受けない offset から求める） ----------
function offsetIn(el, root) {
  let x = 0; let y = 0; let e = el;
  while (e && e !== root) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}
const union = (a, b) => {
  const x = Math.min(a.x, b.x); const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
function measureRects() {
  const root = $('zoom');
  const wv = offsetIn($('world-svg'), root);
  const sc = Math.min(wv.w / WORLD_VIEW.W, wv.h / WORLD_VIEW.H);
  const ox = wv.x + (wv.w - WORLD_VIEW.W * sc) / 2;
  const oy = wv.y + (wv.h - WORLD_VIEW.H * sc) / 2;
  const runner = { x: ox + (RUNNER_X - 170) * sc, y: oy + 130 * sc, w: 340 * sc, h: 330 * sc };
  return {
    world: union(runner, offsetIn($('signal-panel'), root)),
    input: offsetIn(document.querySelector('[data-block="input"]'), root),
    judge: offsetIn(document.querySelector('[data-block="judge"]'), root),
    output: offsetIn(document.querySelector('[data-block="output"]'), root),
  };
}
let zoomRects = null;
let lastStage = null;

// ---------- 描画ループ（1 本だけ） ----------
function render(now) {
  session.frame(now);
  const ex = tour.update(now); // 解説の進行（通しデモ外でも tickExplanation を内部で呼ぶ）
  const status = session.status;
  const frame = buildFrame(session.state, session.config, { speed: session.multiplier, status });
  const stage = ex.active ? ex.stage : null;

  // 判断が変わった瞬間に入力→判定→端末を短く発光（通信遅延は入れない）
  if (session.running && prevKey !== null && prevKey !== frame.decisionKey) {
    explanation.addPulse('flow', now);
    explanation.addPulse('haptic', now);
    explanation.addPulse('glow', now);
  }
  prevKey = frame.decisionKey;
  const pulses = explanation.activePulses(now);

  // ズーム（表示だけ）
  if (stage !== lastStage) {
    lastStage = stage;
    if (stage && zoomOn) { zoomRects = measureRects(); }
    $('zoom').style.transform = zoomCss(zoomFor(stage, zoomOn, zoomRects));
  }

  const paused = !session.running;
  world.update(frame, { paused });
  hud.update(frame);
  progress.update(frame);
  flow.update(frame, { stage, pulses });
  const glow = pulses.includes('glow') || stage === 'output';
  phone.update(frame, { glow });
  watch.update(frame, { haptic: pulses.includes('haptic'), glow });

  // タイトル（通しデモの切替時）
  const tt = $('tour-title');
  tt.hidden = tour.title === null;
  if (!tt.hidden) setText(tt, tour.title);
  const cutEl = $('tour-cut');
  cutEl.hidden = tour.cut === null;
  if (!cutEl.hidden) setText(cutEl, tour.cut.text);

  // 通しデモの実測時間（最初の再生ボタン〜最後の区間の終わり）
  if (tour.phase === 'title' && tourStartMs === null) tourStartMs = now - 0;
  if (tour.phase === 'done' && tourMeasuredS === null && tourStartMs !== null) tourMeasuredS = (now - tourStartMs) / 1000;

  // ヘッダー・操作
  const sc = getScenario(scenarioId);
  if (tour.active) {
    const p = tour.plan;
    setText($('scn-label'), `通しデモ ${tour.index + 1}/${p.segments.length}：${tour.segment.title}　約${Math.round(p.totalS)}秒（計画 ${p.totalS.toFixed(1)}秒）`);
  } else {
    setText($('scn-label'), `${sc.name}　${sc.blurb}`);
  }
  const pill = tour.phase === 'title' ? 'タイトル' : tour.phase === 'cut' ? 'カット' : tour.phase === 'done' ? '完了' : STATUS_NAMES[status] ?? status;
  setText($('status-pill'), pill);
  $('status-pill').dataset.status = status;
  setText($('clock'), `経過 ${frame.t.toFixed(1)} 秒`);
  setText($('speed-label'), session.speedLabel);
  const done = status === 'done' || status === 'limit';
  const blockedPlay = status === 'error' || status === 'playing' || status === 'explaining' || tour.phase === 'title' || tour.phase === 'cut' || (done && !tour.active);
  $('btn-play').disabled = blockedPlay;
  $('btn-pause').disabled = status !== 'playing';
  $('btn-explain').disabled = done || explanation.active || tour.phase === 'title' || tour.phase === 'cut' || tour.phase === 'done';
  const hs = highlightsFor(scenarioId);
  $('btn-jump').disabled = tour.active || hs.length === 0 || status === 'playing' || explanation.active;
  $('btn-jump').title = hs.length ? '次の見せ場：' + hs[(hlIdx + 1) % hs.length].label : 'この条件では見せ場がありません';
  for (const b of $('grp-speed').children) {
    b.classList.toggle('on', !tour.active && b.dataset.speed === String(session.speed));
    b.disabled = tour.active;
  }
  for (const b of $('grp-scn').children) {
    b.classList.toggle('on', tour.active ? b.dataset.scn === 'tour' : b.dataset.scn === scenarioId);
    b.disabled = status === 'playing';
  }
  const jb = $('jump-badge');
  jb.hidden = now > jumpUntil;
  if (!jb.hidden) setText(jb, jumpText);
  if (session.error) showMsg(`エラー: ${session.error}`);

  // 結果（最後に小さく）
  const res = $('result');
  if (tour.phase === 'done' && tourMeasuredS !== null) {
    setText(res, `通しデモ 実測 ${tourMeasuredS.toFixed(1)}秒`);
  } else if (status === 'done') {
    const s = session.summary();
    setText(res, `モデル上の結果：停止 ${s.stops}回／停止時間 ${s.stopTimeS.toFixed(1)}秒／所要 ${s.totalTimeS.toFixed(1)}秒`);
  } else if (status === 'limit') {
    setText(res, '計算上限：結果未確定');
  } else {
    setText(res, '');
  }
  requestAnimationFrame(render);
}

tour.arm(); // 初期表示は通しデモ（B の頭で待機。再生ボタンで開始）
requestAnimationFrame(render);

// ---------- 1920×1080 の固定ステージを画面に収める ----------
function fit() {
  const stage = $('stage');
  const k = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  stage.style.transform = `scale(${k})`;
  $('viewport').style.width = `${1920 * k}px`;
  $('viewport').style.height = `${1080 * k}px`;
}
window.addEventListener('resize', fit);
fit();
