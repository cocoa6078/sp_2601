// 架空の道路。実地図・実測信号ではない。位相は既存デモの値を使い、成功するよう調整しない。
const API = [['sapporo_3', 0, 110, 31, 74, 0], ['sapporo_8', 270, 100, 27, 68, 15], ['sapporo_2', 534, 100, 41, 54, 30], ['sapporo_1', 879, 145, 31, 109, 45], ['sapporo_5', 1255, 145, 50, 90, 60]];

export function makeRouteChoiceFixture(offsetM = 300) {
  const nodes = [{ id: 'start', x: 0, y: 0 }], edges = [];
  let from = 'start', x = 0;
  API.forEach(([id, d, cycleS, greenS, redS, phaseS], i) => {
    const atM = offsetM + d, approach = `a${i}`, after = `b${i}`;
    const lengthM = atM - 1 - x;
    nodes.push({ id: approach, x: atM - 1, y: 0 }, { id: after, x: atM + 15, y: 0 });
    edges.push({ id: `direct${i}`, from, to: approach, lengthM });
    if ([0, 2, 3].includes(i)) {
      const via = `via${i}`, half = (lengthM + 80) / 2;
      nodes.push({ id: via, x: x + lengthM / 2, y: Math.sqrt(half ** 2 - (lengthM / 2) ** 2) });
      edges.push({ id: `detour${i}a`, from, to: via, lengthM: half }, { id: `detour${i}b`, from: via, to: approach, lengthM: half });
    }
    // どちらの道も同じ横断の手前で合流し、同じ方向・同じ信号を渡る。
    edges.push({ id: `cross${i}`, from: approach, to: after, lengthM: 16,
      signals: [{ id, atM: 1, signal: { cycleS, greenS, yellowS: 5, redS, phaseS, crossingM: 15 } }] });
    from = after; x = atM + 15;
  });
  nodes.push({ id: 'goal', x: x + 200, y: 0 });
  edges.push({ id: 'finish', from, to: 'goal', lengthM: 200 });
  return { graph: { nodes, edges }, options: { startId: 'start', goalId: 'goal', runner: { strideM: 0.8, baseBpm: 150 },
    control: { startMarginS: 3, endMarginS: 5 }, maxDetourRatio: 0.2, maxCandidates: 8 } };
}
