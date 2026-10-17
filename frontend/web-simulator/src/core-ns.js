// core 側のモジュールを名前空間で受ける唯一の場所（dev-dashboard/src/core-ns.js と同じ考え方）。
// core は読み取り専用。このアプリからは変更しない。
import * as core from '../../../core/runwave-core.js';
import * as scenariosNs from '../../../core/scenarios.js';
import * as adapterNs from '../../../core/api-adapter.js';

import * as routeNs from '../../../core/route-core.js';

export { routeNs, core, scenariosNs, adapterNs };
