// シナリオA/Bとデモ条件を通常とRUNWAVEで比較し、結果をJSONで出力する
// 使い方: node core/run-scenarios.js
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CORE_VERSION, compare } from './runwave-core.js';
import { SCENARIOS, DEMO, SCENARIOS_800M, SCENARIOS_WALK, withModel } from './scenarios.js';

const src = readFileSync(new URL('./runwave-core.js', import.meta.url));
const coreHash = createHash('sha256').update(src).digest('hex').slice(0, 12);

const results = [];
for (const [name, config] of Object.entries(SCENARIOS)) {
  for (const model of ['point', 'length']) {
    const c = withModel(config, model);
    results.push({ scenario: name, crossingModel: model, ...compare(c), config: c });
  }
}
for (const [name, config] of Object.entries(DEMO)) {
  results.push({ scenario: `DEMO.${name}`, crossingModel: 'point', ...compare(config), config });
}
for (const [name, config] of Object.entries(SCENARIOS_800M)) {
  for (const model of ['point', 'length']) {
    const c = withModel(config, model);
    results.push({ scenario: `800M.${name}`, crossingModel: model, ...compare(c), config: c });
  }
}
for (const [name, config] of Object.entries(SCENARIOS_WALK)) {
  results.push({ scenario: `WALK.${name}`, crossingModel: 'point', ...compare(config), config });
}
console.log(JSON.stringify({ coreVersion: CORE_VERSION, coreSha256: coreHash, node: process.version, results }, null, 2));
