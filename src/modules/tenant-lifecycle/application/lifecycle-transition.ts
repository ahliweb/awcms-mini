/**
 * `tenant_lifecycle` transition engine (Issue #873, epic #868, ADR-0022 §11.2).
 * Every command runs inside the CALLER's already tenant-scoped transaction
 * (`tx`) so the state change, the append-only history row, the versioned domain
 * event (same-commit — memory `deferring-work-must-split-by-dependency`), the
 * audit record, and any composition-root projection (tenant status, entitlement
 * downgrade) all COMMIT ATOMICALLY (AC "atomic or reconciled through durable
 * events"). Cross-module effects are INJECTED deps assembled at the composition
 * root; only `logging` + `domain_event_runtime` are imported directly
 * (foundational infra, same as `tenant_provisioning`/`tenant_entitlement`).
 *
 * Concurrency (epic pattern #3): each command row-locks the state row, checks
 * the legal transition + optimistic version in the app (mirroring the DB
 * trigger), then issues a state+version-predicated UPDATE — a lost race / stale
 * version is a deterministic `version_conflict` (409). A downgrade/suspend/
 * cancel NEVER deletes data; it changes STATE (+ entitlement) only.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  TENANT_LIFECYCLE_DOWNGRADED_EVENT_TYPE,
  TENANT_LIFECYCLE_EVENT_VERSION,
  TENANT_LIFECYCLE_RESTORED_EVENT_TYPE,
  TENANT_LIFECYCLE_SCHEDULED_EVENT_TYPE,
  TENANT_LIFECYCLE_TRANSITIONED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  isLegalTransition,
  isRestorableState,
  isSchedulableFrom,
  type LifecycleSource,
  type LifecycleState
} from "../domain/lifecycle-state";
import { deriveRestrictions } from "../domain/restriction-policy";
import {
  appendHistory,
  applyTransition,
  clearSchedule,
  ensureLifecycleRecord,
  loadStateForUpdate,
  setSchedule,
  toLifecycleDto,
  type LifecycleStateDto,
  type LifecycleStateRow
} from "./lifecycle-directory";

const MODULE_KEY = "tenant_lifecycle";
const AGGREGATE_TYPE = "tenant_lifecycle_state";

export type LifecycleActionContext = {
  actorTenantUserId: string | null;
  correlationId?: string;
};

/**
 * Cross-module effects injected at the composition root (a route/page under
 * `src/pages/api/**`). `projectTenantStatus` is MANDATORY (every state-changing
 * caller MUST wire it — see below); the entitlement/provisioning deps are
 * optional so the engine + a LAN/offline deployment that wires none stays fully
 * functional (payment/provider-independent, AC).
 */
export type LifecycleEngineDeps = {
  /**
   * Project the derived public/worker availability onto the Core tenant status
   * (`tenant_admin.setTenantStatus`) IN THE SAME TX, so public host routing and
   * background workers — which gate on `awcms_mini_tenants.status = 'active'` —
   * enforce the same suspension the API/SSR gate enforces (the four-surface
   * parity, AC). `active` iff the derived profile keeps the public site up.
   *
   * MANDATORY (non-optional) so TypeScript forces EVERY composition root (the
   * operator routes, the scheduler CLI/worker, and the future #876 billing port)
   * to inject it — omitting it would let a transition change lifecycle state
   * WITHOUT propagating the suspension to public routing + workers, silently
   * breaking four-surface parity. A defensive runtime guard additionally
   * fails LOUD (never silent) if a JS caller bypasses the type and a
   * state-changing command reaches the engine without a projector.
   */
  projectTenantStatus: (
    tx: Bun.SQL,
    tenantId: string,
    active: boolean,
    actor: string | null
  ) => Promise<void>;
  /** Downgrade the effective entitlement via the #871 contract (never deletes data). */
  downgradeEntitlement?: (
    tx: Bun.SQL,
    tenantId: string,
    actor: string | null,
    offer: { offerPlanKey: string; offerVersion: number }
  ) => Promise<
    | { ok: true; before: string | null; assignmentId: string }
    | { ok: false; reason: "offer_not_found" | "conflict" | "validation" }
  >;
  /** Read provisioning readiness (#872 `provisioning_status` port) for restore reconciliation. */
  provisioningReady?: (
    tx: Bun.SQL,
    tenantId: string
  ) => Promise<{
    ready: boolean;
    status: string;
    blockedReason: string | null;
  }>;
};

