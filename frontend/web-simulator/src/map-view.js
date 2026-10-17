// Leaflet の表示層。レイヤーとマーカーは作り直さず更新する（フレームごとに地図を作り直さない）。
// 背景タイルは外部ネットワーク依存。取得に失敗しても経路・信号・ランナーは描画され、計算は続く。
// 帰属表示（attribution）は隠さない。タイルの一括ダウンロードはしない。
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MAP_CENTER } from './fixtures.js';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const COLOR_CLASS = { green: 'sig-green', flashing: 'sig-flash', red: 'sig-red' };
const COLOR_TEXT = { green: '青', flashing: '青点滅', red: '赤' };

const lampHtml = (color, caption) =>
  `<div class="ped ${COLOR_CLASS[color] ?? 'sig-none'}"><span class="lamp l-red"></span><span class="lamp l-green"></span></div><div class="ped-cap">${caption}</div>`;

export function createMapView(el, { onMapClick, onDragPoint, onTileError } = {}) {
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView([MAP_CENTER.lat, MAP_CENTER.lng], 15);
  const tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION });
  let tileErrors = 0;
  tiles.on('tileerror', () => {
    tileErrors++;
    if (tileErrors === 3) onTileError?.();   // 単発の失敗では出さない
  });
  tiles.on('tileload', () => { tileErrors = 0; });
  tiles.addTo(map);

  const layer = L.layerGroup().addTo(map);           // 経路・編集点・信号（状態が変わったときだけ作り直す）
  let routeLine = null;
  let signalMarkers = new Map();                      // key → marker（色の更新用）
  let runnerMarkers = { normal: null, runwave: null };
  let editMode = null;

  map.on('click', (e) => {
    if (editMode) onMapClick?.(editMode, { lat: e.latlng.lat, lng: e.latlng.lng });
  });

  const dot = (cls, text) => L.divIcon({ className: 'pt-icon', html: `<div class="pt ${cls}">${text}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });

  // コンテナの大きさが変わったら（ウィンドウ・収録モード）タイルを再配置する
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => map.invalidateSize()).observe(el);

  return {
    map,
    setEditMode(mode) {
      editMode = mode;
      el.classList.toggle('picking', !!mode);
    },
    invalidate() { map.invalidateSize(); },

    /**
     * 経路と編集点・信号を描き直す（編集・確定・条件変更のときだけ呼ぶ）
     * draft = { start, end, via }, route（折れ線）, editable（ドラッグ可）, signals = [{ key, signalId, lat, lng, projPoint, kind: 'adopted'|'excluded', orderNo }]
     */
    drawCourse({ draft, route, editable, signals = [], fit = false, demo = false }) {
      layer.clearLayers();
      signalMarkers = new Map();
      const pts = route ? route.points : [draft?.start, ...(draft?.via ?? []), draft?.end].filter(Boolean);
      if (pts.length >= 2) {
        routeLine = L.polyline(pts.map((p) => [p.lat, p.lng]), { color: demo ? '#7aa0ff' : '#62F4C1', weight: 5, opacity: 0.9, dashArray: route ? null : '6 8' }).addTo(layer);
      }
      const addEdit = (kind, idx, p, cls, text) => {
        const m = L.marker([p.lat, p.lng], { icon: dot(cls, text), draggable: !!editable, title: kind === 'via' ? `経由点 ${idx + 1}` : kind === 'start' ? '開始地点' : '終了地点' }).addTo(layer);
        m.on('dragend', () => { const ll = m.getLatLng(); onDragPoint?.(kind, idx, { lat: ll.lat, lng: ll.lng }); });
      };
      if (!route && draft) {
        if (draft.start) addEdit('start', 0, draft.start, 'pt-start', 'S');
        draft.via?.forEach((p, i) => addEdit('via', i, p, 'pt-via', String(i + 1)));
        if (draft.end) addEdit('end', 0, draft.end, 'pt-end', 'G');
      } else if (route) {
        const first = route.points[0];
        const last = route.points[route.points.length - 1];
        const mk = (p, cls, text, title) => L.marker([p.lat, p.lng], { icon: dot(cls, text), interactive: false, title }).addTo(layer);
        mk(first, 'pt-start', 'S', '開始地点');
        mk(last, 'pt-end', 'G', '終了地点');
      }
      for (const s of signals) {
        const adopted = s.kind === 'adopted';
        if (s.projPoint) {
          L.polyline([[s.lat, s.lng], [s.projPoint.lat, s.projPoint.lng]], { color: '#aab', weight: 1.5, dashArray: '3 4', opacity: adopted ? 0.9 : 0.4 }).addTo(layer);
        }
        const pos = adopted && s.projPoint ? s.projPoint : { lat: s.lat, lng: s.lng };
        const icon = L.divIcon({
          className: 'sig-icon',
          html: adopted ? `<div class="sig-wrap">${lampHtml('none', s.orderNo ? `信号${s.orderNo}` : '信号')}</div>` : '<div class="sig-wrap ex"><span class="ex-dot"></span></div>',
          iconSize: [54, 64], iconAnchor: [27, 32],
        });
        const m = L.marker([pos.lat, pos.lng], { icon, interactive: true, title: s.signalId }).addTo(layer);
        m.bindTooltip(`${s.signalId}${adopted ? '' : '（対象外）'}`, { direction: 'top', offset: [0, -28] });
        if (adopted) {
          m.__orderNo = s.orderNo;
          m.__key = s.key;
          signalMarkers.set(s.key, m);
        }
      }
      if (fit && pts.length) map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), { padding: [60, 60], maxZoom: 17 });
    },

    /** 信号マーカーの色（フレームごと。色が変わったときだけ DOM を触る） */
    setSignalColors(colorsByKey) {
      for (const [key, m] of signalMarkers) {
        const color = colorsByKey[key];
        const el2 = m.getElement();
        if (!el2) continue;
        const ped = el2.querySelector('.ped');
        if (!ped) continue;
        const cls = COLOR_CLASS[color] ?? 'sig-none';
        if (ped.dataset.c !== cls) {
          ped.className = `ped ${cls}`;
          ped.dataset.c = cls;
          el2.querySelector('.ped-cap').textContent = `${m.__orderNo ? `信号${m.__orderNo}` : '信号'} ${COLOR_TEXT[color] ?? ''}`.trim();
        }
      }
    },

    clearRunners() {
      for (const k of Object.keys(runnerMarkers)) {
        if (runnerMarkers[k]) { map.removeLayer(runnerMarkers[k]); runnerMarkers[k] = null; }
      }
    },

    /**
     * ランナーの位置。positions = { normal: {lat,lng}, runwave: {lat,lng} }
     * 画面上で重なるときだけ左右に小さくずらして表示する（計算位置は変えない）
     */
    setRunners(positions) {
      for (const k of ['normal', 'runwave']) {
        if (!runnerMarkers[k]) {
          const icon = L.divIcon({ className: 'runner-icon', html: `<div class="runner ${k}"><span>${k === 'normal' ? '通常' : 'RUNWAVE'}</span></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
          runnerMarkers[k] = L.marker([positions[k].lat, positions[k].lng], { icon, interactive: false, zIndexOffset: k === 'runwave' ? 1000 : 900 }).addTo(map);
        }
        runnerMarkers[k].setLatLng([positions[k].lat, positions[k].lng]);
      }
      const pa = map.latLngToLayerPoint(runnerMarkers.normal.getLatLng());
      const pb = map.latLngToLayerPoint(runnerMarkers.runwave.getLatLng());
      const near = Math.hypot(pa.x - pb.x, pa.y - pb.y) < 22;
      const set = (k, dx) => {
        const inner = runnerMarkers[k].getElement()?.firstChild;
        if (inner) inner.style.transform = near ? `translateX(${dx}px)` : 'translateX(0)';
      };
      set('normal', -14);
      set('runwave', 14);
      return near;
    },
  };
}
