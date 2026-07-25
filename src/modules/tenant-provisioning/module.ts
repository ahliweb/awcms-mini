import {
  defineModule,
  type ProjectionCursorStream
} from "../_shared/module-contract";
import {
  PROVISIONING_OUTCOMES_METRIC_KEYS,
  PROVISIONING_OUTCOMES_PROJECTION_KEY
} from "./domain/projection-keys";

/**
 * ONE stream definition shared by this projection's `source` (steady-state
 * incremental updates) and its `rebuildSource` (full re-scan) — deliberately
 * the same object rather than two copies of the same literal, so a rebuild
 * can never silently disagree with the steady state about which rows count
 * as which metric.
 *
 * `created_at` is the cursor: insert-time only, never updated (the table is
 * append-only under both a trigger and `REVOKE UPDATE, DELETE`, migration
 * 085), which is the append-only-source rule the cursor engine requires.
 */
const PROVISIONING_OUTCOMES_STREAM: ProjectionCursorStream = {
  streamKey: "provisioning_step_attempts",
  tableName: "awcms_mini_tenant_provisioning_step_attempts",
  cursorColumn: "created_at",
  metrics: [
    {
      metricKey: PROVISIONING_OUTCOMES_METRIC_KEYS.attemptTotal,
      effect: "increment"
    },
    {
      metricKey: PROVISIONING_OUTCOMES_METRIC_KEYS.attemptSucceeded,
      effect: "increment",
      matchColumn: "outcome",
      matchValue: "succeeded"
    },
    {
      metricKey: PROVISIONING_OUTCOMES_METRIC_KEYS.attemptFailed,
      effect: "increment",
      matchColumn: "outcome",
      matchValue: "failed"
    },
    {
      metricKey: PROVISIONING_OUTCOMES_METRIC_KEYS.attemptWaiting,
      effect: "increment",
      matchColumn: "outcome",
      matchValue: "waiting"
    },
    {
      metricKey: PROVISIONING_OUTCOMES_METRIC_KEYS.attemptSkipped,
      effect: "increment",
      matchColumn: "outcome",
      matchValue: "skipped"
    }
  ]
};

/**
 * `tenant_provisioning` — the THIRD SaaS control-plane module (Issue #872,
 * epic #868 Wave 1, ADR-0022). Admitted as an Official Optional Business
 * Foundation: in-repo reviewed code, opt-in per tenant, and
 * `defaultTenantState: "disabled"` (ADR-0022 §7) so a LAN/offline deployment
 * that never activates the control plane keeps it fully inert. Provisioning
 * commands are platform-operator only + default-deny.
 *
 * It orchestrates an IDEMPOTENT, RESUMABLE tenant-provisioning run — tenant
 * bootstrap, owner identity, default configuration, optional entitlement
 * assignment (via the #871 `effective_entitlement`/service ports), optional
 * module preset, optional subdomain, and mandatory readiness — with durable
 * checkpoints, bounded retries, lease/lock ownership, explicit compensation
 * classification (reversible/manual/forbidden), and NON-DESTRUCTIVE
 * reconciliation. It REUSES existing tenant/owner/office/config creation
 * (shared `tenant_admin` onboarding helpers) rather than duplicating it, runs
 * provider/async work OUTSIDE the source transaction (outbox/domain events),
 * and NEVER deletes tenant data as compensation. A failed/canceled run leaves
 * the tenant INACTIVE with a visible blocked/failed status + `readiness=blocked`
 * — never active without mandatory security controls.
 *
 * Every table is TENANT-SCOPED (`tenant_id` + `ENABLE` + `FORCE RLS`, predicate
 * ALWAYS AND ONLY `tenant_id` — no soft super-tenant, ADR-0022 §6). It PROVIDES
 * the read-only `provisioning_status` capability and CONSUMES the fail-closed
 * `effective_entitlement` contract (#871).
 */