export type InitializeCommand = {
  initialState: LifecycleState;
  reason: string;
  source: LifecycleSource;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
};

export type TransitionCommand = {
  toState: LifecycleState;
  reason: string;
  source: LifecycleSource;
  expectedVersion: number | null;
  effectiveAt?: string | null;
};

export type LifecycleResult =
  | { ok: true; state: LifecycleStateDto }
  | {
      ok: false;
      reason:
        | "not_found"
        | "illegal_transition"
        | "version_conflict"
        | "validation"
        | "unresolved_reconciliation"
        | "entitlement_unavailable"
        | "entitlement_conflict";
      message: string;
      current?: LifecycleStateDto;
    };

function activeFromState(state: LifecycleState): boolean {
  return deriveRestrictions(state).publicSiteAllowed;
}

/**
 * Fail-LOUD guard: a command that CHANGES lifecycle state MUST have a status
 * projector wired (four-surface parity). `projectTenantStatus` is mandatory in
 * the type, but a JS caller (or a mis-assembled composition root) could bypass
 * the type — a silent skip would leave public routing + workers serving a
 * suspended tenant. Returns the projector so callers invoke it unconditionally.
 */
function requireProjector(
  deps: LifecycleEngineDeps
): LifecycleEngineDeps["projectTenantStatus"] {
  const project = deps.projectTenantStatus as
    LifecycleEngineDeps["projectTenantStatus"] | undefined;
  if (typeof project !== "function") {
    throw new Error(
      "tenant_lifecycle: a state-changing transition requires the `projectTenantStatus` dependency " +
        "(four-surface parity — public routing + background workers gate on the projected " +
        "`awcms_mini_tenants.status`). The composition root MUST inject it."
    );
  }
  return project;
}

/** Common guard shared by every state-changing command (row already locked). */
function guardTransition(
  row: LifecycleStateRow,
  toState: LifecycleState,
  expectedVersion: number | null
): LifecycleResult | null {
  if (expectedVersion !== null && expectedVersion !== Number(row.version)) {
    return {
      ok: false,
      reason: "version_conflict",
      message: `Lifecycle version is ${row.version}, expected ${expectedVersion}.`,
      current: toLifecycleDto(row)
    };
  }
  if (toState === row.state) {
    return {
      ok: false,
      reason: "illegal_transition",
      message: `Tenant is already in state "${row.state}".`,
      current: toLifecycleDto(row)
    };
  }
  if (!isLegalTransition(row.state, toState)) {
    return {
      ok: false,
      reason: "illegal_transition",
      message: `Illegal lifecycle transition "${row.state}" -> "${toState}".`,
      current: toLifecycleDto(row)
    };
  }
  return null;
}

/**
 * Persist a single validated transition + history + event + audit + status
 * projection, all in `tx`. The caller has already row-locked + guarded.
 */
