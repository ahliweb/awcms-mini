import { defineModule } from "../_shared/module-contract";

/**
 * Single source of truth for this module's high-volume `dataLifecycle`
 * descriptor key, shared with `application/retention-purge.ts` so the purge
 * function and the registry entry a legal hold is created against never drift.
 */
export const USAGE_METERING_EVENTS_LIFECYCLE_KEY = "usage_metering.events";

/**
 * `usage_metering` — the FOURTH SaaS control-plane module (Issue #875, epic
 * #868, Wave 1, ADR-0022). Admitted as an Official Optional Business Foundation:
 * in-repo reviewed code, opt-in per tenant, and `defaultTenantState: "disabled"`
 * (ADR-0022 §7) so a LAN/offline deployment that never activates the control
 * plane keeps it fully inert. TENANT-SCOPED (every table `tenant_id` + `ENABLE`
 * + `FORCE RLS`, predicate ALWAYS AND ONLY `tenant_id`, no soft super-tenant).
 *
 * It provides a trustworthy metering foundation: owning modules emit reviewed,
 * numeric-only meter EVENTS (idempotent, privacy-minimized) in their OWN commit
 * through the `usage_append` port; an async, resumable worker DETERMINISTICALLY
 * materializes usage WINDOWS from the immutable events + signed CORRECTIONS; a
 * reconciliation pass recomputes windows from the immutable source and flags
 * drift; and the read-only `usage_aggregate` port exposes effective usage + a
 * FAIL-CLOSED quota decision (combining #871's entitlement limit with the
 * authoritative live usage). Meter keys, aggregation semantics, bounds, and
 * signed-correction admissibility all resolve against the #874 single source;
 * an unknown meter/aggregation fails closed. NOT subscription/invoice pricing
 * (that is #876) and NOT application telemetry.
 */
