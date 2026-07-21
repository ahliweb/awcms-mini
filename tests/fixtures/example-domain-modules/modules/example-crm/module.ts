/**
 * Minimal TEST-SUPPORT example domain module (originally Issue #740, epic
 * #738 `platform-evolution`, Wave 1; ADR-0024). Illustrates realistic
 * DOMAIN module metadata (a capability, permissions/navigation/jobs, a
 * deployment-profile claim) the reviewed base itself deliberately never
 * ships — used ONLY by tests to exercise the base composition machinery.
 * NOT part of the base registry: never imported by `src/modules/index.ts`,
 * only by `tests/fixtures/example-domain-modules/index.ts` and the
 * composition tests that compose it with `listBaseModules()`
 * (`tests/unit/module-composition-fixture.test.ts`).
 *
 * Depends on two base Core modules (`tenant_admin`, `identity_access`) to
 * prove the composition rule engine validates a lifecycle dependency edge
 * from a domain module onto a base module. Provides the
 * `example_crm_directory` capability that the sibling `example_loyalty`
 * example module consumes.
 */
import { defineModule } from "../../../../../src/modules/_shared/module-contract";

export const exampleCrmModule = defineModule({
  key: "example_crm",
  name: "Example CRM (fixture)",
  version: "0.1.0",
  status: "experimental",
  description:
    "Minimal in-repo test-support domain module — illustrates a contact directory used only to exercise base composition/enforcement. Never registered in the base repository.",
  dependencies: ["tenant_admin", "identity_access"],
  type: "domain",
  // Offline/LAN-first deployment-profile claim declared here purely to
  // exercise the composition deployment-profile metadata; its own dependencies
  // (`tenant_admin`/`identity_access`) declare no `deploymentProfiles`
  // constraint, so this is compatible by construction (absence = every
  // profile), not a real restriction.
  compatibility: {
    deploymentProfiles: ["development", "offline-lan"]
  },
  capabilities: {
    provides: ["example_crm_directory"]
  },
  permissions: [
    {
      activityCode: "contacts",
      action: "read",
      description: "Read example CRM contact directory entries (fixture)"
    }
  ],
  navigation: [
    {
      labelKey: "fixture.example_crm.nav_contacts",
      path: "/admin/example-crm/contacts",
      order: 900,
      requiredPermission: "example_crm.contacts.read"
    }
  ],
  jobs: [
    {
      command: "bun run example-crm:reconcile",
      purpose:
        "Fixture-only job descriptor — proves composition validates contributed application modules' job shape (`validateJobDescriptor`), never actually registered as a real package.json script.",
      recommendedSchedule: "N/A — fixture only.",
      safeInOfflineLan: true
    }
  ]
});
