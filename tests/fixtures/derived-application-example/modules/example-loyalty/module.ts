/**
 * Minimal fixture module (Issue #740, epic #738 `platform-evolution`,
 * Wave 1) — sibling of `example_crm`. NOT part of the base registry (see
 * that module's own header comment for the full rationale).
 *
 * Declares a lifecycle dependency on `example_crm` — an
 * APPLICATION-module-to-APPLICATION-module edge — to prove composition's
 * reused `validateModuleDependencyGraph` walks the whole merged (base +
 * application) graph, not just base-to-application edges. Consumes
 * `example_crm`'s `example_crm_directory` capability as a REQUIRED (not
 * `optional: true`) binding, to prove `capability_provider_missing`
 * resolves correctly (no issue) when the provider is present in the same
 * application registry.
 */
import { defineModule } from "../../../../../src/modules/_shared/module-contract";

export const exampleLoyaltyModule = defineModule({
  key: "example_loyalty",
  name: "Example Loyalty (fixture)",
  version: "0.1.0",
  status: "experimental",
  description:
    "Minimal in-repo fixture derived-application module (Issue #740) — illustrates a loyalty-points feature that reads the sibling example_crm fixture module's contact directory capability. Never registered in the base repository.",
  dependencies: ["tenant_admin", "identity_access", "example_crm"],
  type: "derived",
  capabilities: {
    consumes: [
      { capability: "example_crm_directory", providedBy: "example_crm" }
    ]
  },
  permissions: [
    {
      activityCode: "points",
      action: "read",
      description: "Read example loyalty point balances (fixture)"
    }
  ]
});
