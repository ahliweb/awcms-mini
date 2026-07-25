import {
  defineModule,
  type ProjectionCursorStream
} from "../_shared/module-contract";
import {
  LIFECYCLE_TRANSITIONS_METRIC_KEYS,
  LIFECYCLE_TRANSITIONS_PROJECTION_KEY
} from "./domain/projection-keys";

/**
 * ONE stream shared by this projection's `source` and `rebuildSource` — see
 * `tenant-provisioning/module.ts`'s matching constant for why the two are
 * never written as separate literals.
 *
 * `created_at` is the cursor (insert-time only; the table is append-only
 * under both a trigger and `REVOKE UPDATE, DELETE`, migration 089).
 * `effective_at` deliberately is NOT: a scheduled transition can be recorded
 * with an `effective_at` in the future or the past, so it is not monotonic in
 * insert order and would let a bounded cursor scan skip rows permanently.
 */
const LIFECYCLE_TRANSITIONS_STREAM: ProjectionCursorStream = {
  streamKey: "tenant_lifecycle_history",
  tableName: "awcms_mini_tenant_lifecycle_history",
  cursorColumn: "created_at",
  metrics: [
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.historyTotal,
      effect: "increment"
    },
    // By event kind — "what happened".
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.transitionCount,
      effect: "increment",
      matchColumn: "event_kind",
      matchValue: "transition"
    },
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.downgradeCount,
      effect: "increment",
      matchColumn: "event_kind",
      matchValue: "downgrade"
    },
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.scheduleSetCount,
      effect: "increment",
      matchColumn: "event_kind",
      matchValue: "schedule_set"
    },
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.scheduleCanceledCount,
      effect: "increment",
      matchColumn: "event_kind",
      matchValue: "schedule_canceled"
    },
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.restoreCount,
      effect: "increment",
      matchColumn: "event_kind",
      matchValue: "restore"
    },
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.reconciledCount,
      effect: "increment",
      matchColumn: "event_kind",
      matchValue: "reconciled"
    },
    // By destination state — "where it went". Counts ENTRIES into a state,
    // not time spent in it; the current state is authoritative elsewhere
    // (`awcms_mini_tenant_lifecycle_states`, this descriptor's drill-down).
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredActive,
      effect: "increment",
      matchColumn: "to_state",
      matchValue: "active"
    },
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredTrial,
      effect: "increment",
      matchColumn: "to_state",
      matchValue: "trial"
    },
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredRenewalDue,
      effect: "increment",
      matchColumn: "to_state",
      matchValue: "renewal_due"
    },
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredPastDue,
      effect: "increment",
      matchColumn: "to_state",
      matchValue: "past_due"
    },
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredGrace,
      effect: "increment",
      matchColumn: "to_state",
      matchValue: "grace"
    },
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredSuspended,
      effect: "increment",
      matchColumn: "to_state",
      matchValue: "suspended"
    },
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredCanceled,
      effect: "increment",
      matchColumn: "to_state",
      matchValue: "canceled"
    },
    {
      metricKey: LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredBlocked,
      effect: "increment",
      matchColumn: "to_state",
      matchValue: "blocked"
    }
  ]
};

/**
 * `tenant_lifecycle` — the FOURTH SaaS control-plane module (Issue #873, epic
 * #868 Wave 1, ADR-0022). Admitted as an Official Optional Business Foundation:
 * in-repo reviewed code, opt-in per tenant, and `defaultTenantState: "disabled"`
 * (ADR-0022 §7) so a LAN/offline deployment that never activates the control
 * plane keeps it fully inert (and un-governing — a tenant with no lifecycle
 * record is UNRESTRICTED). Lifecycle transitions are platform-operator only +
 * default-deny.
 *
 * It records the precise SaaS lifecycle STATE of a tenant (provisioning/trial/
 * active/renewal_due/past_due/grace/suspended/canceled/restoring/blocked),
 * validates forward-legal transitions with an optimistic-concurrency version
 * guard (invalid transition -> deterministic 409), keeps an append-only
 * transition history, schedules future transitions (trial/grace expiry) that a
 * worker applies IDEMPOTENTLY under concurrency, and DERIVES — never stores as
 * truth — the fail-closed access RESTRICTIONS a state implies. A downgrade/
 * suspend/cancel changes STATE + effective entitlement + access but NEVER
 * deletes tenant data (ADR-0022 §6/§9, AC).
 *
 * Every table is TENANT-SCOPED (`tenant_id` + `ENABLE` + `FORCE RLS`, predicate
 * ALWAYS AND ONLY `tenant_id` — no soft super-tenant, ADR-0022 §6). It PROVIDES
 * the read-only `tenant_restrictions` capability (the single fail-closed
 * restriction snapshot the API/SSR auth chokepoint enforces, and public host
 * routing + background workers enforce via the projected
 * `awcms_mini_tenants.status`) and the `lifecycle_transition` WRITE capability
 * (#876 requests transitions through THIS contract, never mutating tenant state
 * directly). It CONSUMES the fail-closed `effective_entitlement` (#871, for
 * downgrade) and read-only `provisioning_status` (#872, for restore
 * reconciliation) contracts — both at its composition root, never a direct
 * import (module-boundary).
 */
