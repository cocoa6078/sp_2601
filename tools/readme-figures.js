// README 用の図を作る: 時空図（横軸=時刻、縦軸=スタートからの距離）を docs/images/space-time.svg に出力する
// 使い方: npm run figures
// 数値はすべて core の simulate() の結果から作る（手書きの数値は入れない）。core は変更しない
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulate, signalAt } from '../core/runwave-core.js';
import { SCENARIOS, SCENARIOS_WALK } from '../core/scenarios.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'images', 'space-time.svg');

const PANELS = [
  { key: 'A', title: 'A 少し待つ位相', config: SCENARIOS.A },
  { key: 'B', title: 'B 長く待つ位相', config: SCENARIOS.B },
  { key: 'W', title: 'W 早歩きでつなぐ位相', config: SCENARIOS_WALK.W },
];

const COLORS = {
  green: '#43a047', flashing: '#fbc02d', red: '#e53935',
  normal: '#8a8f98', runwave: '#1565c0', grid: '#e3e6ea', axis: '#555b66', text: '#222831',
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);

// 通常（control.enabled=false）と RUNWAVE（true）を同じ条件で走らせる
function run(config, enabled) {
  return simulate({ ...config, control: { ...(config.control || {}), enabled } });
}

// 信号の色が変わる区間 [{from, to, color}] を 0〜maxT で作る（1 秒刻みで signalAt を引く）
function signalBands(signal, maxT) {
  const bands = [];
  for (let t = 0; t < maxT; t += 1) {
    const color = signalAt(signal, t + 0.5).color;
    const last = bands[bands.length - 1];
    if (last && last.color === color) last.to = Math.min(t + 1, maxT);
    else bands.push({ from: t, to: Math.min(t + 1, maxT), color });
  }
  return bands;
}

// history を「走り」と「早歩き」の折れ線に分ける（区間の終点の gait で判定）
function splitByGait(history) {
  const runPts = [], walkPts = [];
  let curKind = null, cur = null;
  for (let i = 1; i < history.length; i++) {
    const kind = history[i].gait === 'walk' ? 'walk' : 'run';
    if (kind !== curKind) {
      cur = [history[i - 1]];
      (kind === 'walk' ? walkPts : runPts).push(cur);
      curKind = kind;
    }
    cur.push(history[i]);
  }
  return { runPts, walkPts };
}

// 要約文を summary から作る
function summaryLines(normal, runwave) {
  const stop = (s) => (s.stops === 0 ? '停止0回' : `停止${s.stops}回 ${fmt(s.stopTimeS, 0)}秒`);
  const lines = [
    `通常: ${stop(normal)} / RUNWAVE: ${stop(runwave)}`,
    `ゴール 通常 ${fmt(normal.totalTimeS)}秒 / RUNWAVE ${fmt(runwave.totalTimeS)}秒`,
  ];
  if (runwave.walkCount > 0) lines.push(`RUNWAVE の早歩き: ${runwave.walkCount}回 ${fmt(runwave.walkTimeS, 0)}秒 ${fmt(runwave.walkDistanceM, 0)}m`);
  return lines;
}

