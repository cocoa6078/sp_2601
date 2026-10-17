// Apple Watch の画面モック（端末イメージ）。BPM・状態・拍のリング・触覚イメージ。
// リングは 1 倍速のときだけ拍に合わせて脈打つ。倍速では点滅させず一定の光、待機・完了では止める。
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
const ICONS = {
  run: '<path d="M14 6a2.4 2.4 0 1 0 0-4.8A2.4 2.4 0 0 0 14 6zm-3 3 3-1 2 3 3 1-.6 1.8-3.4-1-1.4 3 3 3 .4 5-2 .2-.4-4.2-3-2.6-1.6 4.6-2-.7 2.2-6.5zM6 11l2-3 2 .5-1.5 3z"/>',
  walk: '<path d="M13.5 5.5a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM10 22l1.6-7.4L9 12.6V9l-2 .8V13h-2V8.4L10.8 6c1-.4 2 0 2.5.9L14.5 9H17v2h-3.4l-1 1.6L14 15v7h-2v-5.5l-1 5.5z"/>',
  wait: '<path d="M6 4h3v16H6zM15 4h3v16h-3z"/>',
  done: '<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>',
};

export function createWatchView(slot) {
  slot.innerHTML = `
    <div class="watch" aria-label="Apple Watch（イメージ）">
      <div class="watch-body">
        <svg class="ring" viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-bg" cx="60" cy="60" r="54"/><circle class="ring-fg" cx="60" cy="60" r="54"/></svg>
        <div class="w-content">
          <svg class="w-icon" viewBox="0 0 24 24" aria-hidden="true"></svg>
          <div class="w-bpm" data-k="bpm"></div>
          <div class="w-unit">BPM</div>
          <div class="w-line" data-k="line"></div>
        </div>
        <div class="haptic" aria-hidden="true"><i></i><i></i><i></i></div>
      </div>
    </div>
    <div class="dev-cap">Apple Watch（イメージ）<br><small>触覚はイメージ表示</small></div>`;
  const watch = slot.querySelector('.watch');
  const icon = slot.querySelector('.w-icon');
  const bpm = slot.querySelector('[data-k="bpm"]');
  const line = slot.querySelector('[data-k="line"]');
  const fg = slot.querySelector('.ring-fg');
  let lastIcon = '';
  let lastPeriod = '';
  return {
    update(frame, { haptic = false, glow = false } = {}) {
      const w = frame.watch;
      setText(bpm, w.bpmText);
      setText(line, w.line);
      if (lastIcon !== w.icon) { icon.innerHTML = ICONS[w.icon]; lastIcon = w.icon; }
      watch.dataset.ring = w.ringMode;
      watch.dataset.icon = w.icon;
      // 拍の周期（秒）。1 倍速のときだけ使う。変化が小さいときは更新しない（アニメーションが跳ねない）
      const period = w.periodS ? (Math.round(w.periodS * 20) / 20).toFixed(2) : '';
      if (period !== lastPeriod) { fg.style.setProperty('--beat', `${period || 1}s`); lastPeriod = period; }
      watch.classList.toggle('haptic-on', haptic);
      watch.classList.toggle('glow', glow);
    },
  };
}
