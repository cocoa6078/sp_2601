// core 側のモジュールを「名前空間」でまとめて受ける唯一の場所。
// 名前つき import（import { step } from ...）だと、core から export が消えたときにモジュール全体が読み込めず白画面になる。
// 名前空間 import なら、無い export は undefined になるだけなので、契約チェック（core-compat.js）で検出して該当機能だけ止められる。
import * as core from '../../../core/runwave-core.js';
import * as scenariosNs from '../../../core/scenarios.js';
import * as adapterNs from '../../../core/api-adapter.js';

export { core, scenariosNs, adapterNs };
