// スマートフォンの画面モック（端末イメージ）。frame.phone と frame.target だけを使う。
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

export function createPhoneView(slot) {
  slot.innerHTML = `
    <div class="phone" aria-label="スマートフォン（イメージ）">
      <div class="phone-notch"></div>
      <div class="phone-screen">
        <div class="ph-head">RUNWAVE</div>
        <div class="ph-bpm"><span data-k="bpm"></span><small>BPM 現在</small></div>
        <div class="ph-target"><span class="ph-tk">目標</span><span data-k="target"></span></div>
        <div class="ph-status" data-k="headline"></div>
        <div class="ph-dist">横断地点まで <b data-k="dist"></b></div>
        <div class="ph-msg" data-k="sub"></div>
      </div>
    </div>
    <div class="dev-cap">スマートフォン（イメージ）</div>`;
  const q = (k) => slot.querySelector(`[data-k="${k}"]`);
  const e = { bpm: q('bpm'), target: q('target'), headline: q('headline'), dist: q('dist'), sub: q('sub') };
  const screen = slot.querySelector('.phone-screen');
  return {
    update(frame, { glow = false } = {}) {
      const p = frame.phone;
      setText(e.bpm, p.bpmText);
      setText(e.target, p.targetText);
      setText(e.headline, p.headline);
      setText(e.dist, p.distanceText);
      setText(e.sub, p.sub);
      screen.dataset.kind = p.kind;
      screen.classList.toggle('glow', glow);
    },
  };
}