function buildSvg(results) {
  const W = 1200, H = 590;
  const padL = 56, gap = 34, padR = 20, top = 96, plotH = 380;
  const panelW = (W - padL - padR - gap * 2) / 3;
  const maxT = Math.max(...results.flatMap((r) => [r.normal.summary.totalTimeS, r.runwave.summary.totalTimeS]));
  const tMax = Math.ceil(maxT / 60) * 60;
  const dMax = Math.max(...results.map((r) => r.config.route.goalX));

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Hiragino Sans','Yu Gothic','Meiryo',sans-serif">`);
  out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  out.push(`<text x="${W / 2}" y="30" text-anchor="middle" font-size="20" font-weight="bold" fill="${COLORS.text}">時空図: 信号待ちで止まる通常走行と、止まらない RUNWAVE</text>`);

  // 凡例
  const ly = 62;
  let lx = 70;
  const item = (draw, label, w) => {
    out.push(draw(lx, ly));
    out.push(`<text x="${lx + 40}" y="${ly + 4}" font-size="13" fill="${COLORS.text}">${esc(label)}</text>`);
    lx += w;
  };
  item((x, y) => `<line x1="${x}" y1="${y}" x2="${x + 32}" y2="${y}" stroke="${COLORS.normal}" stroke-width="2.5"/>`, '通常走行', 120);
  item((x, y) => `<line x1="${x}" y1="${y}" x2="${x + 32}" y2="${y}" stroke="${COLORS.runwave}" stroke-width="4.5" stroke-linecap="round"/>`, 'RUNWAVE（走り）', 170);
  item((x, y) => `<line x1="${x}" y1="${y}" x2="${x + 32}" y2="${y}" stroke="${COLORS.runwave}" stroke-width="4.5" stroke-dasharray="7 5"/>`, 'RUNWAVE（早歩き）', 180);
  item((x, y) => `<rect x="${x}" y="${y - 6}" width="32" height="12" fill="${COLORS.green}"/>`, '横断歩道: 青', 150);
  item((x, y) => `<rect x="${x}" y="${y - 6}" width="32" height="12" fill="${COLORS.flashing}"/>`, '青点滅', 100);
  item((x, y) => `<rect x="${x}" y="${y - 6}" width="32" height="12" fill="${COLORS.red}"/>`, '赤', 70);

  results.forEach((r, i) => {
    const x0 = padL + i * (panelW + gap);
    const y0 = top;                       // プロット上端 = 距離 dMax
    const px = (t) => x0 + (t / tMax) * panelW;
    const py = (d) => y0 + plotH - (d / dMax) * plotH;
    out.push(`<g>`);
    out.push(`<text x="${x0 + panelW / 2}" y="${y0 - 12}" text-anchor="middle" font-size="16" font-weight="bold" fill="${COLORS.text}">${esc(r.title)}</text>`);
    out.push(`<rect x="${x0}" y="${y0}" width="${panelW}" height="${plotH}" fill="#fafbfc" stroke="${COLORS.axis}" stroke-width="1"/>`);

    // 格子と目盛り
    for (let t = 0; t <= tMax; t += 60) {
      out.push(`<line x1="${px(t)}" y1="${y0}" x2="${px(t)}" y2="${y0 + plotH}" stroke="${COLORS.grid}"/>`);
      out.push(`<text x="${px(t)}" y="${y0 + plotH + 16}" text-anchor="middle" font-size="11" fill="${COLORS.axis}">${t}</text>`);
    }
    for (let d = 0; d <= dMax; d += 100) {
      out.push(`<line x1="${x0}" y1="${py(d)}" x2="${x0 + panelW}" y2="${py(d)}" stroke="${COLORS.grid}"/>`);
      if (i === 0) out.push(`<text x="${x0 - 6}" y="${py(d) + 4}" text-anchor="end" font-size="11" fill="${COLORS.axis}">${d}</text>`);
    }
    out.push(`<text x="${x0 + panelW / 2}" y="${y0 + plotH + 34}" text-anchor="middle" font-size="12" fill="${COLORS.axis}">時刻 [秒]</text>`);
    if (i === 0) out.push(`<text transform="translate(14 ${y0 + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="${COLORS.axis}">スタートからの距離 [m]</text>`);

    // 信号の帯（横断地点 crossingX から横断長 crossingM ぶん。細すぎないよう最低 12px）
    const cx = r.config.route.crossingX, cm = r.config.signal.crossingM;
    const bandH = Math.max(12, py(cx) - py(cx + cm));
    const bandTop = py(cx) - bandH;
    for (const b of signalBands(r.config.signal, tMax)) {
      out.push(`<rect x="${px(b.from)}" y="${bandTop}" width="${px(b.to) - px(b.from) + 0.3}" height="${bandH}" fill="${COLORS[b.color]}" opacity="0.85"/>`);
    }
    out.push(`<text x="${x0 + 4}" y="${bandTop - 4}" font-size="10" fill="${COLORS.axis}">横断地点 ${cx}m</text>`);

    // ゴール線
    out.push(`<line x1="${x0}" y1="${py(r.config.route.goalX)}" x2="${x0 + panelW}" y2="${py(r.config.route.goalX)}" stroke="${COLORS.axis}" stroke-dasharray="2 3"/>`);

    // 通常走行（灰色）
    const toPts = (h) => h.map((s) => `${fmt(px(s.t), 2)},${fmt(py(s.x), 2)}`).join(' ');
    out.push(`<polyline points="${toPts(r.normal.state.history)}" fill="none" stroke="${COLORS.normal}" stroke-width="2.5" stroke-linejoin="round"/>`);

    // RUNWAVE（青系の太線。早歩き区間は破線）
    const { runPts, walkPts } = splitByGait(r.runwave.state.history);
    for (const seg of runPts) out.push(`<polyline points="${toPts(seg)}" fill="none" stroke="${COLORS.runwave}" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round"/>`);
    for (const seg of walkPts) out.push(`<polyline points="${toPts(seg)}" fill="none" stroke="${COLORS.runwave}" stroke-width="4.5" stroke-dasharray="7 5" stroke-linejoin="round"/>`);

    // 要約（パネルの下）
    summaryLines(r.normal.summary, r.runwave.summary).forEach((line, k) => {
      out.push(`<text x="${x0 + panelW / 2}" y="${y0 + plotH + 62 + k * 20}" text-anchor="middle" font-size="${k === 0 ? 14 : 12}"${k === 0 ? ' font-weight="bold"' : ''} fill="${COLORS.text}">${esc(line)}</text>`);
    });
    out.push(`</g>`);
  });

  out.push(`</svg>`);
  return out.join('\n') + '\n';
}

const results = PANELS.map((p) => ({
  ...p,
  normal: run(p.config, false),
  runwave: run(p.config, true),
}));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buildSvg(results), 'utf8');
for (const r of results) {
  console.log(`${r.key}: ${summaryLines(r.normal.summary, r.runwave.summary).join(' | ')}`);
}
console.log(`wrote ${OUT}`);
