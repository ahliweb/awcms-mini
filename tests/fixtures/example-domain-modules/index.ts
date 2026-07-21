/**
 * In-repo TEST-SUPPORT example domain modules (ADR-0024).
 *
 * A small, self-contained set of illustrative DOMAIN modules used ONLY by
 * tests to exercise the base composition/enforcement machinery against
 * realistic module metadata the reviewed base itself deliberately never
 * ships:
 *
 *   - Module-composition validation (Issue #740) — proves the composition
 *     rule engine validates a registry that includes example domain
 *     modules (dependency DAG, capability binding, deployment profile,
 *     navigation, job descriptor) exactly as it would for a domain module
 *     added directly to `src/modules/`.
 *   - ERP extension readiness contracts (Issue #755, ADR-0020) — the
 *     `example_erp_extension` module + its `posting-engine.ts` /
 *     `period-lock-adapter.ts` exercise `_shared/business-transaction-contract.ts`
 *     and `_shared/ports/period-lock-port.ts` end to end (pure/in-memory).
 *   - SaaS commercial contract contribution (Issue #874) — `example_loyalty`
 *     contributes a feature/meter/quota to prove the registry validates a
 *     domain module's `serviceCatalog` metadata.
 *
 * These modules are NEVER registered in the real base registry
 * (`src/modules/index.ts`) — they are imported only by the tests that need
 * example domain metadata to assert base enforcement behavior against.
 */
import type { ModuleDescriptor } from "../../../src/modules/_shared/module-contract";
import { exampleCrmModule } from "./modules/example-crm/module";
import { exampleLoyaltyModule } from "./modules/example-loyalty/module";
import { exampleErpExtensionModule } from "./modules/example-erp-extension/module";

/** The example domain modules a test composes with `listBaseModules()`. */
export const exampleDomainModules: readonly ModuleDescriptor[] = [
  exampleCrmModule,
  exampleLoyaltyModule,
  exampleErpExtensionModule
];