async function commitTransition(
  tx: Bun.SQL,
  tenantId: string,
  row: LifecycleStateRow,
  command: {
    toState: LifecycleState;
    reason: string;
    source: LifecycleSource;
    effectiveAt: string | null;
    eventKind: "transition" | "restore";
    metadata: Record<string, unknown>;
  },
  deps: LifecycleEngineDeps,
  ctx: LifecycleActionContext
): Promise<LifecycleStateRow | null> {
  // Fail LOUD before mutating: a state change without a projector would break
  // four-surface parity (public routing + workers serve a suspended tenant).
  const projectTenantStatus = requireProjector(deps);
  const updated = await applyTransition(tx, {
    tenantId,
    fromState: row.state,
    fromVersion: Number(row.version),
    toState: command.toState,
    reason: command.reason,
    source: command.source,
    actor: ctx.actorTenantUserId,
    effectiveAt: command.effectiveAt
  });
  if (!updated) return null;

  await appendHistory(tx, {
    tenantId,
    eventKind: command.eventKind,
    fromState: row.state,
    toState: command.toState,
    version: Number(updated.version),
    reason: command.reason,
    source: command.source,
    actor: ctx.actorTenantUserId,
    correlationId: ctx.correlationId ?? null,
    scheduledAt: null,
    metadata: command.metadata,
    effectiveAt: command.effectiveAt
  });

  await appendDomainEvent(tx, tenantId, {
    // A resolvable ternary of exported constants (never a variable operand) so
    // the publish-root derivation is never blind to this publisher (memory
    // `derive-publish-roots-from-registry`).
    eventType:
      command.eventKind === "restore"
        ? TENANT_LIFECYCLE_RESTORED_EVENT_TYPE
        : TENANT_LIFECYCLE_TRANSITIONED_EVENT_TYPE,
    eventVersion: TENANT_LIFECYCLE_EVENT_VERSION,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: tenantId,
    aggregateVersion: Number(updated.version),
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      tenantId,
      fromState: row.state,
      toState: command.toState,
      version: Number(updated.version),
      source: command.source,
      ...command.metadata
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: command.eventKind === "restore" ? "restore" : "update",
    resourceType: "tenant_lifecycle_state",
    resourceId: tenantId,
    severity: "warning",
    message: `Tenant lifecycle ${row.state} -> ${command.toState}: ${command.reason}`,
    attributes: {
      fromState: row.state,
      toState: command.toState,
      version: Number(updated.version),
      source: command.source
    },
    correlationId: ctx.correlationId
  });

  // Project public/worker availability onto the Core tenant status (same tx).
  await projectTenantStatus(
    tx,
    tenantId,
    activeFromState(command.toState),
    ctx.actorTenantUserId
  );

  return updated;
}

/**
 * Initialize a tenant's lifecycle record (idempotent). Creates the single state
 * row at `initialState` (`ON CONFLICT DO NOTHING`), records the genesis history
 * row + `.transitioned` event + audit, and projects the initial tenant status.
 * A second initialize returns the EXISTING record unchanged (idempotent).
 */
export async function initializeLifecycle(
  tx: Bun.SQL,
  tenantId: string,
  command: InitializeCommand,
  deps: LifecycleEngineDeps,
  ctx: LifecycleActionContext
): Promise<{ ok: true; created: boolean; state: LifecycleStateDto }> {
  const { row, created } = await ensureLifecycleRecord(tx, tenantId, {
    initialState: command.initialState,
    reason: command.reason,
    source: command.source,
    actor: ctx.actorTenantUserId,
    trialEndsAt: command.trialEndsAt,
    graceEndsAt: command.graceEndsAt
  });

  if (!created) {
    return { ok: true, created: false, state: toLifecycleDto(row) };
  }

  // Genesis creates the state row (a state change) -> the projector is required
  // to seed the initial public/worker availability (four-surface parity).
  const projectTenantStatus = requireProjector(deps);

  await appendHistory(tx, {
    tenantId,
    eventKind: "transition",
    fromState: null,
    toState: command.initialState,
    version: Number(row.version),
    reason: command.reason,
    source: command.source,
    actor: ctx.actorTenantUserId,
    correlationId: ctx.correlationId ?? null,
    scheduledAt: null,
    metadata: { genesis: true },
    effectiveAt: null
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: TENANT_LIFECYCLE_TRANSITIONED_EVENT_TYPE,
    eventVersion: TENANT_LIFECYCLE_EVENT_VERSION,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: tenantId,
    aggregateVersion: Number(row.version),
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      tenantId,
      fromState: null,
      toState: command.initialState,
      version: Number(row.version),
      source: command.source,
      genesis: true
    }
  });
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "tenant_lifecycle_state",
    resourceId: tenantId,
    severity: "warning",
    message: `Tenant lifecycle initialized at "${command.initialState}": ${command.reason}`,
    attributes: { initialState: command.initialState, source: command.source },
    correlationId: ctx.correlationId
  });
  await projectTenantStatus(
    tx,
    tenantId,
    activeFromState(command.initialState),
    ctx.actorTenantUserId
  );
  return { ok: true, created: true, state: toLifecycleDto(row) };
}