export const usageMeteringModule = defineModule({
  key: "usage_metering",
  name: "Usage Metering",
  version: "0.1.0",
  status: "active",
  type: "domain",
  // Default-disabled per tenant (ADR-0022 §7 / Medium-3) — the mechanism read by
  // `resolveModuleEnabled`, the SSR permission gate, the nav registry, and the
  // tenant-module matrix; gated by `tests/unit/module-governance-default-
  // disabled.test.ts`.
  defaultTenantState: "disabled",
  description:
    "Provider-neutral SaaS control-plane usage metering (Issue #875, epic #868 Wave 1, ADR-0022) — the FOURTH control-plane module and a tenant-scoped one (every table tenant_id + ENABLE + FORCE RLS, predicate ALWAYS AND ONLY tenant_id). Owning modules emit reviewed, numeric-only meter EVENTS in their OWN commit through the transaction-safe usage_append port (the events table is the transactional outbox); identity binds (tenant, producer, meter, sourceEventId, sourceVersion) so a duplicate producer event is counted once. An async, resumable worker (lease + write-once checkpoint + bounded batch + retry + replay) DETERMINISTICALLY materializes usage WINDOWS from the immutable events + signed CORRECTIONS (recompute-from-source, so a rebuild reproduces stored aggregates and a replay never double-counts); late/out-of-order events recompute their window deterministically and increment a late counter. Corrections link to the original event and NEVER mutate it (append-only, DB-trigger enforced). Reconciliation independently recomputes windows and flags any drift/missing. The read-only usage_aggregate port exposes effective usage + a FAIL-CLOSED quota decision (combining #871's effective_entitlement limit with authoritative live usage — a hard quota denies when usage is unavailable, never relying solely on a stale cache). Meter keys, aggregation semantics (sum/max/last/unique_count), bounds, and signed-correction admissibility resolve against the #874 single source; an unknown meter fails closed. NO PII / no raw payloads: exact numeric quantity + admitted bounded dimensions only. High-volume events are registered with data_lifecycle (retention/partition/legal-hold/delegated purge). Provides usage to subscription billing (#876). NOT subscription/invoice pricing and NOT application telemetry.",
  // ADR-0022 §2 lifecycle dependencies (active first): tenant_admin,
  // identity_access, domain_event_runtime, data_lifecycle. `logging` for
  // recordAuditEvent (same as the sibling control-plane modules).
  // effective_entitlement is CONSUMED via CAPABILITY (below), not a hard
  // dependency (mirrors tenant_entitlement's own consumption of
  // service_catalog_read) — the tenant_entitlement gate itself decides the
  // fail-closed answer. Acyclic; no base/core -> control-plane edge.
  dependencies: [
    "tenant_admin",
    "identity_access",
    "domain_event_runtime",
    "data_lifecycle",
    "logging"
  ],
  capabilities: {
    // The transaction-safe append seam owning modules record usage through, and
    // the read-only aggregate/quota-decision contract billing (#876) reads.
    provides: ["usage_append", "usage_aggregate"],
    // Reads the tenant's fail-closed entitlement (the quota LIMIT) through
    // #871's read-only port at its own composition root — never a direct import.
    consumes: [
      { capability: "effective_entitlement", providedBy: "tenant_entitlement" }
    ]
  },
  // Neutral, non-authoritative EXAMPLE meters/quota (the "ship a neutral example
  // of your own mechanism" precedent reference_data/service_catalog set) — they
  // exercise every aggregation path (sum/max/last/unique_count) + signed
  // corrections + a quota end-to-end. A derived app contributes its own via
  // application-registry.ts. Aggregated + validated by the single source
  // `src/modules/_shared/saas-contract-registry.ts`.
  serviceCatalog: {
    meters: [
      {
        key: "usage_metering.sample_actions",
        ownerModuleKey: "usage_metering",
        description:
          "Example billable action counter (sum) that accepts signed corrections — exercises the sum + correction path.",
        eventVersion: "1.0",
        valueType: "count",
        aggregation: "sum",
        correction: "signed_delta",
        classification: "billable",
        privacyClassification: "non_personal",
        bounds: { minValue: 0, maxValue: 9007199254740991 }
      },
      {
        key: "usage_metering.sample_peak",
        ownerModuleKey: "usage_metering",
        description:
          "Example gauge peak (max) — exercises the max aggregation path.",
        eventVersion: "1.0",
        valueType: "gauge",
        aggregation: "max",
        correction: "none",
        classification: "informational",
        privacyClassification: "non_personal",
        bounds: { minValue: 0, maxValue: 9007199254740991 }
      },
      {
        key: "usage_metering.sample_level",
        ownerModuleKey: "usage_metering",
        description:
          "Example last-value gauge (last) — exercises the last-value aggregation path.",
        eventVersion: "1.0",
        valueType: "gauge",
        aggregation: "last",
        correction: "none",
        classification: "informational",
        privacyClassification: "non_personal",
        bounds: { minValue: 0, maxValue: 9007199254740991 }
      },
      {
        key: "usage_metering.sample_actors",
        ownerModuleKey: "usage_metering",
        description:
          "Example distinct active-subject count (unique_count) keyed by a pseudonymous dimension — exercises the distinct-count path.",
        eventVersion: "1.0",
        valueType: "count",
        aggregation: "unique_count",
        correction: "none",
        classification: "informational",
        privacyClassification: "pseudonymous",
        bounds: { minValue: 0, maxValue: 9007199254740991 }
      }
    ],
    quotas: [
      {
        key: "usage_metering.sample_action_quota",
        ownerModuleKey: "usage_metering",
        description:
          "Example hard monthly limit on billable sample actions — exercises the quota decision path.",
        meterKey: "usage_metering.sample_actions",
        unit: "action",
        resetPeriod: "monthly",
        enforcement: "hard"
      }
    ],
    commercialEvents: [
      {
        eventType: "awcms-mini.usage-metering.usage.corrected",
        eventVersion: "1.0",
        ownerModuleKey: "usage_metering",
        kind: "commercial",
        description:
          "A signed usage correction/reversal was applied to a billable meter."
      },
      {
        eventType: "awcms-mini.usage-metering.usage.reconciled",
        eventVersion: "1.0",
        ownerModuleKey: "usage_metering",
        kind: "lifecycle",
        description:
          "A usage reconciliation run compared recomputed windows to stored aggregates."
      }
    ]
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.usage-metering.usage.corrected",
      "awcms-mini.usage-metering.usage.reconciled"
    ]
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_usage_metering",
      path: "/admin/usage-metering",
      order: 132,
      requiredPermission: "usage_metering.usage.read"
    }
  ],
  permissions: [
    {
      activityCode: "usage",
      action: "read",
      description:
        "Read a tenant's usage timeline, meter windows, and aggregate freshness"
    },
    {
      activityCode: "quota",
      action: "read",
      description:
        "Read a tenant's effective usage quota decisions (limit vs current usage, fail-closed when stale)"
    },
    {
      activityCode: "corrections",
      action: "read",
      description: "List a tenant's usage corrections/reversals"
    },
    {
      activityCode: "corrections",
      action: "correct",
      description:
        "Apply a signed usage correction/reversal linked to an original event (never mutates the source event)"
    },
    {
      activityCode: "reconciliation",
      action: "read",
      description: "List a tenant's usage reconciliation runs"
    },
    {
      activityCode: "reconciliation",
      action: "reconcile",
      description:
        "Run a usage reconciliation that recomputes windows from immutable events and flags drift"
    },
    {
      activityCode: "aggregation",
      action: "rebuild",
      description:
        "Request a full deterministic rebuild of a tenant's usage aggregate windows from immutable events"
    }
  ],
  jobs: [
    {
      command: "bun run usage-metering:aggregate",
      purpose:
        "Drain the usage events/corrections outbox for every active tenant and deterministically (re)materialize the touched usage windows — lease + checkpoint + bounded batch, recompute-from-source (idempotent replay), and consume any requested rebuild. A no-op tick when there is no backlog.",
      recommendedSchedule: "Every 30-60 seconds via cron/systemd timer.",
      environmentNotes:
        "Pure PostgreSQL/in-process operation — no external network egress. Safe in offline/LAN deployments.",
      safeInOfflineLan: true
    },
    {
      command: "bun run usage-metering:purge",
      purpose:
        "Delete awcms_mini_usage_events / awcms_mini_usage_corrections rows past their retention cutoff for every active tenant, in bounded batches, honoring legal holds (the data_lifecycle delegated adopter for usage_metering.events).",
      recommendedSchedule: "Daily via cron/systemd timer.",
      environmentNotes:
        "Pure database operation — no external network dependency.",
      safeInOfflineLan: true
    }
  ],
  // Issue #745 (data_lifecycle) — the highest-volume table this module owns is
  // registered as a "delegated" adopter: data_lifecycle's dry-run planner may
  // READ it for backlog visibility, but the real purge stays owned by
  // `purgeExpiredUsageEvents` (`bun run usage-metering:purge`), which honors
  // legal holds against this same key.
  dataLifecycle: [
    {
      key: USAGE_METERING_EVENTS_LIFECYCLE_KEY,
      tableName: "awcms_mini_usage_events",
      ownerModuleKey: "usage_metering",
      scope: "tenant",
      cursorColumn: "received_at",
      retentionClass: "financial_tax",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 730,
      partition: {
        eligible: true,
        granularity: "monthly",
        rationale:
          "By far the highest insert rate of any table this module owns (one row per metered producer event), append-only, age-based purge only — a textbook monthly range-partition candidate. Not automated by this issue (destructive migration is out of scope); tracked as partitioning runbook guidance, see docs/awcms-mini/data-lifecycle.md."
      },
      archive: {
        archivable: false,
        rationale:
          "Current reality: purgeExpiredUsageEvents performs a straight bounded age-based DELETE with no archive step. Aggregates (the billing-relevant summary) are retained separately and longer; archiving the raw events is a natural follow-up, not implemented by this issue — declaring archivable:true without a real archive step would be inaccurate."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Matches purgeExpiredUsageEvents exactly — age-only cutoff, corrections purged first, then events with no surviving correction (respects the FK)."
      },
      legalHold: {
        applicable: true,
        precedence: "overrides_retention"
      },
      requiredIndexes: [
        {
          columns: ["tenant_id", "received_at"],
          purpose:
            "awcms_mini_usage_events_retention_idx (migration 087) — the same index purgeExpiredUsageEvents' age-based bounded DELETE relies on."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact exists yet (archive.archivable is false above). Aggregates are the durable billing summary and are retained beyond the raw events.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run usage-metering:purge",
        purgeFunctionRef:
          "src/modules/usage-metering/application/retention-purge.ts#purgeExpiredUsageEvents",
        description:
          "Deletes usage corrections then events past their retention cutoff for a tenant, in bounded batches, honoring an active legal hold on usage_metering.events. The same function the scheduled job calls."
      }
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/usage-metering"
  }
});
