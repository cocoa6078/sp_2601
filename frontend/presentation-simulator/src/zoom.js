// ズーム演出（表示だけ。state・時計・tick には触れない）。DOM 非依存の計算部分。
// 1920×1080 のステージ全体に CSS transform（scale＋translate）をかける。DOM・SVG なので文字はぼやけない。
export const STAGE_W = 1920;
export const STAGE_H = 1080;
export const ZOOM_MIN = 1.3;
export const ZOOM_MAX = 1.8;
export const ZOOM_PAD = 60;
export const ZOOM_TRANSITION_MS = 350;

/** 段 → 拡大する領域（main が DOM から矩形を取る）。return と該当なしは全体 */
export const STAGE_REGION = { world: 'world', input: 'input', judge: 'judge', output: 'output' };

/**
 * rect（ステージ座標の矩形 {x,y,w,h}）を画面中央へ拡大する変換。
 * scale は領域が収まる範囲で 1.3〜1.8（領域が広いと下限まで下がる）。ステージの外が見えないよう平行移動を制限する。
 */
export function zoomTransform(rect, { w = STAGE_W, h = STAGE_H, minS = ZOOM_MIN, maxS = ZOOM_MAX, pad = ZOOM_PAD } = {}) {
  const fit = Math.min(w / (rect.w + pad * 2), h / (rect.h + pad * 2));
  const s = Math.max(minS, Math.min(maxS, fit));
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const tx = clamp(w / 2 - cx * s, w - w * s, 0);
  const ty = clamp(h / 2 - cy * s, h - h * s, 0);
  return { s, tx, ty };
}

/** 段と ON/OFF から、いまのズーム（なければ null = 全体）。rects は { world, input, judge, output } */
export function zoomFor(stage, zoomOn, rects) {
  if (!zoomOn || !stage) return null;
  const region = STAGE_REGION[stage];
  if (!region || !rects || !rects[region]) return null;
  return { region, ...zoomTransform(rects[region]) };
}

export const zoomCss = (z) => (z ? `translate(${z.tx.toFixed(1)}px, ${z.ty.toFixed(1)}px) scale(${z.s.toFixed(3)})` : 'none');
