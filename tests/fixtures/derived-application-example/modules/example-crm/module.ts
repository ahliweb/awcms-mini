/**
 * Minimal fixture module (Issue #740, epic #738 `platform-evolution`,
 * Wave 1) — illustrates what a real derived repository's own
 * `src/modules/<domain>/module.ts` looks like. NOT part of the base
 * registry: never imported by `src/modules/index.ts`, only by
 * `tests/fixtures/derived-application-example/application-registry.ts`
 * and the composition tests that exercise it
 * (`tests/unit/module-composition-fixture.test.ts`).
 *
 * Depends on two base Core modules (`tenant_admin`, `identity_access`) —
 * the same baseline every real derived application module declares
 * (`docs/awcms-mini/derived-application-guide.md`) — to prove composition
 * correctly validates a lifecycle dependency edge from an APPLICATION
 * module onto a BASE module. Provides the `example_crm_directory`
 * capability that the sibling `example_loyalty` fixture module consumes.
 */
import { defineModule } from "../../../../../src/modules/_shared/module-contract";

export const exampleCrmModule = defineModule({
  key: "example_crm",
  name: "Example CRM (fixture)",
  version: "0.1.0",
  status: "experimental",
  description:
    "Minimal in-repo fixture derived-application module (Issue #740) — illustrates a contact directory a real derived application (e.g. AWPOS's own crm-communication module) might own. Never registered in the base repository.",
  dependencies: ["tenant_admin", "identity_access"],
  type: "derived",
  // Offline/LAN-first is the default expectation for a POS-shaped derived
  // application (`docs/awcms-mini/derived-application-guide.md`'s AWPOS
  // illustration) — declared here purely to exercise Issue #740's
  // deployment-profile composition metadata; its own dependencies
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