/**
 * Perform a validated lifecycle transition (activate, suspend, past_due, grace,
 * cancel, block, ...). The single WRITE entry the `lifecycle_transition` port
 * (#876) and the operator route both call.
 */
export async function transition(
  tx: Bun.SQL,
  tenantId: string,
  command: TransitionCommand,
  deps: LifecycleEngineDeps,
  ctx: LifecycleActionContext
): Promise<LifecycleResult> {
  const row = await loadStateForUpdate(tx, tenantId);
  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      message: "Tenant has no lifecycle record."
    };
  }

  const guard = guardTransition(row, command.toState, command.expectedVersion);
  if (guard) return guard;

  const updated = await commitTransition(
    tx,
    tenantId,
    row,
    {
      toState: command.toState,
      reason: command.reason,
      source: command.source,
      effectiveAt: command.effectiveAt ?? null,
      eventKind: "transition",
      metadata: {}
    },
    deps,
    ctx
  );
  if (!updated) {
    return {
      ok: false,
      reason: "version_conflict",
      message: "Lifecycle state changed concurrently.",
      current: toLifecycleDto(row)
    };
  }
  return { ok: true, state: toLifecycleDto(updated) };
}

/** Schedule a future transition (trial/grace expiry). No state change; no version bump. */
export async function scheduleTransition(
  tx: Bun.SQL,
  tenantId: string,
  command: {
    toState: LifecycleState;
    at: string;
    reason: string;
    source: LifecycleSource;
    expectedVersion: number | null;
  },
  deps: LifecycleEngineDeps,
  ctx: LifecycleActionContext
): Promise<LifecycleResult> {
  const row = await loadStateForUpdate(tx, tenantId);
  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      message: "Tenant has no lifecycle record."
    };
  }
  if (
    command.expectedVersion !== null &&
    command.expectedVersion !== Number(row.version)
  ) {
    return {
      ok: false,
      reason: "version_conflict",
      message: `Lifecycle version is ${row.version}, expected ${command.expectedVersion}.`,
      current: toLifecycleDto(row)
    };
  }
  if (
    !isSchedulableFrom(row.state) ||
    !isLegalTransition(row.state, command.toState) ||
    command.toState === row.state
  ) {
    return {
      ok: false,
      reason: "illegal_transition",
      message: `Cannot schedule "${row.state}" -> "${command.toState}".`,
      current: toLifecycleDto(row)
    };
  }

  const updated = await setSchedule(tx, {
    tenantId,
    currentState: row.state,
    version: Number(row.version),
    toState: command.toState,
    at: command.at,
    reason: command.reason,
    source: command.source,
    actor: ctx.actorTenantUserId
  });
  if (!updated) {
    return {
      ok: false,
      reason: "version_conflict",
      message: "Lifecycle state changed concurrently.",
      current: toLifecycleDto(row)
    };
  }

  await appendHistory(tx, {
    tenantId,
    eventKind: "schedule_set",
    fromState: row.state,
    toState: command.toState,
    version: Number(updated.version),
    reason: command.reason,
    source: command.source,
    actor: ctx.actorTenantUserId,
    correlationId: ctx.correlationId ?? null,
    scheduledAt: command.at,
    metadata: {},
    effectiveAt: null
  });
  await emitScheduled(tx, tenantId, updated, command.toState, command.at, ctx);
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "schedule",
    resourceType: "tenant_lifecycle_state",
    resourceId: tenantId,
    severity: "info",
    message: `Scheduled lifecycle ${row.state} -> ${command.toState} at ${command.at}: ${command.reason}`,
    attributes: { toState: command.toState, scheduledAt: command.at },
    correlationId: ctx.correlationId
  });
  return { ok: true, state: toLifecycleDto(updated) };
}

