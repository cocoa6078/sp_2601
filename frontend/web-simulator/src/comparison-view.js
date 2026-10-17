// 下部の比較結果。主指標=停止回数・停止時間、総所要時間は必ず併記（減速で遅くなるケースも隠さない）
import { f1 } from './format.js';

/** 総時間差の文言。停止時間が減ったことを総時間短縮と同一視しない */
export function totalDiffText(normal, runwave) {
  if (normal.totalTimeS == null || runwave.totalTimeS == null) return '走行中';
  const d = normal.totalTimeS - runwave.totalTimeS;
  if (Math.abs(d) < 0.05) return '総所要時間は同じ';
  return d > 0 ? `RUNWAVE が ${f1(d)} 秒速い` : `RUNWAVE が ${f1(-d)} 秒遅い`;
}

export function walkText(runwave) {
  if ((runwave.walkCount ?? 0) > 0) return `停止せず走り・早歩きで移動（早歩き ${runwave.walkCount} 回・${f1(runwave.walkTimeS)} 秒・${f1(runwave.walkDistanceM)} m）`;
  return runwave.stops === 0 ? '停止せず走って通過' : '';
}

const cell = (v, unit = '') => (v == null ? '<span class="muted">走行中</span>' : `${v}${unit}`);

/**
 * live: 走行中の実績 { normal, runwave }（view 由来）、expected: 一括計算（予測結果）
 * phase: 'ready' | 'running' | 'done'
 */
export function resultsHtml({ phase, live, expected, matches, timedOut, multiNote, perSignal }) {
  const title = phase === 'done' ? 'シミュレーション結果' : phase === 'running' ? '走行中の実績' : '開始前';
  const row = (label, n, r) => `<tr><th>${label}</th><td>${n}</td><td class="rw">${r}</td></tr>`;
  const liveRows = live
    ? [
        row('停止回数', `${live.normal.stops} 回`, `${live.runwave.stops} 回`),
        row('停止時間', `${f1(live.normal.stopTimeS)} 秒`, `${f1(live.runwave.stopTimeS)} 秒`),
        row('総所要時間', cell(live.normal.totalTimeS == null ? null : f1(live.normal.totalTimeS), ' 秒'), cell(live.runwave.totalTimeS == null ? null : f1(live.runwave.totalTimeS), ' 秒')),
      ].join('')
    : '';
  const expRows = expected
    ? [
        row('停止回数', `${expected.normal.stops} 回`, `${expected.runwave.stops} 回`),
        row('停止時間', `${f1(expected.normal.stopTimeS)} 秒`, `${f1(expected.runwave.stopTimeS)} 秒`),
        row('総所要時間', cell(expected.normal.totalTimeS == null ? null : f1(expected.normal.totalTimeS), ' 秒'), cell(expected.runwave.totalTimeS == null ? null : f1(expected.runwave.totalTimeS), ' 秒')),
      ].join('')
    : '';
  const sum = phase === 'done' && live
    ? `<div class="sum"><b>${totalDiffText(live.normal, live.runwave)}</b><span>${walkText(live.runwave)}</span>${timedOut ? '<span class="warn">時間切れ（1800 秒）。到達不能とは断定しません</span>' : ''}</div>`
    : '';
  const check = phase === 'done' ? `<div class="chk ${matches?.ok ? 'ok' : 'ng'}">${matches?.ok ? '一括計算（core.compare）と一致' : `一括計算と不一致: ${(matches?.diffs ?? []).join(' / ')}`}</div>` : '';
  return `<section class="res">
      <h4>${title}</h4>
      ${multiNote ? `<div class="warn">${multiNote}</div>` : ''}
      <table class="rt"><thead><tr><th></th><th>通常</th><th class="rw">RUNWAVE</th></tr></thead><tbody>${liveRows || '<tr><td colspan="3" class="muted">再生すると表示されます</td></tr>'}</tbody></table>
      ${sum}${check}
    </section>
    <section class="res pred">
      <h4>予測結果（開始前の一括計算）</h4>
      <table class="rt"><thead><tr><th></th><th>通常</th><th class="rw">RUNWAVE</th></tr></thead><tbody>${expRows || '<tr><td colspan="3" class="muted">—</td></tr>'}</tbody></table>
      <div class="muted small">走行中の実績欄には未来の値を混ぜません。</div>
    </section>${perSignal ? perSignalHtml(perSignal) : ''}`;
}

const COLOR = { green: '青', flashing: '青点滅', red: '赤' };
function signalCell(s, t) {
  if (s.arriveT == null) return '<span class="muted">未到達</span>';
  const gait = s.gaitAtCross === 'walk' ? '・早歩き' : '';
  if (s.waited) return `<span class="warn">${COLOR[s.colorAtArrive] ?? ''}で待機 ${f1(s.waitS)}秒</span>`;
  return `通過（${COLOR[s.colorAtCross] ?? ''}${gait}）@${f1(s.arriveT)}s`;
}
/** 信号ごとの結果。route-core の events から作った summarizeRoute().signals[] を表示する（描画時刻の色では判定しない） */
export function perSignalHtml(ps) {
  const rows = ps.normal.map((n, i) => `<tr><th>信号${i + 1} <small>${n.meta?.signalId ?? n.signalId}</small></th><td>${signalCell(n)}</td><td class="rw">${signalCell(ps.runwave[i])}</td></tr>`).join('');
  return `<section class="res"><h4>信号ごとの結果（到達イベント）</h4><table class="rt small"><thead><tr><th></th><th>通常</th><th class="rw">RUNWAVE</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}
