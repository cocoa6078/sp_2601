// ①状態入力 → ②判定処理 → ③フィードバック の流れと接続線。
// 表示は frame（共通 state から作った値）だけを使う。通信応答や計算の中間値は作らない。
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

export function createFlowView(root) {
  root.innerHTML = `
    <div class="flow-col col-input" data-block="input">
      <h3><span class="num">①</span>状態入力</h3>
      <div class="cards"></div>
    </div>
    <div class="link" data-link="in"><span class="dots"></span></div>
    <div class="flow-col col-judge" data-block="judge">
      <h3><span class="num">②</span>判定処理<small>（バックエンド相当）</small></h3>
      <ol class="steps"></ol>
      <div class="judge-result"><span class="jr-k">判断</span><span class="jr-v" data-k="judge"></span></div>
    </div>
    <div class="link" data-link="out"><span class="dots"></span></div>
    <div class="flow-col col-out" data-block="output">
      <h3><span class="num">③</span>フィードバック</h3>
      <div class="devices">
        <div class="phone-slot"></div>
        <div class="watch-slot"></div>
      </div>
    </div>
    <div class="loop loop-up" data-link="loop-in" title="人物 → 状態入力"><span>人物 → 入力</span></div>
    <div class="loop loop-down" data-link="loop-out" title="端末 → 人物"><span>端末 → 人物</span></div>
    <div class="explain-badge" hidden>解説中／シミュレーション一時停止</div>`;
  const cardsEl = root.querySelector('.cards');
  const stepsEl = root.querySelector('.steps');
  const judgeEl = root.querySelector('[data-k="judge"]');
  const badge = root.querySelector('.explain-badge');
  const blocks = Object.fromEntries([...root.querySelectorAll('[data-block]')].map((e) => [e.dataset.block, e]));
  const links = Object.fromEntries([...root.querySelectorAll('[data-link]')].map((e) => [e.dataset.link, e]));
  let cardEls = null;
  let stepEls = null;

  return {
    phoneSlot: root.querySelector('.phone-slot'),
    watchSlot: root.querySelector('.watch-slot'),
    /**
     * frame: buildFrame の結果。
     * stage: 解説中の段（world/input/judge/output/return）または null。
     * pulses: 現在光らせる演出（'flow'）。
     */
    update(frame, { stage = null, pulses = [] } = {}) {
      if (!cardEls) {
        cardsEl.innerHTML = frame.inputs.map((c) => `<div class="card" data-k="${c.key}"><span class="card-k">${c.label}</span><span class="card-v"></span>${c.unit ? `<span class="card-u">${c.unit}</span>` : ''}</div>`).join('');
        cardEls = [...cardsEl.children];
        stepsEl.innerHTML = frame.judge.steps.map((s, i) => `<li data-step="${s.key}"><b>${i + 1}</b><div><span class="st-title">${s.title}</span><span class="st-body"></span></div></li>`).join('');
        stepEls = [...stepsEl.children];
      }
      frame.inputs.forEach((c, i) => setText(cardEls[i].querySelector('.card-v'), c.value));
      frame.judge.steps.forEach((s, i) => setText(stepEls[i].querySelector('.st-body'), s.body));
      setText(judgeEl, frame.judge.text);

      const explaining = stage !== null;
      root.classList.toggle('is-explaining', explaining);
      badge.hidden = !explaining;
      blocks.input.classList.toggle('lit', stage === 'input');
      blocks.output.classList.toggle('lit', stage === 'output');
      blocks.judge.classList.toggle('lit', stage === 'judge');
      stepEls.forEach((el) => el.classList.toggle('lit', stage === 'judge' && el.dataset.step === frame.judge.activeStep));
      links.in.classList.toggle('lit', stage === 'input' || stage === 'judge' || pulses.includes('flow'));
      links.out.classList.toggle('lit', stage === 'judge' || stage === 'output' || pulses.includes('flow'));
      links['loop-in'].classList.toggle('lit', stage === 'world' || stage === 'input' || pulses.includes('flow'));
      links['loop-out'].classList.toggle('lit', stage === 'output' || pulses.includes('flow'));
    },
  };
}