/** Cancel the pending scheduled transition. */
export async function cancelSchedule(
  tx: Bun.SQL,
  tenantId: string,
  command: { reason: string; expectedVersion: number | null },
  ctx: LifecycleActionContext
): Promise<LifecycleResult> {
  const row = await loadStateForUpdate(tx, tenantId);
  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      message: "Tenant has no lifecycle record."
    };
  }
  if (
    command.expectedVersion !== null &&
    command.expectedVersion !== Number(row.version)
  ) {
    return {
      ok: false,
      reason: "version_conflict",
      message: `Lifecycle version is ${row.version}, expected ${command.expectedVersion}.`,
      current: toLifecycleDto(row)
    };
  }
  if (!row.scheduled_to_state) {
    return {
      ok: false,
      reason: "illegal_transition",
      message: "No scheduled transition to cancel.",
      current: toLifecycleDto(row)
    };
  }
  const priorTarget = row.scheduled_to_state;
  const updated = await clearSchedule(tx, {
    tenantId,
    currentState: row.state,
    version: Number(row.version),
    actor: ctx.actorTenantUserId
  });
  if (!updated) {
    return {
      ok: false,
      reason: "version_conflict",
      message: "Lifecycle state changed concurrently.",
      current: toLifecycleDto(row)
    };
  }
  await appendHistory(tx, {
    tenantId,
    eventKind: "schedule_canceled",
    fromState: row.state,
    toState: priorTarget,
    version: Number(updated.version),
    reason: command.reason,
    source: "operator",
    actor: ctx.actorTenantUserId,
    correlationId: ctx.correlationId ?? null,
    scheduledAt: null,
    metadata: {},
    effectiveAt: null
  });
  await emitScheduled(tx, tenantId, updated, priorTarget, null, ctx);
  return { ok: true, state: toLifecycleDto(updated) };
}

async function emitScheduled(
  tx: Bun.SQL,
  tenantId: string,
  row: LifecycleStateRow,
  toState: LifecycleState,
  scheduledAt: string | null,
  ctx: LifecycleActionContext
): Promise<void> {
  await appendDomainEvent(tx, tenantId, {
    eventType: TENANT_LIFECYCLE_SCHEDULED_EVENT_TYPE,
    eventVersion: TENANT_LIFECYCLE_EVENT_VERSION,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: tenantId,
    aggregateVersion: Number(row.version),
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      tenantId,
      toState,
      scheduledAt,
      version: Number(row.version)
    }
  });
}

/**
 * Apply a DUE scheduled transition idempotently (the scheduler worker). Under
 * concurrent workers the FOR UPDATE row lock serializes access and the
 * state+version-predicated UPDATE guarantees the transition happens AT MOST
 * ONCE (AC "scheduled transitions idempotent under multiple workers"): the
 * second worker finds the schedule already cleared -> a clean no-op. A schedule
 * whose target is no longer legal from the CURRENT state (state changed since
 * scheduling) is cleared as superseded, never forced.
 */
export type ScheduledApplyResult =
  | { ok: true; applied: boolean; state: LifecycleStateDto; note: string }
  | { ok: false; reason: "not_found"; message: string };

