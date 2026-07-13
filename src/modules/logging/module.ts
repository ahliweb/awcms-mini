import { defineModule } from "../_shared/module-contract";

export const loggingModule = defineModule({
  key: "logging",
  name: "Logging & Audit Trail",
  version: "1.0.0",
  status: "active",
  description:
    "Cross-module audit trail (awcms_mini_audit_events), structured JSON logging, and correlation ID propagation. Complements, not replaces, domain events and per-module audit tables.",
  dependencies: ["tenant_admin"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/logs"
  },
  jobs: [
    {
      command: "bun run logs:audit:purge",
      purpose:
        "Delete awcms_mini_audit_events rows past their retention cutoff for every active tenant, in bounded batches.",
      recommendedSchedule: "Daily via cron/systemd timer.",
      environmentNotes:
        "Pure database operation — no external network dependency.",
      safeInOfflineLan: true
    }
  ],
  // Issue #745 (data_lifecycle, epic #738) — registered as a representative
  // "delegated" adopter: data_lifecycle's dry-run planner may READ this
  // table for backlog visibility, but real purge stays owned by
  // `purgeExpiredAuditEvents` (`bun run logs:audit:purge`) above,
  // unchanged. See `.claude/skills/awcms-mini-data-lifecycle/SKILL.md`.
  dataLifecycle: [
    {
      key: "logging.audit_events",
      tableName: "awcms_mini_audit_events",
      ownerModuleKey: "logging",
      scope: "tenant",
      cursorColumn: "created_at",
      retentionClass: "audit_security",
      retentionMinDays: 365,
      retentionMaxDays: 1825,
      defaultRetentionDays: 730,
      partition: {
        eligible: true,
        granularity: "monthly",
        rationale:
          "High insert volume, append-only, age-based purge only (no updates) — a textbook monthly range-partition candidate. Not automated by this issue (destructive migration of an existing table is explicitly out of scope) — tracked as partitioning runbook guidance for a future issue, see docs/awcms-mini/data-lifecycle.md §Partitioning policy and runbook guidance."
      },
      archive: {
        archivable: false,
        rationale:
          "Current reality: purgeExpiredAuditEvents performs a straight age-based DELETE with no archive step. Adding one is a natural follow-up (audit trail is a strong archive candidate for ISO 27001/22301 evidence) but is not implemented by this issue — declaring archivable:true here without a real archive step would be inaccurate, not aspirational."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Matches purgeExpiredAuditEvents' existing behavior exactly — age-only cutoff, no cascading FK children (migration 011)."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id", "created_at"],
          purpose:
            "awcms_mini_audit_events_tenant_created_idx (migration 011) — the same index purgeExpiredAuditEvents' own age-based DELETE already relies on."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore (docs/awcms-mini/resilience-dr-verification.md); no standalone archive artifact exists yet (archive.archivable is false above).",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run logs:audit:purge",
        purgeFunctionRef:
          "src/modules/logging/application/audit-purge.ts#purgeExpiredAuditEvents",
        description:
          "Deletes rows past AUDIT_LOG_RETENTION_DAYS (default 730d) in bounded batches of AUDIT_EVENT_PURGE_BATCH_LIMIT (5000), auditing the purge itself as a new audit event. Unchanged by Issue #745 — this descriptor documents compatibility, it does not replace or duplicate this logic."
      }
    }
  ]
});
