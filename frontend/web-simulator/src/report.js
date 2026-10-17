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
      adopted: signals.adopted.map((s) => ({ key: s.key, signalId: s.signalId, origin: s.origin ?? null, original: { lat: s.lat, lng: s.lng }, projected: s.projPoint ?? null, routeDistanceM: s.s, offsetM: s.offsetM, signal: s.signal })),
      excluded: signals.excluded,
    },
    config,
    runnerControl: { runner: config?.runner, control: config?.control },
    api: apiInfo ?? { source: 'none' },
    expectedByCore: expected,
    result: { termination, summaries, matchesBatchCompute: matches },
    perSignalResults: perSignal ?? null,   // summarizeRoute().signals[]（複数信号のとき）
    events,
  };
}

export const reportFileName = (now = new Date()) => `runwave-sim-${now.toISOString().replace(/[:.]/g, '-')}.json`;
