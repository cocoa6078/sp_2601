// 表示用の小さな整形関数（DOM 非依存）
export const COLOR_LABELS_FALLBACK = { green: '青', flashing: '青点滅', red: '赤' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
export const f0 = (v) => (Number.isFinite(v) ? Math.round(v).toString() : '—');