export async function applyDueSchedule(
  tx: Bun.SQL,
  tenantId: string,
  now: Date,
  deps: LifecycleEngineDeps,
  ctx: LifecycleActionContext
): Promise<ScheduledApplyResult> {
  const row = await loadStateForUpdate(tx, tenantId);
  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      message: "Tenant has no lifecycle record."
    };
  }

  // No due schedule -> idempotent no-op (a prior worker already applied it).
  if (
    !row.scheduled_to_state ||
    !row.scheduled_at ||
    new Date(row.scheduled_at).getTime() > now.getTime()
  ) {
    return {
      ok: true,
      applied: false,
      state: toLifecycleDto(row),
      note: "no due scheduled transition"
    };
  }

  const target = row.scheduled_to_state;
  const source = row.scheduled_source ?? "scheduler";

  // The scheduled target must still be legal from the CURRENT state; otherwise
  // it was superseded by a manual transition — clear it, do not force.
  if (target === row.state || !isLegalTransition(row.state, target)) {
    const cleared = await clearSchedule(tx, {
      tenantId,
      currentState: row.state,
      version: Number(row.version),
      actor: ctx.actorTenantUserId
    });
    return {
      ok: true,
      applied: false,
      state: toLifecycleDto(cleared ?? row),
      note: "scheduled transition superseded (illegal from current state); cleared"
    };
  }

  const updated = await commitTransition(
    tx,
    tenantId,
    row,
    {
      toState: target,
      reason: row.scheduled_reason ?? "scheduled transition",
      source,
      effectiveAt: row.scheduled_at,
      eventKind: "transition",
      metadata: { scheduled: true }
    },
    deps,
    { ...ctx }
  );
  if (!updated) {
    // Lost the race to a concurrent worker/operator -> idempotent no-op.
    return {
      ok: true,
      applied: false,
      state: toLifecycleDto(row),
      note: "scheduled transition applied concurrently"
    };
  }
  return {
    ok: true,
    applied: true,
    state: toLifecycleDto(updated),
    note: `applied scheduled ${row.state} -> ${target}`
  };
}

/**
 * Downgrade the effective entitlement WITHOUT changing the lifecycle state and
 * WITHOUT deleting any tenant data (AC). Delegates the entitlement change to the
 * injected #871 contract; records an explainable history row + `.downgraded`
 * event same-commit.
 */
export async function downgrade(
  tx: Bun.SQL,
  tenantId: string,
  command: {
    offerPlanKey: string;
    offerVersion: number;
    reason: string;
    expectedVersion: number | null;
  },
  deps: LifecycleEngineDeps,
  ctx: LifecycleActionContext
): Promise<LifecycleResult> {
  const row = await loadStateForUpdate(tx, tenantId);
  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      message: "Tenant has no lifecycle record."
    };
  }
  if (
    command.expectedVersion !== null &&
    command.expectedVersion !== Number(row.version)
  ) {
    return {
      ok: false,
      reason: "version_conflict",
      message: `Lifecycle version is ${row.version}, expected ${command.expectedVersion}.`,
      current: toLifecycleDto(row)
    };
  }
  if (!deps.downgradeEntitlement) {
    return {
      ok: false,
      reason: "entitlement_unavailable",
      message: "Entitlement downgrade is not available on this deployment.",
      current: toLifecycleDto(row)
    };
  }

  const result = await deps.downgradeEntitlement(
    tx,
    tenantId,
    ctx.actorTenantUserId,
    {
      offerPlanKey: command.offerPlanKey,
      offerVersion: command.offerVersion
    }
  );
  if (!result.ok) {
    return {
      ok: false,
      reason:
        result.reason === "offer_not_found"
          ? "validation"
          : "entitlement_conflict",
      message: `Entitlement downgrade failed: ${result.reason}.`,
      current: toLifecycleDto(row)
    };
  }

  const metadata = {
    beforeOffer: result.before,
    afterOfferPlanKey: command.offerPlanKey,
    afterOfferVersion: command.offerVersion
  };
  await appendHistory(tx, {
    tenantId,
    eventKind: "downgrade",
    fromState: row.state,
    toState: row.state,
    version: Number(row.version),
    reason: command.reason,
    source: "operator",
    actor: ctx.actorTenantUserId,
    correlationId: ctx.correlationId ?? null,
    scheduledAt: null,
    metadata,
    effectiveAt: null
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: TENANT_LIFECYCLE_DOWNGRADED_EVENT_TYPE,
    eventVersion: TENANT_LIFECYCLE_EVENT_VERSION,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: tenantId,
    aggregateVersion: Number(row.version),
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      tenantId,
      state: row.state,
      version: Number(row.version),
      beforeOffer: result.before,
      afterOfferPlanKey: command.offerPlanKey,
      afterOfferVersion: command.offerVersion
    }
  });
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "configure",
    resourceType: "tenant_lifecycle_state",
    resourceId: tenantId,
    severity: "warning",
    message: `Entitlement downgraded to ${command.offerPlanKey} v${command.offerVersion}: ${command.reason} (data preserved).`,
    attributes: metadata,
    correlationId: ctx.correlationId
  });
  return { ok: true, state: toLifecycleDto(row) };
}