export const tenantProvisioningModule = defineModule({
  key: "tenant_provisioning",
  name: "Tenant Provisioning",
  version: "0.1.0",
  status: "active",
  type: "domain",
  // Default-disabled per tenant (ADR-0022 §7 / Medium-3) — gated by
  // `tests/unit/module-governance-default-disabled.test.ts`.
  defaultTenantState: "disabled",
  description:
    "Provider-neutral SaaS control-plane tenant provisioning (Issue #872, epic #868 Wave 1, ADR-0022) — the THIRD control-plane module. Admitted as an Official Optional Business Foundation (opt-in per tenant, default-disabled) and tenant-scoped (every table tenant_id + ENABLE + FORCE RLS, predicate ALWAYS AND ONLY tenant_id, ADR-0022 §6 no soft super-tenant). Orchestrates an IDEMPOTENT, RESUMABLE provisioning run from a versioned plan/step registry: tenant record/bootstrap, owner identity, default configuration/locale, optional entitlement assignment (via the tenant_entitlement port), optional module preset, optional subdomain/domain, mandatory readiness, and derived-application contributed steps (via the provisioning_step capability port). Durable checkpoints, bounded retries, lease/lock ownership, idempotency-key replay, explicit compensation classification (reversible/manual/forbidden), and NON-DESTRUCTIVE desired-vs-actual reconciliation. REUSES existing tenant/owner/office/config creation (shared tenant_admin onboarding helpers) rather than duplicating it; runs provider/async work OUTSIDE the source transaction (outbox/domain events); NEVER deletes tenant data as compensation. A failed/canceled run leaves the tenant inactive with a visible blocked/failed status — never active without mandatory security controls. Provisioning commands are platform-operator only + default-deny; provider secrets are references only, never in step payloads/logs. PROVIDES the read-only provisioning_status capability; CONSUMES the fail-closed effective_entitlement contract (#871). LAN/offline safe: provisions with all online/provider steps absent or disabled.",
  // ADR-0022 §2 lifecycle dependencies (active first). `logging` for
  // `recordAuditEvent`; `domain_event_runtime` for `appendDomainEvent`.
  // `tenant_entitlement`/`service_catalog`/`tenant_domain`/`module_management`
  // are consumed via CAPABILITY/composition-root wiring (optional, LAN-safe),
  // NOT hard lifecycle dependencies. Acyclic; no base/core -> control-plane edge.
  dependencies: [
    "tenant_admin",
    "identity_access",
    "module_management",
    "domain_event_runtime",
    "logging"
  ],
  capabilities: {
    // The read-only run/readiness view a downstream module (#873) or operator
    // surface reads without importing this module.
    provides: ["provisioning_status"],
    // Reads the fail-closed effective entitlement at its composition root — never
    // a direct import (ADR-0022 §4, module-boundary).
    consumes: [
      {
        capability: "effective_entitlement",
        providedBy: "tenant_entitlement",
        optional: true
      }
    ]
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.tenant-provisioning.requested",
      "awcms-mini.tenant-provisioning.completed",
      "awcms-mini.tenant-provisioning.failed",
      "awcms-mini.tenant-provisioning.reconciled"
    ]
  },
  jobs: [
    {
      command: "bun run tenant-provisioning:reconcile",
      purpose:
        "Run a non-destructive desired-vs-actual reconciliation for ONE provisioned tenant (reports drift + safe operator actions; never auto-fixes).",
      recommendedSchedule: "on-demand",
      safeInOfflineLan: true,
      environmentNotes:
        "Per-tenant: pass a tenant id (`bun run tenant-provisioning:reconcile <tenantId>` or PROVISIONING_TENANT_ID). Reconciliation is DB-only and safe offline. A FLEET-WIDE batch that scans every provisioned tenant is intentionally DEFERRED to #880 (it needs a purpose-built cross-tenant read-model — a platform operator is not a soft super-tenant, ADR-0022 §6b); until then reconcile on-demand, one tenant at a time (this script or the per-tenant REST endpoint)."
    }
  ],
  navigation: [
    {
      labelKey: "admin.layout.nav_tenant_provisioning",
      path: "/admin/tenant-provisioning",
      order: 132,
      requiredPermission: "tenant_provisioning.requests.read"
    }
  ],
  permissions: [
    {
      activityCode: "requests",
      action: "read",
      description:
        "Read tenant provisioning runs, steps, attempts, results, and timeline"
    },
    {
      activityCode: "requests",
      action: "create",
      description:
        "Request an idempotent tenant provisioning run (bootstraps the target tenant record)"
    },
    {
      activityCode: "requests",
      action: "retry",
      description:
        "Start, resume, or retry a tenant provisioning run from its durable checkpoint"
    },
    {
      activityCode: "requests",
      action: "cancel",
      description:
        "Cancel a tenant provisioning run when safe (records classified compensation; never deletes tenant data)"
    },
    {
      activityCode: "reconciliation",
      action: "check",
      description:
        "Run a non-destructive desired-vs-actual reconciliation of a provisioned tenant"
    }
  ],
  // Issue #880 (epic #868 Wave 3 operations) — this module's own read-model
  // projection, declared here and materialized by `reporting`'s generic
  // engine (Issue #753). `reporting` reads this source table through the
  // cursor contract declared below and writes ONLY its own
  // `awcms_mini_reporting_projection_*` tables; this module never writes a
  // `reporting` table either. Registry-validated by
  // `bun run reporting:projections:registry:check`.
  reportingProjections: [
    {
      key: PROVISIONING_OUTCOMES_PROJECTION_KEY,
      version: 1,
      ownerModuleKey: "tenant_provisioning",
      scope: "tenant",
      description:
        "Provisioning step-attempt outcomes (succeeded/failed/waiting/skipped) for this tenant, incrementally derived from awcms_mini_tenant_provisioning_step_attempts — the append-only attempt log every resumable provisioning run writes one row to per step attempt. Answers 'is provisioning progressing, retrying, or stuck?' without opening each run: a rising attempt_failed with a flat attempt_succeeded is a blocked run, and attempt_waiting is the manual-intervention backlog. The authoritative per-run status/readiness stays in the run itself (drill down), which this projection never replaces and is never an authorization source for.",
      source: {
        strategy: "cursor_table",
        streams: [PROVISIONING_OUTCOMES_STREAM]
      },
      rebuildSource: { streams: [PROVISIONING_OUTCOMES_STREAM] },
      metricLabels: {
        [PROVISIONING_OUTCOMES_METRIC_KEYS.attemptTotal]:
          "Provisioning step attempts",
        [PROVISIONING_OUTCOMES_METRIC_KEYS.attemptSucceeded]: "Succeeded",
        [PROVISIONING_OUTCOMES_METRIC_KEYS.attemptFailed]: "Failed",
        [PROVISIONING_OUTCOMES_METRIC_KEYS.attemptWaiting]:
          "Waiting (manual intervention)",
        [PROVISIONING_OUTCOMES_METRIC_KEYS.attemptSkipped]: "Skipped"
      },
      requiredPermission: "tenant_provisioning.requests.read",
      freshness: {
        // The refresh worker runs every 2 minutes (see `reporting`'s own job
        // descriptor), so one missed cycle is still "current" and roughly
        // five consecutive misses read as "stale".
        targetSeconds: 300,
        staleAfterSeconds: 900,
        errorAfterConsecutiveFailures: 3
      },
      drillDownPath: "/api/v1/tenant-provisioning/requests",
      retentionClass:
        "Not separately registered in data_lifecycle: one row per provisioning step attempt, bounded by the module's own bounded-retry policy (a run has a fixed step list and a max attempt count), so this table does not grow with tenant activity the way an event/telemetry table does.",
      batchLimit: 1000
    }
  ],
  // Issue #930 (epic #868) — fleet-wide operational objectives. Provisioning
  // is the clearest case for why the control plane needs its OWN objectives:
  // a provisioning queue that stops draining is invisible to every tenant
  // (the ones still waiting cannot see it; the ones already provisioned are
  // unaffected) and to every tenant-scoped report (the tenant does not exist
  // yet). Nobody is looking, so the objective has to.
  serviceLevelObjectives: [
    {
      key: "tenant_provisioning.provisioning_backlog_drains",
      ownerModuleKey: "tenant_provisioning",
      title: "Provisioning backlog keeps draining",
      description:
        "The fleet-wide count of non-terminal provisioning attempts stays bounded, so a new tenant always finishes onboarding rather than silently stalling in a queue nobody can see.",
      kind: "backlog",
      metricName: "control_plane_provisioning_backlog",
      dimension: "attemptStatus",
      unit: "count",
      objectiveValue: 50,
      objectiveComparison: "above",
      runbookPath:
        "docs/awcms-mini/control-plane-slo-runbook.md#tenant-provisioning-backlog",
      thresholds: [
        {
          thresholdKey: "backlog_elevated",
          severity: "warning",
          comparison: "above",
          value: 50,
          // Fifteen minutes is longer than a normal burst of signups takes to
          // drain, so this does not fire on healthy load.
          forSeconds: 900,
          operatorAction:
            "Check the reconcile job's per-tenant leases for one that was never released, then distinguish genuinely stuck attempts from those correctly waiting on a human decision."
        },
        {
          thresholdKey: "backlog_critical",
          severity: "critical",
          comparison: "above",
          value: 200,
          forSeconds: 900,
          operatorAction:
            "Treat as a stalled queue, not load: verify the reconcile worker is running at all and check database pool saturation before investigating the module itself."
        }
      ]
    },
    {
      key: "tenant_provisioning.provisioning_attempt_age",
      ownerModuleKey: "tenant_provisioning",
      title: "No provisioning attempt ages out",
      description:
        "The oldest non-terminal provisioning attempt stays younger than the objective. Queue DEPTH alone cannot tell a healthy queue that is briefly deep from a stalled one that is permanently shallow — age can, which is why this objective exists alongside the backlog one.",
      kind: "freshness",
      metricName: "control_plane_provisioning_oldest_pending_seconds",
      unit: "seconds",
      objectiveValue: 3600,
      objectiveComparison: "above",
      runbookPath:
        "docs/awcms-mini/control-plane-slo-runbook.md#tenant-provisioning-age",
      thresholds: [
        {
          thresholdKey: "oldest_attempt_stale",
          severity: "warning",
          comparison: "above",
          value: 3600,
          forSeconds: 600,
          operatorAction:
            "If age climbs while depth stays flat, one attempt is not advancing rather than the system being loaded — find the oldest attempt and identify which step never completed."
        },
        {
          thresholdKey: "oldest_attempt_abandoned",
          severity: "critical",
          comparison: "above",
          value: 21600,
          forSeconds: 600,
          operatorAction:
            "A six-hour-old attempt will not recover on its own; resume or compensate it explicitly through the operator API so the action is audited."
        }
      ]
    },
    {
      key: "tenant_provisioning.manual_intervention_bounded",
      ownerModuleKey: "tenant_provisioning",
      title: "Manual-intervention queue stays bounded",
      description:
        "Control-plane workflows parked awaiting a human decision stay bounded. Deliberately not a 'system broken' alert — it separates 'the system is stuck' from 'the system is correctly waiting for an operator who has not looked yet', which still needs an SLA because a tenant is waiting at the end of it.",
      kind: "backlog",
      metricName: "control_plane_manual_intervention_total",
      dimension: "subsystem",
      unit: "count",
      objectiveValue: 20,
      objectiveComparison: "above",
      runbookPath:
        "docs/awcms-mini/control-plane-slo-runbook.md#control-plane-manual-intervention",
      thresholds: [
        {
          thresholdKey: "intervention_queue_growing",
          severity: "warning",
          comparison: "above",
          value: 20,
          // Long dwell on purpose: this is a human-throughput signal, and
          // paging on a short spike would train operators to ignore it.
          forSeconds: 14400,
          operatorAction:
            "Escalate to the process owner rather than the technical on-call — a growing queue here means nobody is working the decision backlog, not that the system failed."
        }
      ]
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/tenant-provisioning"
  }
});
