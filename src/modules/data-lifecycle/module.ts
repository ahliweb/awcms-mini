import { defineModule } from "../_shared/module-contract";
import { DATA_LIFECYCLE_PERMISSIONS } from "./domain/data-lifecycle-permissions";

/**
 * `data_lifecycle` (Issue #745, epic #738 platform-evolution Wave 1).
 * `type: "system"` — ADR-0013 §1 classifies this as a System Foundation
 * candidate (Wave 1), the same layer as `logging`/`sync_storage`/
 * `visitor_analytics`: platform/governance infrastructure every tenant
 * shares the mechanism of, not a tenant-facing business feature.
 *
 * This module owns exactly its OWN policy/execution-state tables (legal
 * holds, cursors, archive manifests, run history) — it never owns another
 * module's high-volume table directly (ADR-0013 §6 "no shared-table
 * write"). The high-volume table DESCRIPTORS this engine operates on are
 * declared by each OWNING module's own `module.ts` (`dataLifecycle`
 * field, `_shared/module-contract.ts`) — see `logging`/`visitor_analytics`/
 * `form_drafts` for the three representative "delegated" adopters this
 * issue registers, and this module's own `dataLifecycle` entry below for
 * the one "generic"-execution descriptor this issue proves the engine
 * against end-to-end (its own run-history table).
 */
export const dataLifecycleModule = defineModule({
  key: "data_lifecycle",
  name: "Data Lifecycle",
  version: "0.1.0",
  status: "active",
  description:
    "Module-contributed high-volume table registry and safe lifecycle engine: retention/partition/archive/legal-hold/purge descriptors declared by owning modules, dry-run planning, bounded archive/purge on the shared worker runner, a provider-neutral archive port, and legal holds that override ordinary retention/purge (Issue #745, epic #738).",
  dependencies: ["tenant_admin", "identity_access", "logging"],
  type: "system",
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/data-lifecycle"
  },
  permissions: [
    {
      activityCode: "registry",
      action: "read",
      description:
        "Read the high-volume table lifecycle registry (code-declared metadata only, never row contents)"
    },
    {
      activityCode: "legal_hold",
      action: "read",
      description: "Read legal hold records"
    },
    {
      activityCode: "legal_hold",
      action: "create",
      description: "Create a legal hold"
    },
    {
      activityCode: "legal_hold",
      action: "release",
      description: "Release (end) an active legal hold"
    },
    {
      activityCode: "plan",
      action: "analyze",
      description: "Trigger an on-demand, read-only dry-run lifecycle plan"
    },
    {
      activityCode: "runs",
      action: "read",
      description: "Read lifecycle run history (aggregated counts only)"
    }
  ],
  jobs: [
    {
      command: "bun run data-lifecycle:archive-purge",
      purpose:
        "Archive (where applicable) and purge rows past retention for every registered generic-execution descriptor; record a dry-run backlog snapshot for every delegated (existing-adopter) descriptor.",
      recommendedSchedule: "Daily via cron/systemd timer.",
      environmentNotes:
        "Database plus local filesystem operation by default (local/offline archive adapter) — no external network dependency unless a future external object-storage adapter is configured.",
      safeInOfflineLan: true
    }
  ],
  dataLifecycle: [
    {
      key: "data_lifecycle.data_lifecycle_runs",
      tableName: "awcms_mini_data_lifecycle_runs",
      ownerModuleKey: "data_lifecycle",
      scope: "tenant",
      cursorColumn: "created_at",
      retentionClass: "operational_queue",
      retentionMinDays: 30,
      retentionMaxDays: 1825,
      defaultRetentionDays: 180,
      partition: {
        eligible: false,
        rationale:
          "Expected row volume is one row per (tenant, descriptor, invocation) — orders of magnitude smaller than the tables this module purges on behalf of others; native PostgreSQL partitioning is not justified until real volume evidence says otherwise (issue #745: automate only where PostgreSQL safety can be proven)."
      },
      archive: {
        archivable: true,
        format: "jsonl",
        port: "local_offline",
        rationale:
          "Run history is retention/purge EVIDENCE itself (ISO/IEC 27001/22301 audit trail of what was purged and when) — archiving before physical delete preserves that evidence beyond the live retention window, at negligible cost given the table's low expected volume."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "No PII beyond opaque UUIDs already scoped by RLS plus aggregate counts — anonymization has nothing further to remove; hard delete after archive is sufficient."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id", "descriptor_key", "created_at"],
          purpose: "Per-descriptor run history lookup, newest first."
        },
        {
          columns: ["tenant_id", "run_type", "created_at"],
          purpose: "Filter run history by type (dry_run/archive/purge)."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore (docs/awcms-mini/resilience-dr-verification.md); archived rows additionally have a standalone JSONL artifact restorable independently of a full database restore.",
      executionMode: "generic"
    }
  ]
});

export { DATA_LIFECYCLE_PERMISSIONS };
