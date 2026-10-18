// iPhone アプリの走行中画面を、ブラウザ内で見た目と項目を寄せて再現するパネル（模擬表示）。
// 元の画面: frontend/watch-app/Runwave/ContentView.swift（走行中）・WorkoutRouteTracker.swift（WorkoutRouteMap）・
//           SimulatorSignalSystem.swift（SimulatorSignalCard）・RouteNavigation.swift（案内カード）。Swift は読み取りのみ。
// 値は phone-view-model.js の buildPhoneFrame が RUNWAVE レーンの state から作る。ここは表示だけ（判断を作り直さない）。
// 小さな地図は現在地を追う（予定経路は水色の線、現在地は青い点、スタートは緑・ゴールは赤、信号は色つきの印）。
import L from 'leaflet';
import { PHONE_DISCLAIMER } from './phone-view-model.js';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const FOLLOW_ZOOM = 17;
const COLOR_CLASS = { green: 'ps-green', flashing: 'ps-flash', red: 'ps-red' };

const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };

export function createPhoneView(root) {
  root.innerHTML = `
    <div class="phone" aria-label="iPhone アプリの走行中画面（模擬表示）">
      <div class="ph-notch"></div>
      <div class="ph-screen">
        <div class="ph-top"><b>ランニング</b><span class="ph-run" data-k="state">—</span></div>
        <div class="ph-card ph-cad">
          <div class="ph-lbl">目標ケイデンス</div>
          <div class="ph-cad-row">
            <div><span class="ph-big" data-k="target">—</span><span class="ph-unit">歩/分</span><div class="ph-note" data-k="targetNote"></div></div>
            <div class="ph-cur"><small>現在</small><b data-k="current">—</b><small>歩/分</small></div>
          </div>
        </div>
        <div class="ph-card ph-nav">
          <div class="ph-ico" data-k="icon">→</div>
          <div class="ph-navtxt">
            <div class="ph-dist" data-k="toSignal">—</div>
            <div class="ph-head" data-k="headline">—</div>
            <div class="ph-sub" data-k="sub"></div>
            <div class="ph-goal" data-k="goalRemain"></div>
          </div>
        </div>
        <div class="ph-map" data-k="map"></div>
        <div class="ph-card ph-sig">
          <div class="ph-sig-h">信号シミュレーション</div>
          <div class="ph-sig-row">
            <span class="ph-lamp" data-k="lamp"></span>
            <b data-k="sigLabel">—</b>
            <span class="ph-sw" data-k="sigSwitch"></span>
            <span class="grow"></span>
            <span class="ph-sigtitle" data-k="sigTitle">—</span>
          </div>
          <div class="ph-sub" data-k="sigDist"></div>
          <div class="ph-tiny">模擬信号（位相は仮）。実際の信号情報ではありません</div>
        </div>
        <div class="ph-card ph-st">
          <div><small>ワークアウト状態</small><div class="ph-stv" data-k="stateBig">—</div></div>
          <div class="ph-el"><small>経過時間</small><div class="ph-elv" data-k="elapsed">00:00</div></div>
        </div>
      </div>
    </div>
    <div class="ph-cap">${PHONE_DISCLAIMER}</div>`;
  const q = (k) => root.querySelector(`[data-k="${k}"]`);
  const el = Object.fromEntries(['state', 'target', 'targetNote', 'current', 'icon', 'toSignal', 'headline', 'sub', 'goalRemain', 'lamp', 'sigLabel', 'sigSwitch', 'sigTitle', 'sigDist', 'stateBig', 'elapsed'].map((k) => [k, q(k)]));
  const screen = root.querySelector('.ph-screen');

  const map = L.map(q('map'), { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false })
    .setView([43.0625, 141.352], FOLLOW_ZOOM);
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  let youMarker = null;
  let sigMarkers = new Map();     // key → { marker, cls }
  let bounds = null;
  let lastPos = null;

  const dotIcon = (cls, text = '') => L.divIcon({ className: 'pm-icon', html: `<div class="pm ${cls}">${text}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });

  const view = {
    /** 経路と信号の印を描き直す（コース・信号が変わったときだけ） */
    setCourse({ route, adopted = [] } = {}) {
      layer.clearLayers();
      sigMarkers = new Map();
      youMarker = null;
      lastPos = null;
      bounds = null;
      if (!route) return;
      const pts = route.points.map((p) => [p.lat, p.lng]);
      L.polyline(pts, { color: '#22d3ee', weight: 6, opacity: 0.65 }).addTo(layer);
      const first = route.points[0];
      const last = route.points[route.points.length - 1];
      L.marker([first.lat, first.lng], { icon: dotIcon('pm-start', 'S'), interactive: false }).addTo(layer);
      L.marker([last.lat, last.lng], { icon: dotIcon('pm-goal', 'G'), interactive: false }).addTo(layer);
      adopted.forEach((a, i) => {
        const pos = a.projPoint ?? a;
        const m = L.marker([pos.lat, pos.lng], { icon: dotIcon('pm-sig ps-none', String(i + 1)), interactive: false, zIndexOffset: 500 }).addTo(layer);
        sigMarkers.set(a.key, { marker: m, cls: 'ps-none' });
      });
      bounds = L.latLngBounds(pts);
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [14, 14], maxZoom: FOLLOW_ZOOM });
    },

    /** frame = buildPhoneFrame の結果（null なら未開始）。pos = RUNWAVE の現在地 {lat,lng}（地図の走者と同じ位置） */
    update(frame, pos) {
      if (!frame) {
        setText(el.target, '—'); setText(el.current, '—'); setText(el.headline, '再生すると表示します'); setText(el.sub, '');
        setText(el.toSignal, '—'); setText(el.goalRemain, ''); setText(el.sigLabel, '—'); setText(el.sigSwitch, ''); setText(el.sigTitle, '—'); setText(el.sigDist, '');
        setText(el.stateBig, '—'); setText(el.elapsed, '00:00'); setText(el.state, '—'); setText(el.targetNote, '');
        el.lamp.className = 'ph-lamp';
        return;
      }
      screen.dataset.kind = frame.kind;
      setText(el.state, frame.stateText);
      setText(el.target, frame.targetText);
      setText(el.targetNote, frame.targetNote ?? '');
      setText(el.current, frame.currentText);
      setText(el.icon, frame.icon);
      setText(el.toSignal, frame.toSignalText);
      setText(el.headline, frame.headline);
      setText(el.sub, frame.sub);
      setText(el.goalRemain, frame.goalRemainText);
      const s = frame.signal;
      const cls = `ph-lamp ${COLOR_CLASS[s.color] ?? ''}`;
      if (el.lamp.className !== cls) el.lamp.className = cls;
      setText(el.sigLabel, s.allPassed ? '通過済み' : s.label);
      setText(el.sigSwitch, s.allPassed ? '' : s.switchText);
      setText(el.sigTitle, s.title);
      setText(el.sigDist, frame.toSignalText);
      setText(el.stateBig, frame.stateText);
      setText(el.elapsed, frame.elapsedText);
      for (const [key, rec] of sigMarkers) {
        const c = COLOR_CLASS[s.colors[key]] ?? 'ps-none';
        if (rec.cls !== c) {
          const node = rec.marker.getElement()?.firstChild;
          if (node) { node.className = `pm pm-sig ${c}`; rec.cls = c; }
        }
      }
      if (pos) {
        if (!youMarker) youMarker = L.marker([pos.lat, pos.lng], { icon: dotIcon('pm-you'), interactive: false, zIndexOffset: 1000 }).addTo(layer);
        if (!lastPos || lastPos.lat !== pos.lat || lastPos.lng !== pos.lng) {
          youMarker.setLatLng([pos.lat, pos.lng]);
          map.setView([pos.lat, pos.lng], FOLLOW_ZOOM, { animate: false });
          lastPos = { lat: pos.lat, lng: pos.lng };
        }
      }
    },

    invalidate() {
      map.invalidateSize();
      if (lastPos) map.setView([lastPos.lat, lastPos.lng], FOLLOW_ZOOM, { animate: false });
      else if (bounds) map.fitBounds(bounds, { padding: [14, 14], maxZoom: FOLLOW_ZOOM });
    },
    map,
  };
  return view;
}
