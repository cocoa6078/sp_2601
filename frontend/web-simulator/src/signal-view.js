// 信号まわりの HTML 部品（文字列を返すだけ。DOM 非依存）
import { COLOR_LABELS_FALLBACK } from './format.js';
import { secondsToGreen } from './engine-adapter.js';
import { core } from './core-ns.js';
import { esc, f1 } from './format.js';

export const colorLabel = (c) => core.COLOR_LABELS?.[c] ?? COLOR_LABELS_FALLBACK[c] ?? c;

/** 縦 2 灯の歩行者信号（色だけに意味を頼らず文字ラベルを併記） */
export function pedLamp(color, { size = 'md' } = {}) {
  return `<span class="ped ped-${size} sig-${color === 'flashing' ? 'flash' : color}" role="img" aria-label="${colorLabel(color)}"><span class="lamp l-red"></span><span class="lamp l-green"></span></span>`;
}

export function colorBadge(sig) {
  return `<span class="badge b-${sig.color}">${pedLamp(sig.color, { size: 'sm' })}<b>${colorLabel(sig.color)}</b></span>`;
}

/** サイクルバー: 青 / 青点滅 / 赤 の区間と現在位置 */
export function cycleBar(signal, sig) {
  const g = (signal.greenS / signal.cycleS) * 100;
  const y = (signal.yellowS / signal.cycleS) * 100;
  const r = 100 - g - y;
  return `<div class="cyc" aria-label="信号の周期">
    <span class="cg" style="width:${g}%"></span><span class="cy" style="width:${y}%"></span><span class="cr" style="width:${r}%"></span>
    <span class="cpos" style="left:${(sig.cycleProgress * 100).toFixed(2)}%"></span></div>`;
}

export function untilGreenText(signal, t) {
  const v = secondsToGreen(signal, t);
  if (v === null) return '青区間なし';
  return v === 0 ? '青（通行可）' : `青まで ${f1(v)} 秒`;
}

/** 選択信号の詳細パネル */
export function signalDetailHtml(info, t) {
  if (!info) return '<div class="muted">信号が選ばれていません</div>';
  const { signal } = info;
  const sig = core.signalAt(signal, t);
  const orig = Number.isFinite(info.lat) ? `${info.lat.toFixed(6)}, ${info.lng.toFixed(6)}` : '座標なし（模式）';
  const proj = info.projPoint ? `${info.projPoint.lat.toFixed(6)}, ${info.projPoint.lng.toFixed(6)}` : '—';
  return `<div class="sigdetail">
    <div class="sd-head">${colorBadge(sig)} <span class="sd-id">${esc(info.signalId)}</span> <span class="muted">${esc(info.originLabel ?? '')}</span></div>
    ${cycleBar(signal, sig)}
    <div class="sd-grid">
      <span>経路上の距離</span><b>${f1(info.s)} m</b>
      <span>経路からのずれ</span><b>${info.offsetM == null ? '—' : `${f1(info.offsetM)} m`}</b>
      <span>周期</span><b>${signal.cycleS}s = 青${signal.greenS} + 青点滅${signal.yellowS} + 赤${signal.redS}</b>
      <span>位相 phaseS</span><b>${signal.phaseS}s（模擬時刻 0 に対する値）</b>
      <span>元座標</span><b>${orig}</b>
      <span>経路への投影位置</span><b>${proj}</b>
      <span>次の青まで</span><b>${untilGreenText(signal, t)}（残り ${f1(sig.remainingS)} 秒で切替）</b>
    </div>
  </div>`;
}
