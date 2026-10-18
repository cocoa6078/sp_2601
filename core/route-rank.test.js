import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOf, projectPasses, candidateRoute, rankCandidateLines } from './experimental/route-rank.js';

// 札幌付近で、北へ n m・東へ e m の点（[経度, 緯度]）
const LAT0 = 43.06, LON0 = 141.35, M_PER_DEG = 6371008.8 * Math.PI / 180;
const at = (n, e = 0) => [LON0 + e / (M_PER_DEG * Math.cos(LAT0 * Math.PI / 180)), LAT0 + n / M_PER_DEG];
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
// along-route の matches の形
const sig = (id, [lon, lat], cycleS, greenS) => ({ physicalSignalId: id, lat, lon, timing: { cycleS, greenS, yellowS: 5, redS: cycleS - greenS - 5, phaseS: 0 }, crossingM: 15 });

test('経路の線: 長さと、点の当てはめ（経路からの距離・スタートからの距離）', () => {
  const line = lineOf([at(0), at(400), at(400, 300)]);
  near(line.lengthM, 700, 0.5);
  const [p] = projectPasses(line, { lon: at(250, 20)[0], lat: at(250, 20)[1] });
  near(p.atM, 250, 0.5);
  near(p.separationM, 20, 0.5);
  assert.equal(projectPasses(line, { lon: at(250, 50)[0], lat: at(250, 50)[1] }).length, 0);   // 30m より遠い
});

test('経路の線: 行って戻る道では、同じ信号を2回通る', () => {
  const line = lineOf([at(0), at(600), at(600, 10), at(0, 10)]);
  const passes = projectPasses(line, { lon: at(300, 5)[0], lat: at(300, 5)[1] });
  assert.equal(passes.length, 2);
  near(passes[0].atM, 300, 1);
  near(passes[1].atM, 910, 1);
  const r = candidateRoute({ id: 'loop', coordinates: [at(0), at(600), at(600, 10), at(0, 10)] }, [sig('s', at(300, 5), 100, 40)]);
  assert.deepEqual(r.signals.map((s) => s.id), ['s', 's#2']);
});

test('候補の入力: スタート・ゴール直前の信号と、前の横断に重なる信号は除く（理由を残す）', () => {
  const r = candidateRoute({ id: 'a', coordinates: [at(0), at(800)] },
    [sig('start', at(5), 100, 40), sig('x', at(300), 100, 40), sig('dup', at(310), 100, 40), sig('goal', at(795), 100, 40)]);
  assert.deepEqual(r.signals.map((s) => s.id), ['x']);
  assert.deepEqual(r.skipped.map((s) => s.id).sort(), ['dup', 'goal', 'start']);
});

test('並べ替え: 青の短い信号が1つの道より、青の長い信号が2つの道を先にする（同じ距離）', () => {
  const A = { id: 'A', coordinates: [at(0), at(700)] };
  const B = { id: 'B', coordinates: [at(0, 200), at(700, 200)] };
  const signals = [sig('a1', at(300), 145, 31), sig('b1', at(300, 200), 100, 41), sig('b2', at(615, 200), 100, 41)];
  const r = rankCandidateLines([A, B], signals, { control: { startMarginS: 3, endMarginS: 5 } });
  assert.deepEqual(r.map((x) => x.id), ['B', 'A']);
  assert.equal(r[0].signalCount, 2);
  assert.ok(r[0].expectedStops < r[1].expectedStops);
  assert.deepEqual(r.map((x) => x.rank), [1, 2]);
});

test('並べ替え: /api/signals/all の形（timing が平ら）も受け取る。信号が無ければ止まる見込み0で、短い道が先', () => {
  const flat = { signalId: 'f', lat: at(300)[1], lon: at(300)[0], cycleS: 145, greenS: 31, yellowS: 5, redS: 109, phaseS: 0, crossingM: 15 };
  const r = rankCandidateLines([{ id: 'long', coordinates: [at(0, 500), at(900, 500)] }, { id: 'short', coordinates: [at(0, 900), at(600, 900)] }, { id: 'withSignal', coordinates: [at(0), at(700)] }], [flat]);
  assert.deepEqual(r.map((x) => x.id), ['short', 'long', 'withSignal']);
  assert.equal(r[2].signals[0].physicalSignalId, 'f');
});

test('並べ替え: 不正な入力は RangeError（座標・候補の id の重複）', () => {
  assert.throws(() => rankCandidateLines([{ id: 'a', coordinates: [at(0)] }], []), RangeError);
  assert.throws(() => rankCandidateLines([{ id: 'a', coordinates: [[200, 43], at(100)] }], []), RangeError);
  assert.throws(() => rankCandidateLines([{ id: 'a', coordinates: [at(0), at(100)] }, { id: 'a', coordinates: [at(0), at(100)] }], []), RangeError);
  assert.throws(() => rankCandidateLines([], []), RangeError);
});
