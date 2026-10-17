// シナリオA/Bを通常とRUNWAVEで比較し、結果をJSONで出力する
// 使い方: node core/run-scenarios.js
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CORE_VERSION, compare } from './runwave-core.js';
import { SCENARIOS, DEMO, withCrossing } from './scenarios.js';

const src = readFileSync(new URL('./runwave-core.js', import.meta.url));
const coreHash = createHash('sha256').update(src).digest('hex').slice(0, 12);

const results = [];
for (const [name, config] of Object.entries(SCENARIOS)) {
  for (const crossingM of [config.signal.crossingM, 0]) {
    const c = withCrossing(config, crossingM);
    results.push({ scenario: name, crossingM, ...compare(c), config: c });
  }
}
for (const [name, config] of Object.entries(DEMO)) {
  results.push({ scenario: `DEMO.${name}`, crossingM: config.signal.crossingM, ...compare(config), config });
}
console.log(JSON.stringify({ coreVersion: CORE_VERSION, coreSha256: coreHash, node: process.version, results }, null, 2));