export const tenantLifecycleModule = defineModule({
  key: "tenant_lifecycle",
  name: "Tenant Lifecycle",
  version: "0.1.0",
  status: "active",
  type: "domain",
  // Default-disabled per tenant (ADR-0022 §7 / Medium-3) — gated by
  // `tests/unit/module-governance-default-disabled.test.ts`.
  defaultTenantState: "disabled",
  description:
    "Provider-neutral SaaS control-plane tenant lifecycle (Issue #873, epic #868 Wave 1, ADR-0022) — the FOURTH control-plane module. Admitted as an Official Optional Business Foundation (opt-in per tenant, default-disabled) and tenant-scoped (every table tenant_id + ENABLE + FORCE RLS, predicate ALWAYS AND ONLY tenant_id, ADR-0022 §6 no soft super-tenant). Records the precise SaaS lifecycle state of a tenant (provisioning/trial/active/renewal_due/past_due/grace/suspended/canceled/restoring/blocked), validates forward-legal transitions with an optimistic-concurrency version guard (invalid transition -> deterministic 409), keeps an append-only transition history, schedules trial/grace expiry transitions applied idempotently under concurrent workers, and derives — never stores as truth — the server-derived, fail-closed access restrictions a state implies. Suspension/cancel/block restrict admin/public/writes/jobs/provider access consistently across API, SSR, public host routing, and background workers; past_due is read-only; owner recovery/data export stay separately authorized so preserved data is always recoverable. Downgrade changes the effective entitlement (via the #871 contract) and NEVER deletes tenant data; restore/reactivate runs reconciliation against provisioning readiness (#872) and does not silently overlook failed provisioning/payment. Emits versioned lifecycle events same-commit and updates reporting projections. PROVIDES the read-only tenant_restrictions capability and the lifecycle_transition write capability (#876 consumes it); CONSUMES the fail-closed effective_entitlement (#871) and provisioning_status (#872) contracts. LAN/offline safe: lifecycle runs with no online payment provider.",
  // ADR-0022 §2 lifecycle dependencies (active first). `logging` for
  // `recordAuditEvent`; `domain_event_runtime` for `appendDomainEvent`.
  // `tenant_entitlement`/`tenant_provisioning` are consumed via CAPABILITY/
  // composition-root wiring (optional, LAN-safe), NOT hard lifecycle
  // dependencies. Acyclic; no base/core -> control-plane edge.
  dependencies: [
    "tenant_admin",
    "identity_access",
    "module_management",
    "domain_event_runtime",
    "logging"
  ],
  capabilities: {
    // The read-only restriction snapshot the auth chokepoint / a downstream
    // surface reads without importing this module, PLUS the write contract
    // #876 uses to request a validated transition.
    provides: ["tenant_restrictions", "lifecycle_transition"],
    consumes: [
      {
        capability: "effective_entitlement",
        providedBy: "tenant_entitlement",
        optional: true
      },
      {
        capability: "provisioning_status",
        providedBy: "tenant_provisioning",
        optional: true
      }
    ]
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.tenant-lifecycle.transitioned",
      "awcms-mini.tenant-lifecycle.downgraded",
      "awcms-mini.tenant-lifecycle.restored",
      "awcms-mini.tenant-lifecycle.scheduled"
    ]
  },
  jobs: [
    {
      command: "bun run tenant-lifecycle:run-scheduled",
      purpose:
        "Apply ONE tenant's DUE scheduled lifecycle transition (trial/grace expiry) idempotently under concurrent workers (row-lock + state+version-predicated update; no provider call).",
      recommendedSchedule: "*/15 * * * *",
      safeInOfflineLan: true,
      environmentNotes:
        "Per-tenant: pass a tenant id (`bun run tenant-lifecycle:run-scheduled <tenantId>` or LIFECYCLE_TENANT_ID). DB-only and safe offline/LAN. A FLEET-WIDE batch that scans every tenant's due schedules is intentionally DEFERRED to #880 (it needs a purpose-built cross-tenant read-model — a platform operator is not a soft super-tenant, ADR-0022 §6b); until then run per-tenant."
    }
  ],
  navigation: [
    {
      labelKey: "admin.layout.nav_tenant_lifecycle",
      path: "/admin/tenant-lifecycle",
      order: 133,
      requiredPermission: "tenant_lifecycle.states.read"
    }
  ],
  permissions: [
    {
      activityCode: "states",
      action: "read",
      description:
        "Read tenant lifecycle state, restrictions, scheduled transition, and timeline"
    },
    {
      activityCode: "states",
      action: "update",
      description:
        "Perform a validated tenant lifecycle transition (activate, suspend, past_due, grace, cancel, block; concurrency-safe)"
    },
    {
      activityCode: "states",
      action: "schedule",
      description:
        "Schedule or cancel a future tenant lifecycle transition (trial/grace expiry) applied idempotently by the scheduler"
    },
    {
      activityCode: "states",
      action: "restore",
      description:
        "Restore/reactivate a suspended or canceled tenant with reconciliation (separately authorized; not self-service)"
    },
    {
      activityCode: "entitlement",
      action: "configure",
      description:
        "Downgrade the tenant effective entitlement via the entitlement contract (never deletes tenant data)"
    },
    {
      activityCode: "recovery",
      action: "export",
      description:
        "Authorize owner recovery / tenant data export while restricted (separately authorized)"
    }
  ],
  // Segregation-of-duties (Issue #879, epic #868 Wave 2, ADR-0022 §5 —
  // "requester versus lifecycle restore/exception approval"). SoD was DEFERRED
  // from #873 to #879; declared here, wired into the `authorizeInTransaction`
  // chokepoint via `high-risk-sod-guard.ts`. Enforced at the high-risk
  // `states.restore` step: the subject who SCHEDULES a tenant lifecycle
  // transition (the requester) must not also be the one who RESTORES/reactivates
  // the tenant (the approver) — maker/checker over reactivation.
  sodRules: [
    {
      ruleKey: "tenant_lifecycle.restore_requester_vs_approver",
      ownerModuleKey: "tenant_lifecycle",
      description:
        "A subject who SCHEDULES a tenant lifecycle transition must not also RESTORE/reactivate the tenant — requester vs restore-approver maker/checker (ADR-0022 §5).",
      conflictingPermissionKeys: [
        "tenant_lifecycle.states.schedule",
        "tenant_lifecycle.states.restore"
      ],
      scopeApplicability: "global_within_tenant",
      severity: "high",
      exceptionPolicy: {
        allowed: true,
        requiresApprovalPermission:
          "identity_access.business_scope_exceptions.approve",
        maxDurationDays: 14
      }
    }
  ],
  // Issue #880 — see `tenant-provisioning/module.ts`'s matching block for the
  // ownership/direction rule (declared here, materialized by `reporting`'s
  // generic engine, no cross-module table write in either direction).
  reportingProjections: [
    {
      key: LIFECYCLE_TRANSITIONS_PROJECTION_KEY,
      version: 1,
      ownerModuleKey: "tenant_lifecycle",
      scope: "tenant",
      description:
        "Lifecycle event counts for this tenant by event kind (transition/downgrade/schedule set/schedule canceled/restore/reconciled) and by destination state, incrementally derived from the append-only awcms_mini_tenant_lifecycle_history timeline. Surfaces the churn a current-state view cannot: repeated entries into past_due/grace/suspended, scheduled transitions set versus canceled, and how often reconciliation had to correct the state. The authoritative CURRENT state and its scheduled transitions stay in awcms_mini_tenant_lifecycle_states (drill down); this projection never gates access — the fail-closed restriction profile is derived server-side at the auth chokepoint, never from a read model.",
      source: {
        strategy: "cursor_table",
        streams: [LIFECYCLE_TRANSITIONS_STREAM]
      },
      rebuildSource: { streams: [LIFECYCLE_TRANSITIONS_STREAM] },
      metricLabels: {
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.historyTotal]: "Lifecycle events",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.transitionCount]:
          "State transitions",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.downgradeCount]: "Downgrades",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.scheduleSetCount]:
          "Transitions scheduled",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.scheduleCanceledCount]:
          "Scheduled transitions canceled",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.restoreCount]: "Restores",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.reconciledCount]:
          "Reconciliation corrections",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredActive]: "Entered active",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredTrial]: "Entered trial",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredRenewalDue]:
          "Entered renewal due",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredPastDue]: "Entered past due",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredGrace]: "Entered grace",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredSuspended]:
          "Entered suspended",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredCanceled]: "Entered canceled",
        [LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredBlocked]: "Entered blocked"
      },
      requiredPermission: "tenant_lifecycle.states.read",
      freshness: {
        targetSeconds: 300,
        staleAfterSeconds: 900,
        errorAfterConsecutiveFailures: 3
      },
      drillDownPath: "/api/v1/tenant-lifecycle/tenants/{tenantId}",
      retentionClass:
        "Not separately registered in data_lifecycle: one row per lifecycle event, and a tenant's lifecycle changes at human/scheduler cadence (state changes, schedules, restores) rather than at request or telemetry cadence. It is also the audit trail of every restriction a tenant was ever placed under, so age-based purge is deliberately not proposed.",
      batchLimit: 1000
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/tenant-lifecycle"
  }
});
