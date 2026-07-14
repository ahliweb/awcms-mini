/**
 * Minimal fixture module (Issue #755, epic #738 `platform-evolution` Wave
 * 4, ADR-0019) — a sample ERP extension proving ADR-0019's contracts are
 * actually consumable by composition, NOT part of the base registry (same
 * "never imported by `src/modules/index.ts`" rule every sibling fixture
 * module in this directory follows).
 *
 * Illustrates the shape a REAL, separately-repositoried ERP extension
 * would take: it depends only on base Core modules, CONSUMES base
 * capabilities (never a direct table/import into `profile_identity`/
 * `organization_structure`), contributes a `reporting` projection (Issue
 * #753) driven by its own posting-result domain event, and owns ALL of
 * its ERP-specific tables in its own reserved migration range (`sql/
 * 901_example_erp_extension_schema.sql`, illustration only, see that
 * file's own header) — never in the base's `sql/` directory or module
 * registry, per ADR-0019's explicit exclusion of chart-of-accounts/
 * journal/inventory-valuation/sales/procurement/AR-AP/payroll/tax/asset/
 * manufacturing tables from this repository.
 *
 * The extension's own posting engine (`posting-engine.ts`) and period-
 * lock adapter (`period-lock-adapter.ts`) in this same directory
 * demonstrate `_shared/business-transaction-contract.ts` and `_shared/
 * ports/period-lock-port.ts` end to end — idempotent posting, fail-closed
 * period lock, cross-tenant/legal-entity mismatch rejection, and reversal-
 * as-a-new-transaction — all exercised by
 * `tests/unit/erp-extension-contracts.test.ts` with zero database/network
 * access (pure, in-memory reference implementation, same "illustration
 * only" posture every module in this fixture directory keeps).
 */
import { defineModule } from "../../../../../src/modules/_shared/module-contract";

export const exampleErpExtensionModule = defineModule({
  key: "example_erp_extension",
  name: "Example ERP Extension (fixture)",
  version: "0.1.0",
  status: "experimental",
  description:
    "Minimal in-repo fixture derived-application module (Issue #755, ADR-0019) — illustrates a sample ERP extension consuming this repository's party/scope/period-lock/posting/reporting-projection contracts without adding any accounting/inventory/sales/procurement/payroll/tax domain table to the base. Never registered in the base repository.",
  dependencies: ["tenant_admin", "identity_access"],
  type: "derived",
  capabilities: {
    consumes: [
      // Canonical party reference (Issue #748) — the extension's own
      // "customer"/"supplier"/"employee" contextual-role tables reference
      // a `profile_identity` party id, never duplicate the party record.
      {
        capability: "party_directory",
        providedBy: "profile_identity",
        optional: true
      },
      // Legal-entity/organization-unit scope resolution (Issue #749) —
      // the extension resolves `BusinessTransactionReference.
      // legalEntityScope` through this capability, never by trusting a
      // scope id from request input directly.
      {
        capability: "organization_hierarchy_resolution",
        providedBy: "organization_structure",
        optional: true
      }
    ]
  },
  permissions: [
    {
      activityCode: "postings",
      action: "read",
      description: "Read example ERP extension posting results (fixture)"
    }
  ],
  navigation: [
    {
      labelKey: "fixture.example_erp_extension.nav_postings",
      path: "/admin/example-erp-extension/postings",
      order: 901,
      requiredPermission: "example_erp_extension.postings.read"
    }
  ],
  // Contributes a reporting projection (Issue #753) driven entirely by
  // its OWN posting-result domain event — `reporting`'s generic engine
  // never reads this extension's ledger tables directly (ADR-0013 §6).
  // `consumerName` here is illustrative only (this fixture is never wired
  // into `domain-event-runtime/infrastructure/consumer-registry.ts`'s
  // real `DOMAIN_EVENT_CONSUMERS` array) — a real extension registers its
  // own consumer entry there, in its own forked/vendored build.
  reportingProjections: [
    {
      key: "example_erp_extension.posting_summary",
      version: 1,
      ownerModuleKey: "example_erp_extension",
      scope: "tenant",
      description:
        "Fixture-only projection — counts posted accounting-posting results per tenant, driven by the extension's own posting-result domain event (never a base table read).",
      source: {
        strategy: "domain_event",
        events: [
          {
            eventType: "example_erp_extension.posting.result_recorded",
            eventVersion: "1.0"
          }
        ],
        consumerName: "example_erp_extension.posting_summary_projector"
      },
      // Rebuild recomputes directly from `awcms_mini_domain_events` (the
      // authoritative outbox table `domain_event_runtime` owns), never by
      // re-triggering delivery — same pattern `reporting`'s own
      // `event_activity_summary` projection uses (`reporting/module.ts`).
      rebuildSource: {
        streams: [
          {
            streamKey: "example_erp_extension_posting_results",
            tableName: "awcms_mini_domain_events",
            cursorColumn: "occurred_at",
            metrics: [
              {
                metricKey: "posted_count",
                effect: "increment",
                matchColumn: "event_type",
                matchValue: "example_erp_extension.posting.result_recorded"
              }
            ]
          }
        ]
      },
      metricLabels: {
        posted_count: "Postings completed"
      },
      requiredPermission: "example_erp_extension.postings.read",
      freshness: {
        targetSeconds: 300,
        staleAfterSeconds: 3600,
        errorAfterConsecutiveFailures: 5
      },
      retentionClass:
        "Fixture-only illustration — a real extension registers its own retentionClass rationale, this base repository does not enroll it in data_lifecycle.",
      batchLimit: 500
    }
  ]
});