/**
 * Restore/reactivate a suspended/canceled/blocked tenant WITH reconciliation
 * (AC). Reads provisioning readiness first: an unresolved provisioning/payment
 * state must be EXPLICITLY confirmed (`confirmUnresolved`) or the restore is
 * refused — never silently overlooked. On success moves current -> restoring ->
 * active (two transitions), never deleting data.
 */
export async function restore(
  tx: Bun.SQL,
  tenantId: string,
  command: {
    reason: string;
    confirmUnresolved: boolean;
    expectedVersion: number | null;
  },
  deps: LifecycleEngineDeps,
  ctx: LifecycleActionContext
): Promise<LifecycleResult> {
  const row = await loadStateForUpdate(tx, tenantId);
  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      message: "Tenant has no lifecycle record."
    };
  }
  if (
    command.expectedVersion !== null &&
    command.expectedVersion !== Number(row.version)
  ) {
    return {
      ok: false,
      reason: "version_conflict",
      message: `Lifecycle version is ${row.version}, expected ${command.expectedVersion}.`,
      current: toLifecycleDto(row)
    };
  }
  if (!isRestorableState(row.state)) {
    return {
      ok: false,
      reason: "illegal_transition",
      message: `Tenant in state "${row.state}" is not restorable.`,
      current: toLifecycleDto(row)
    };
  }

  // Reconciliation: never silently overlook a failed provisioning/provider state.
  let reconciled = true;
  let provisioningStatus = "unknown";
  if (deps.provisioningReady) {
    const ready = await deps.provisioningReady(tx, tenantId);
    reconciled = ready.ready;
    provisioningStatus = ready.status;
    if (!ready.ready && !command.confirmUnresolved) {
      return {
        ok: false,
        reason: "unresolved_reconciliation",
        message: `Provisioning is "${ready.status}" (not ready); restore requires confirmUnresolved=true.`,
        current: toLifecycleDto(row)
      };
    }
  }

  const restoringMeta = {
    reconciled,
    provisioningStatus,
    confirmedUnresolved: command.confirmUnresolved
  };
  // Step 1: current -> restoring.
  const restoring = await commitTransition(
    tx,
    tenantId,
    row,
    {
      toState: "restoring",
      reason: command.reason,
      source: "restore",
      effectiveAt: null,
      eventKind: "restore",
      metadata: restoringMeta
    },
    deps,
    ctx
  );
  if (!restoring) {
    return {
      ok: false,
      reason: "version_conflict",
      message: "Lifecycle state changed concurrently.",
      current: toLifecycleDto(row)
    };
  }

  // Step 2: restoring -> active.
  const active = await commitTransition(
    tx,
    tenantId,
    restoring,
    {
      toState: "active",
      reason: command.reason,
      source: "restore",
      effectiveAt: null,
      eventKind: "restore",
      metadata: restoringMeta
    },
    deps,
    ctx
  );
  if (!active) {
    // Left in `restoring` (a valid, visible intermediate) — operator can retry.
    return { ok: true, state: toLifecycleDto(restoring) };
  }
  return { ok: true, state: toLifecycleDto(active) };
}
