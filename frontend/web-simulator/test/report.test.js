// SIM-05（出所表示）と SIM-04（時系列 CSV）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSignals } from '../src/api.js';
import { buildReport, buildTimeSeriesCsv, CSV_COLUMNS } from '../src/report.js';
import { ESTIMATED_LABEL, anyEstimated, apiFailureMessage, buildApiInfo, isEstimatedSignal, signalProvenance } from '../src/provenance.js';
import { Playback } from '../src/playback.js';
import { getDemo } from '../src/scenarios.js';

const resp = (body, status = 200) => async () => ({ status, text: async () => JSON.stringify(body) });
const sig = (id, extra = {}) => ({ signalId: id, lat: 43.06, lon: 141.35, cycleS: 100, greenS: 40, yellowS: 5, redS: 55, phaseS: 0, crossingM: 15, note: 'n', ...extra });
const fixedNow = () => new Date('2026-10-18T01:02:03.000Z');

test('fetchSignals: URL・取得日時・API が返した出所項目をそのまま候補に保持（無ければ null）', async () => {
  const meta = { isEstimated: false, signalType: 'pedestrian', phaseBasis: 'measured', positionAccuracyM: 3.5, fetchedAt: '2026-10-17T00:00:00Z', crossingDirection: 'north-south' };
  const r = await fetchSignals('http://localhost:3001', { now: fixedNow, fetchImpl: resp({ ステータス: '成功', データ: [sig('a', meta), sig('b')] }) });
  assert.equal(r.at, '2026-10-18T01:02:03.000Z');
  assert.match(r.url, /\/api\/signals$/);
  assert.deepEqual(r.candidates[0].apiMeta, meta);
  assert.deepEqual(r.candidates[1].apiMeta, { isEstimated: null, signalType: null, phaseBasis: null, positionAccuracyM: null, fetchedAt: null, crossingDirection: null });
});

test('signalProvenance: API が false と明示したときだけ推定でない。それ以外（fixture・模式・未指定）は推定', () => {
  assert.equal(isEstimatedSignal({}), true);
  assert.equal(isEstimatedSignal({ apiMeta: { isEstimated: null } }), true);
  assert.equal(isEstimatedSignal({ apiMeta: { isEstimated: true } }), true);
  assert.equal(isEstimatedSignal({ apiMeta: { isEstimated: false } }), false);
  assert.equal(signalProvenance({}).signalType, null);
  assert.equal(anyEstimated([{ apiMeta: { isEstimated: false } }, {}]), true);
  assert.equal(anyEstimated([{ apiMeta: { isEstimated: false } }]), false);
});

test('buildReport: api の出所・信号ごとの provenance・推定ラベルが入る', () => {
  const adopted = [
    { key: 'api:a', signalId: 'a', origin: 'api', lat: 1, lng: 2, s: 100, offsetM: 1, signal: {}, apiMeta: { isEstimated: null, signalType: 'ped', phaseBasis: null, positionAccuracyM: 5, fetchedAt: 'x', crossingDirection: null } },
  ];
  const apiInfo = buildApiInfo({ source: 'api', url: 'http://localhost:3001/api/signals', at: '2026-10-18T01:02:03.000Z', base: 'http://localhost:3001' });
  const rep = buildReport({ coreVersion: 'c', signals: { adopted, excluded: [] }, config: {}, apiInfo, events: [] });
  assert.equal(rep.api.source, 'api');
  assert.equal(rep.api.url, 'http://localhost:3001/api/signals');
  assert.equal(rep.api.at, '2026-10-18T01:02:03.000Z');
  assert.equal(rep.simulationLabel, ESTIMATED_LABEL);
  const p = rep.signals.adopted[0].provenance;
  assert.equal(p.isEstimated, true);
  assert.equal(p.signalType, 'ped');
  assert.equal(p.positionAccuracyM, 5);
  assert.equal(p.phaseBasis, null);
  assert.equal(buildReport({ coreVersion: 'c', signals: { adopted: [], excluded: [] }, config: {}, events: [] }).api.source, 'none');
});

test('apiFailureMessage: 失敗時は「取得失敗・fixture（推定データ）を使用」と理由を出す', () => {
  const m = apiFailureMessage('参考信号', { url: 'http://x/api/signals', at: '2026-10-18T01:02:03.000Z', error: 'HTTP 500' });
  assert.match(m, /取得失敗・fixture（推定データ）を使用/);
  assert.match(m, /HTTP 500/);
});

test('時系列 CSV: 列・件数・BOM・出所・推定フラグ。停止と通過の状態が入る', () => {
  const pb = new Playback(getDemo('W').config);
  pb.play();
  while (pb.status === 'playing') pb.frame(0.5);
  const csv = buildTimeSeriesCsv(pb.series, { source: 'fixture', isEstimated: true });
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines.length - 1, (pb.pair.tick + 1) * 2); // tick 0 を含む × 2 走行
  const rows = lines.slice(1).map((l) => l.split(','));
  assert.ok(rows.every((r) => r.length === CSV_COLUMNS.length));
  assert.ok(rows.every((r) => r[8] === 'fixture' && r[9] === 'true'));
  const states = new Set(rows.map((r) => r[7]));
  assert.ok(states.has('stopped'), '通常走行は信号待ちで止まる');
  assert.ok(states.has('passed') || states.has('crossing'));
  assert.ok(states.has('finished'));
  assert.deepEqual(new Set(rows.map((r) => r[0])), new Set(['normal', 'runwave']));
  const first = rows[0];
  assert.equal(first[1], '0');
  assert.ok(['green', 'flashing', 'red'].includes(first[3]));
  // 位置は時刻とともに単調に増える（走行ごと）
  for (const lane of ['normal', 'runwave']) {
    const xs = rows.filter((r) => r[0] === lane).map((r) => Number(r[2]));
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1] - 1e-9);
  }
});

test('時系列 CSV: カンマ・引用符を含む値は引用、空の series はヘッダーのみ', () => {
  const csv = buildTimeSeriesCsv([{ lane: 'a,b', tS: 0, xM: 0, signalColor: 'x"y', targetBpm: null, bpm: 0, speedMps: 0, state: 's' }]);
  assert.match(csv, /"a,b",0,0,"x""y",,0,0,s,none,true/);
  assert.equal(buildTimeSeriesCsv([]).slice(1).trim().split('\r\n').length, 1);
});
