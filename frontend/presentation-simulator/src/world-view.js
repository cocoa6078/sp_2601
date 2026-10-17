// 道路・人物・横断歩道・信号・HUD（SVG）。位置は state.x（frame.world.x）を座標へ変換するだけ。
// 足のアニメーションは位置と無関係（CSS）。描画の演出で到着時刻を変えない。
import { PX_PER_M, RUNNER_SCALE } from './demo-view-model.js';
const NS = 'http://www.w3.org/2000/svg';
const W = 1888;
const H = 520;
export const WORLD_VIEW = { W, H };
const RUNNER_SCREEN_X = 0.3 * W;
export const RUNNER_X = RUNNER_SCREEN_X;
const ROAD_TOP = 330;
const ROAD_BOTTOM = 470;
const FEET_Y = 452;

function svg(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
const setAttr = (el, k, v) => { if (el.getAttribute(k) !== String(v)) el.setAttribute(k, v); };
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

export function createWorldView(container, config) {
  container.innerHTML = '';
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'world-svg', role: 'img', 'aria-label': '仮想道路を走る人物と歩行者信号' }, container);
  const { crossingX, goalX } = config.route;
  const crossingM = config.signal.crossingM;

  // 背景（空・遠景ビル）
  const defs = svg('defs', {}, root);
  const g1 = svg('linearGradient', { id: 'sky', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  svg('stop', { offset: '0%', 'stop-color': '#0a1a2e' }, g1);
  svg('stop', { offset: '100%', 'stop-color': '#16304a' }, g1);
  svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#sky)' }, root);
  const far = svg('g', { class: 'far' }, root);
  for (let i = 0; i < 14; i++) {
    const w = 90 + ((i * 37) % 70);
    const h = 90 + ((i * 53) % 130);
    svg('rect', { x: i * 200, y: ROAD_TOP - 20 - h, width: w, height: h, fill: '#102740', opacity: 0.9 }, far);
    for (let j = 0; j < 3; j++) svg('rect', { x: i * 200 + 14 + j * 24, y: ROAD_TOP - h + 10, width: 8, height: 10, fill: '#2b4d73', opacity: 0.7 }, far);
  }
  // 道路（静止）
  svg('rect', { x: 0, y: ROAD_TOP - 14, width: W, height: 14, fill: '#1b3a57' }, root); // 歩道
  svg('rect', { x: 0, y: ROAD_TOP, width: W, height: ROAD_BOTTOM - ROAD_TOP, fill: '#0e2237' }, root);
  svg('rect', { x: 0, y: ROAD_BOTTOM, width: W, height: H - ROAD_BOTTOM, fill: '#081421' }, root);

  // 世界座標（カメラで平行移動）
  const scene = svg('g', { class: 'scene' }, root);
  const worldLeft = -40 * PX_PER_M;
  const worldRight = (goalX + 40) * PX_PER_M;
  for (let m = -40; m <= goalX + 40; m += 10) {
    svg('rect', { x: m * PX_PER_M, y: (ROAD_TOP + ROAD_BOTTOM) / 2 + 20, width: 4 * PX_PER_M, height: 4, fill: '#2f5679', opacity: 0.7 }, scene);
  }
  // 横断歩道（縞）と判定線
  const cx = crossingX * PX_PER_M;
  const cw = Math.max(crossingM * PX_PER_M, 40);
  svg('rect', { x: cx, y: ROAD_TOP, width: cw, height: ROAD_BOTTOM - ROAD_TOP, fill: '#142c45' }, scene);
  for (let x = cx + 6; x < cx + cw - 10; x += 26) svg('rect', { x, y: ROAD_TOP + 4, width: 14, height: ROAD_BOTTOM - ROAD_TOP - 8, fill: '#e8f1fb', opacity: 0.85 }, scene);
  svg('line', { x1: cx, x2: cx, y1: ROAD_TOP - 40, y2: ROAD_BOTTOM + 20, stroke: '#5ef2c1', 'stroke-width': 2, 'stroke-dasharray': '6 6', opacity: 0.8 }, scene);
  const crossLabel = svg('text', { x: cx + cw / 2, y: ROAD_BOTTOM + 44, 'text-anchor': 'middle', class: 'svg-label' }, scene);
  crossLabel.textContent = '横断歩道';
  // スタート／ゴール
  svg('rect', { x: 0, y: ROAD_TOP, width: 6, height: ROAD_BOTTOM - ROAD_TOP, fill: '#9fb4c8' }, scene);
  const sl = svg('text', { x: 0, y: ROAD_BOTTOM + 44, 'text-anchor': 'middle', class: 'svg-label' }, scene);
  sl.textContent = 'スタート';
  const gx = goalX * PX_PER_M;
  svg('rect', { x: gx, y: ROAD_TOP, width: 14, height: ROAD_BOTTOM - ROAD_TOP, fill: '#f5faff', opacity: 0.9 }, scene);
  for (let y = ROAD_TOP; y < ROAD_BOTTOM; y += 20) svg('rect', { x: gx, y, width: 14, height: 10, fill: '#081421' }, scene);
  const gl = svg('text', { x: gx + 7, y: ROAD_BOTTOM + 44, 'text-anchor': 'middle', class: 'svg-label' }, scene);
  gl.textContent = 'ゴール';
  // 信号柱（横断歩道の手前）
  const px = cx - 36;
  svg('rect', { x: px - 4, y: 150, width: 8, height: ROAD_TOP - 150, fill: '#6f8aa6' }, scene);
  const head = svg('g', { transform: `translate(${px},150)` }, scene);
  svg('rect', { x: -34, y: -112, width: 68, height: 116, rx: 12, fill: '#0b1a2b', stroke: '#6f8aa6', 'stroke-width': 3 }, head);
  const lamps = {
    red: svg('circle', { cx: 0, cy: -84, r: 15, class: 'lamp lamp-red' }, head),
    flashing: svg('circle', { cx: 0, cy: -50, r: 15, class: 'lamp lamp-flashing' }, head),
    green: svg('circle', { cx: 0, cy: -16, r: 15, class: 'lamp lamp-green' }, head),
  };

  // 人物（画面固定位置。シーン側が動く）
  const runnerG = svg('g', { class: 'runner', transform: `translate(${RUNNER_SCREEN_X},${FEET_Y}) scale(${RUNNER_SCALE})` }, root);
  svg('ellipse', { cx: 0, cy: 1, rx: 14, ry: 3, fill: '#000', opacity: 0.35 }, runnerG);
  const body = svg('g', { class: 'body' }, runnerG);
  const mk = (cls, x, y, x2, y2) => {
    const outer = svg('g', { transform: `translate(${x},${y})` }, body);
    const inner = svg('g', { class: cls }, outer);
    svg('line', { x1: 0, y1: 0, x2, y2, class: 'limb' }, inner);
    return inner;
  };
  const legB = mk('leg legB', 0, -22, 0, 22);
  const armB = mk('arm armB', 0, -42, 0, 17);
  svg('line', { x1: 0, y1: -22, x2: 2, y2: -44, class: 'limb torso' }, body);
  svg('circle', { cx: 3, cy: -52, r: 7, class: 'head' }, body);
  const legA = mk('leg legA', 0, -22, 0, 22);
  const armA = mk('arm armA', 0, -42, 0, 17);
  const limbs = [legA, legB, armA, armB];

  // 人物ラベル
  const label = svg('g', { class: 'runner-label', transform: `translate(${RUNNER_SCREEN_X},196)` }, root);
  svg('rect', { x: -170, y: -62, width: 340, height: 118, rx: 18, class: 'label-box' }, label);
  const l1 = svg('text', { x: 0, y: -14, 'text-anchor': 'middle', class: 'label-main' }, label);
  const l2 = svg('text', { x: 0, y: 34, 'text-anchor': 'middle', class: 'label-sub' }, label);

  const api = {
    /** frame = buildFrame の結果。paused=true で足を止める（位置は変えない） */
    update(frame, { paused }) {
      const w = frame.world;
      const camX = w.x * PX_PER_M - RUNNER_SCREEN_X;
      setAttr(scene, 'transform', `translate(${-camX.toFixed(1)},0)`);
      setAttr(far, 'transform', `translate(${(-((camX * 0.25) % 400)).toFixed(1)},0)`);
      for (const [k, el] of Object.entries(lamps)) {
        const on = frame.signal.color === k;
        setAttr(el, 'class', `lamp lamp-${k}${on ? ' on' : ''}`);
      }
      setText(l1, w.worldLabel ?? `現在${w.bpmText} BPM`);
      setText(l2, w.stateLabel);
      // 動作クラス（位置とは無関係）
      const cycle = w.cycleS ? Math.round(w.cycleS * 20) / 20 : 0.8;
      const cls = `runner ${w.action}${paused ? ' halted' : ''}${w.action === 'walk' ? ' is-walk' : ''}`;
      setAttr(runnerG, 'class', cls);
      runnerG.style.setProperty('--cycle', `${cycle}s`);
      return limbs;
    },
    width: W,
  };
  return api;
}

/** HUD（横断地点まで／現在BPM／目標BPM）と信号パネル（HTML） */
export function createHud(hudEl, signalEl) {
  hudEl.innerHTML = `
    <div class="chip"><span class="chip-k">横断地点まで</span><span class="chip-v" data-k="distance"></span></div>
    <div class="chip"><span class="chip-k">現在BPM</span><span class="chip-v big" data-k="bpm"></span><span class="chip-u">歩/分</span></div>
    <div class="chip"><span class="chip-k">目標BPM</span><span class="chip-v big mint" data-k="target"></span><span class="chip-u">歩/分</span></div>`;
  signalEl.innerHTML = `
    <div class="sig-lamps"><i data-c="red"></i><i data-c="flashing"></i><i data-c="green"></i></div>
    <div class="sig-text"><span class="sig-label" data-k="label"></span><span class="sig-rem" data-k="rem"></span></div>`;
  const q = (root, k) => root.querySelector(`[data-k="${k}"]`);
  const els = { distance: q(hudEl, 'distance'), bpm: q(hudEl, 'bpm'), target: q(hudEl, 'target'), label: q(signalEl, 'label'), rem: q(signalEl, 'rem') };
  const lamps = [...signalEl.querySelectorAll('i')];
  return {
    update(frame) {
      setText(els.distance, frame.world.distanceText);
      setText(els.bpm, frame.world.bpmText);
      setText(els.target, frame.world.targetText);
      setText(els.label, frame.signal.label);
      setText(els.rem, `残り${frame.signal.remainingText}`);
      signalEl.dataset.color = frame.signal.color;
      for (const l of lamps) l.classList.toggle('on', l.dataset.c === frame.signal.color);
    },
  };
}

/** 進行バー（スタート・横断地点・ゴール・人物の点）。位置は state.x。横断歩道までの相対距離が一目でわかる */
export function createProgressBar(el, config) {
  const { crossingX, goalX } = config.route;
  const pct = (x) => `${(x / goalX) * 100}%`;
  el.innerHTML = `
    <div class="pb-track"><div class="pb-fill"></div>
      <span class="pb-mark start" style="left:0%"><i></i><em>スタート</em></span>
      <span class="pb-mark cross" style="left:${pct(crossingX)}"><i></i><em>横断地点 ${crossingX}m</em></span>
      <span class="pb-mark goal" style="left:100%"><i></i><em>ゴール</em></span>
      <span class="pb-dot"></span></div>`;
  const dot = el.querySelector('.pb-dot');
  const fill = el.querySelector('.pb-fill');
  return {
    update(frame) {
      const p = Math.min(1, Math.max(0, frame.world.x / goalX)) * 100;
      const v = `${p.toFixed(2)}%`;
      if (dot.style.left !== v) { dot.style.left = v; fill.style.width = v; }
    },
  };
}
