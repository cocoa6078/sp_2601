// 通常 / RUNWAVE のカード（右側）。HTML 文字列を返すだけ
import { colorBadge } from './signal-view.js';
import { f0, f1 } from './format.js';

const MODE_CLASS = { normal: 'm-normal', adjusting: 'm-adjust', walking: 'm-walk', stopRecommended: 'm-warn', waiting: 'm-warn', finished: 'm-done' };

export function runnerCard({ lane, title, view, goalX }) {
  const next = view.distToSignalM === null ? '通過済み' : `残り ${f0(view.distToSignalM)} m`;
  const pct = Math.min(100, (view.x / goalX) * 100);
  const modeCls = MODE_CLASS[view.mode] ?? 'm-normal';
  return `<article class="card card-${lane}">
    <header class="card-h"><span class="dot dot-${lane}"></span><h3>${title}</h3><span class="mode ${modeCls}">${view.modeText}</span></header>
    <div class="card-reason">${view.reasonText}</div>
    <div class="card-grid">
      <div><label>現在位置</label><b>${f0(view.x)} m</b><small>/ ${f0(goalX)} m（${f0(pct)}%）</small></div>
      <div><label>次の信号</label><b>${next}</b><small>${colorBadge(view.signal)}</small></div>
      <div><label>ケイデンス（現在 → 目標）</label><b>${f0(view.bpm)} → ${f0(view.targetBpm)}</b><small>歩/分（心拍ではない）</small></div>
      <div><label>速度 / 歩幅</label><b>${f1(view.speedKmh)} km/h</b><small>${view.strideM} m/歩${view.walking ? '（早歩き・歩幅は仮設定）' : ''}</small></div>
    </div>
    <div class="card-foot">
      <span>停止 <b>${view.stops}</b> 回 / <b>${f1(view.stopTimeS)}</b> 秒</span>
      <span>早歩き <b>${view.walkCount}</b> 回 / <b>${f1(view.walkTimeS)}</b> 秒 / <b>${f0(view.walkDistanceM)}</b> m</span>
    </div>
  </article>`;
}
