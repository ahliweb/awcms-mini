import { defineModule } from "../_shared/module-contract";

/**
 * Single source of truth for this module's `dataLifecycle` descriptor key,
 * shared with `application/form-draft-purge.ts` so the actual purge
 * function and the registry entry a legal hold is created against can never
 * drift apart (security-auditor finding, PR #773).
 */
export const FORM_DRAFTS_LIFECYCLE_KEY = "form_drafts.form_drafts";

export const formDraftsModule = defineModule({
  key: "form_drafts",
  name: "Form Drafts",
  version: "1.0.0",
  status: "active",
  description:
    "Generic, domain-agnostic server-side draft store for the reusable wizard pattern (create/update/read/submit/delete a tenant-scoped JSONB payload, denylist-validated against secret-shaped fields). No domain-specific logic — a derived module owns what a draft's payload actually means.",
  dependencies: ["identity_access"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/form-drafts"
  },
  jobs: [
    {
      command: "bun run form-drafts:purge",
      purpose:
        "Expire overdue draft rows, then physically delete expired/abandoned drafts past the retention cutoff, for every active tenant.",
      recommendedSchedule: "Daily via cron/systemd timer.",
      environmentNotes:
        "Pure database operation — no external network dependency.",
      safeInOfflineLan: true
    }
  ],
  // Issue #745 (data_lifecycle, epic #738) — registered as a representative
  // "delegated" adopter: data_lifecycle's dry-run planner may READ this
  // table for backlog visibility, but real purge stays owned by
  // `expireOverdueFormDrafts`/`purgeExpiredFormDrafts`
  // (`bun run form-drafts:purge`), unchanged.
  dataLifecycle: [
    {
      key: FORM_DRAFTS_LIFECYCLE_KEY,
      tableName: "awcms_mini_form_drafts",
      ownerModuleKey: "form_drafts",
      scope: "tenant",
      cursorColumn: "created_at",
      retentionClass: "operational_queue",
      retentionMinDays: 1,
      retentionMaxDays: 365,
      defaultRetentionDays: 30,
      partition: {
        eligible: false,
        rationale:
          "Scratch wizard-progress data with a short (30d default) retention window and expected low-to-moderate volume relative to audit/analytics tables — partitioning is not justified without real volume evidence to the contrary."
      },
      archive: {
        archivable: false,
        rationale:
          "Draft payloads are in-progress user input scratch state, not a business record of lasting value — archiving before purge would preserve exactly the kind of ephemeral data this table's short retention window is meant to let go of."
      },
      deletion: {
        mode: "status_transition_then_purge",
        rationale:
          "Matches expireOverdueFormDrafts (status -> 'expired') followed by purgeExpiredFormDrafts' physical DELETE exactly — a two-phase status transition then purge, not a direct hard delete."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id"],
          purpose:
            "awcms_mini_form_drafts_tenant_idx (migration 019) — sufficient for this descriptor's dry-run count query; the authoritative purge query path is owned by form_drafts' own awcms_mini_form_drafts_tenant_expiry_idx (tenant_id, status, expires_at)."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore (docs/awcms-mini/resilience-dr-verification.md); no standalone archive artifact exists (archive.archivable is false above) — by design, draft scratch state is not archived.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run form-drafts:purge",
        purgeFunctionRef:
          "src/modules/form-drafts/application/form-draft-purge.ts#purgeExpiredFormDrafts",
        description:
          "Two-phase: expireOverdueFormDrafts transitions overdue drafts to status='expired', then purgeExpiredFormDrafts physically deletes expired/abandoned drafts past FORM_DRAFT_RETENTION_DAYS (default 30d). Unchanged by Issue #745."
      }
    }
  ]
});
