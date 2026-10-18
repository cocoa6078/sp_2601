import { ESTIMATED_LABEL, anyEstimated, buildApiInfo, signalProvenance } from './provenance.js';

// 結果 JSON（config・経路・信号の採用/除外・結果・イベント）。DOM 非依存。ダウンロードは main.js 側。
export const REPORT_NOTICE = '模擬経路・模擬信号によるシミュレーション／モデル上の推定値。地図上の現在位置は GPS ではなく、API 由来の信号でも実際の点灯状況とは同期しない。';

export function buildReport({ coreVersion, routeVersion, perSignal, gitSha, courseKind, route, signals, config, expected, pair, summaries, events, apiInfo, termination, matches }) {
  return {
    notice: REPORT_NOTICE,
    generatedAt: new Date().toISOString(),
    core: { exportedVersion: coreVersion, routeVersion: routeVersion ?? null, gitSha: gitSha ?? null },
    course: { kind: courseKind, note: courseKind === 'demo' ? '模式コース（既存シナリオの距離を保持。実地図から測った距離ではない）' : '手で置いた点を結ぶ折れ線（仮想経路。歩道通行可能性・道路距離は保証しない）' },
    route: route && { id: route.id, source: route.source, points: route.points, cumulativeM: route.cumulativeM, lengthM: route.lengthM },
    signals: {
      adopted: signals.adopted.map((s) => ({ key: s.key, signalId: s.signalId, origin: s.origin ?? null, provenance: signalProvenance(s), original: { lat: s.lat, lng: s.lng }, projected: s.projPoint ?? null, routeDistanceM: s.s, offsetM: s.offsetM, signal: s.signal })),
      excluded: signals.excluded,
    },
    config,
    runnerControl: { runner: config?.runner, control: config?.control },
    api: apiInfo ?? buildApiInfo({ source: 'none' }),
    simulationLabel: anyEstimated(signals.adopted) ? ESTIMATED_LABEL : null,
    expectedByCore: expected,
    result: { termination, summaries, matchesBatchCompute: matches },
    perSignalResults: perSignal ?? null,   // summarizeRoute().signals[]（複数信号のとき）
    events,
  };
}

export const reportFileName = (now = new Date()) => `runwave-sim-${now.toISOString().replace(/[:.]/g, '-')}.json`;

// ---------------------------------------------------------------- 時系列 CSV（SIM-04）
export const CSV_COLUMNS = ['lane', 'time_s', 'position_m', 'signal_color', 'target_bpm', 'bpm', 'speed_mps', 'state', 'data_source', 'is_estimated'];

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '') : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Playback.series（tick ごとの両走行）を CSV 文字列にする。
 * 先頭に BOM（Excel 用）。出所（api / fixture / none）と推定フラグを全行に付け、CSV 単体でも推定データと分かるようにする。
 */
export function buildTimeSeriesCsv(series, { source = 'none', isEstimated = true } = {}) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const r of series ?? []) {
    rows.push([r.lane, r.tS, r.xM, r.signalColor, r.targetBpm, r.bpm, r.speedMps, r.state, source, isEstimated].map(csvCell).join(','));
  }
  return `﻿${rows.join('\r\n')}\r\n`;
}

export const csvFileName = (now = new Date()) => `runwave-sim-${now.toISOString().replace(/[:.]/g, '-')}.csv`;
