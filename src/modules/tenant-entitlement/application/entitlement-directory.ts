/**
 * `tenant_entitlement` record persistence + mutations (Issue #871, epic #868,
 * ADR-0022). Assign a tenant to a published offer, suspend/resume/cancel an
 * assignment, create/revoke operator overrides, and list records. Every
 * mutation:
 *   - runs a UNIFORM concurrency pattern (row-lock or `ON CONFLICT` +
 *     status-predicated UPDATE) so a concurrent race is a clean 409, never a
 *     lost update or a raw unique violation (service_catalog template);
 *   - resolves the NEW effective entitlement, writes an append-only evaluation
 *     SNAPSHOT, and emits a versioned domain event carrying the snapshot hash
 *     (deterministic cache invalidation) — all in the SAME transaction
 *     (same-commit);
 *   - is audited (reason-bound where the ADR requires it, ADR-0022 §8).
 *
 * "not found / invalid-state" is a discriminated result, never a thrown error
 * (same convention `service-catalog/application/plan-directory.ts` uses). All
 * functions run inside the caller's `withTenant`-scoped `tx` (RLS = the acting
 * tenant), and NEVER delete tenant data — entitlement loss is a status change
 * (ADR-0022 §6/§9).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  TENANT_ENTITLEMENT_ASSIGNMENT_CHANGED_EVENT_TYPE,
  TENANT_ENTITLEMENT_EVENT_VERSION,
  TENANT_ENTITLEMENT_OVERRIDE_CHANGED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import type { EntitlementKeyRegistry } from "../domain/entitlement-key-registry";
import {
  isLegalTransition,
  validateAssignInput,
  validateOverrideInput,
  type AssignInput,
  type AssignmentStatus,
  type AssignmentTransitionStatus,
  type EntitlementValidationError,
  type OverrideEffect,
  type OverrideInput,
  type OverrideSource,
  type OverrideTargetKind
} from "../domain/entitlement";
import type { EffectiveEntitlement } from "../domain/resolution";
import {
  resolveTenantEntitlement,
  type EntitlementResolutionDeps
} from "./entitlement-resolution";

const MODULE_KEY = "tenant_entitlement";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type EntitlementAssignmentDto = {
  id: string;
  planKey: string;
  offerVersion: number;
  offerHash: string;
  currency: string;
  source: string;
  reason: string | null;
  status: AssignmentStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  isCurrent: boolean;
  supersededAt: string | null;
  suspendedAt: string | null;
  suspendReason: string | null;
  resumedAt: string | null;
  canceledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EntitlementOverrideDto = {
  id: string;
  targetKind: OverrideTargetKind;
  targetKey: string;
  effect: OverrideEffect;
  quotaIsUnlimited: boolean;
  quotaLimitValue: number | null;
  quotaUnit: string | null;
  reason: string;
  source: OverrideSource;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
};

type AssignmentRow = {
  id: string;
  plan_key: string;
  offer_version: number | string;
  offer_hash: string;
  currency: string;
  source: string;
  reason: string | null;
  status: AssignmentStatus;
  effective_from: Date;
  effective_to: Date | null;
  trial_ends_at: Date | null;
  grace_ends_at: Date | null;
  superseded_at: Date | null;
  suspended_at: Date | null;
  suspend_reason: string | null;
  resumed_at: Date | null;
  canceled_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

type OverrideRow = {
  id: string;
  target_kind: OverrideTargetKind;
  target_key: string;
  effect: OverrideEffect;
  quota_is_unlimited: boolean;
  quota_limit_value: number | string | null;
  quota_unit: string | null;
  reason: string;
  source: OverrideSource;
  effective_from: Date;
  effective_to: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  created_at: Date;
};

function toAssignmentDto(row: AssignmentRow): EntitlementAssignmentDto {
  return {
    id: row.id,
    planKey: row.plan_key,
    offerVersion: Number(row.offer_version),
    offerHash: row.offer_hash,
    currency: row.currency,
    source: row.source,
    reason: row.reason,
    status: row.status,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: row.effective_to?.toISOString() ?? null,
    trialEndsAt: row.trial_ends_at?.toISOString() ?? null,
    graceEndsAt: row.grace_ends_at?.toISOString() ?? null,
    isCurrent: row.superseded_at === null && row.canceled_at === null,
    supersededAt: row.superseded_at?.toISOString() ?? null,
    suspendedAt: row.suspended_at?.toISOString() ?? null,
    suspendReason: row.suspend_reason,
    resumedAt: row.resumed_at?.toISOString() ?? null,
    canceledAt: row.canceled_at?.toISOString() ?? null,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function toOverrideDto(row: OverrideRow): EntitlementOverrideDto {
  return {
    id: row.id,
    targetKind: row.target_kind,
    targetKey: row.target_key,
    effect: row.effect,
    quotaIsUnlimited: row.quota_is_unlimited,
    quotaLimitValue:
      row.quota_limit_value === null ? null : Number(row.quota_limit_value),
    quotaUnit: row.quota_unit,
    reason: row.reason,
    source: row.source,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: row.effective_to?.toISOString() ?? null,
    isActive: row.revoked_at === null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokeReason: row.revoke_reason,
    createdAt: row.created_at.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Reads (bounded)
// ---------------------------------------------------------------------------

export async function listAssignments(
  tx: Bun.SQL,
  tenantId: string
): Promise<EntitlementAssignmentDto[]> {
  const rows = (await tx`
    SELECT id, plan_key, offer_version, offer_hash, currency, source, reason, status,
      effective_from, effective_to, trial_ends_at, grace_ends_at, superseded_at,
      suspended_at, suspend_reason, resumed_at, canceled_at, cancel_reason,
      created_at, updated_at
    FROM awcms_mini_tenant_entitlement_assignments
    WHERE tenant_id = ${tenantId}
    ORDER BY plan_key ASC, created_at DESC
    LIMIT 500
  `) as AssignmentRow[];
  return rows.map(toAssignmentDto);
}

export async function listOverrides(
  tx: Bun.SQL,
  tenantId: string
): Promise<EntitlementOverrideDto[]> {
  const rows = (await tx`
    SELECT id, target_kind, target_key, effect, quota_is_unlimited, quota_limit_value,
      quota_unit, reason, source, effective_from, effective_to, revoked_at, revoke_reason, created_at
    FROM awcms_mini_tenant_entitlement_overrides
    WHERE tenant_id = ${tenantId}
    ORDER BY target_kind ASC, target_key ASC, created_at DESC
    LIMIT 500
  `) as OverrideRow[];
  return rows.map(toOverrideDto);
}

async function fetchAssignmentById(
  tx: Bun.SQL,
  tenantId: string,
  assignmentId: string
): Promise<EntitlementAssignmentDto | null> {
  const rows = (await tx`
    SELECT id, plan_key, offer_version, offer_hash, currency, source, reason, status,
      effective_from, effective_to, trial_ends_at, grace_ends_at, superseded_at,
      suspended_at, suspend_reason, resumed_at, canceled_at, cancel_reason,
      created_at, updated_at
    FROM awcms_mini_tenant_entitlement_assignments
    WHERE tenant_id = ${tenantId} AND id = ${assignmentId}
  `) as AssignmentRow[];
  return rows[0] ? toAssignmentDto(rows[0]) : null;
}

async function fetchOverrideById(
  tx: Bun.SQL,
  tenantId: string,
  overrideId: string
): Promise<EntitlementOverrideDto | null> {
  const rows = (await tx`
    SELECT id, target_kind, target_key, effect, quota_is_unlimited, quota_limit_value,
      quota_unit, reason, source, effective_from, effective_to, revoked_at, revoke_reason, created_at
    FROM awcms_mini_tenant_entitlement_overrides
    WHERE tenant_id = ${tenantId} AND id = ${overrideId}
  `) as OverrideRow[];
  return rows[0] ? toOverrideDto(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Snapshot + event (same-commit) — shared by every mutation
// ---------------------------------------------------------------------------

function snapshotArrays(entitlement: EffectiveEntitlement): {
  features: unknown[];
  modules: unknown[];
  quotas: unknown[];
} {
  return {
    features: Object.keys(entitlement.features)
      .sort()
      .map((key) => ({ key, ...entitlement.features[key]! })),
    modules: Object.keys(entitlement.modules)
      .sort()
      .map((key) => ({ key, ...entitlement.modules[key]! })),
    quotas: Object.keys(entitlement.quotas)
      .sort()
      .map((key) => ({ key, ...entitlement.quotas[key]! }))
  };
}

/**
 * Resolve the NEW effective entitlement and write an append-only snapshot in
 * the caller's transaction (same-commit). Returns the snapshot hash. The domain
 * event is emitted by the caller with a DIRECT, imported event-type constant
 * (not routed through this helper) so the publish-root derivation gate
 * (`tests/unit/domain-event-consumer-registration-wiring.test.ts`, Issue
 * #848) can statically resolve every `appendDomainEvent` eventType operand — an
 * operand reached via an object property would be a "blind spot".
 */
async function writeChangeSnapshot(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  deps: EntitlementResolutionDeps,
  trigger: "assignment_changed" | "override_changed",
  triggerEventType: string,
  correlationId?: string
): Promise<string> {
  const now = new Date();
  const entitlement = await resolveTenantEntitlement(tx, tenantId, deps, now);
  const arrays = snapshotArrays(entitlement);

  await tx`
    INSERT INTO awcms_mini_tenant_entitlement_evaluation_snapshots
      (tenant_id, resolved_at, trigger, trigger_event_type, features, modules, quotas,
       snapshot_hash, correlation_id, created_by)
    VALUES (
      ${tenantId}, ${now}, ${trigger}, ${triggerEventType},
      ${arrays.features}::jsonb, ${arrays.modules}::jsonb, ${arrays.quotas}::jsonb,
      ${entitlement.snapshotHash}, ${correlationId ?? null}, ${actorTenantUserId}
    )
  `;

  return entitlement.snapshotHash;
}

// ---------------------------------------------------------------------------
// Assign (subscribe to a published offer; supersedes the current assignment)
// ---------------------------------------------------------------------------

export type AssignResult =
  | { ok: true; assignment: EntitlementAssignmentDto; snapshotHash: string }
  | { ok: false; reason: "validation"; errors: EntitlementValidationError[] }
  | { ok: false; reason: "offer_not_found" }
  | { ok: false; reason: "conflict" };

export async function assignEntitlement(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: AssignInput,
  deps: EntitlementResolutionDeps,
  correlationId?: string
): Promise<AssignResult> {
  const errors = validateAssignInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  // The offer MUST be a real PUBLISHED offer version (read-only port); its
  // hash + currency are snapshotted onto the assignment for reproducibility.
  const offer = await deps.catalogPort.getPublishedOffer(
    input.planKey,
    input.offerVersion
  );
  if (!offer) {
    return { ok: false, reason: "offer_not_found" };
  }

  // Concurrency: lock the CURRENT assignment for this plan (if any), supersede
  // it, then INSERT the new current row with `ON CONFLICT` on the partial
  // unique index. A concurrent assign either blocks on the same locked current
  // row (then finds it superseded and loses the INSERT), or races the INSERT —
  // either way the loser gets 0 rows -> a clean `conflict` (409), never a raw
  // unique violation, and the route replays a same-Idempotency-Key winner.
  const current = (await tx`
    SELECT id FROM awcms_mini_tenant_entitlement_assignments
    WHERE tenant_id = ${tenantId} AND plan_key = ${input.planKey}
      AND superseded_at IS NULL AND canceled_at IS NULL
    FOR UPDATE
  `) as { id: string }[];

  if (current[0]) {
    await tx`
      UPDATE awcms_mini_tenant_entitlement_assignments
      SET superseded_at = now(), superseded_by = ${actorTenantUserId},
          updated_by = ${actorTenantUserId}, updated_at = now()
      WHERE id = ${current[0].id} AND superseded_at IS NULL
    `;
  }

  const inserted = (await tx`
    INSERT INTO awcms_mini_tenant_entitlement_assignments
      (tenant_id, plan_key, offer_version, offer_hash, currency, source, reason,
       effective_from, effective_to, trial_ends_at, grace_ends_at, created_by, updated_by)
    VALUES (
      ${tenantId}, ${input.planKey}, ${input.offerVersion}, ${offer.offerHash},
      ${offer.currency}, ${input.source}, ${input.reason},
      ${input.effectiveFrom ?? new Date().toISOString()}, ${input.effectiveTo},
      ${input.trialEndsAt}, ${input.graceEndsAt},
      ${actorTenantUserId}, ${actorTenantUserId}
    )
    ON CONFLICT (tenant_id, plan_key) WHERE superseded_at IS NULL AND canceled_at IS NULL
    DO NOTHING
    RETURNING id
  `) as { id: string }[];

  if (inserted.length === 0) {
    return { ok: false, reason: "conflict" };
  }
  const assignmentId = inserted[0]!.id;

  const snapshotHash = await writeChangeSnapshot(
    tx,
    tenantId,
    actorTenantUserId,
    deps,
    "assignment_changed",
    TENANT_ENTITLEMENT_ASSIGNMENT_CHANGED_EVENT_TYPE,
    correlationId
  );
  await appendDomainEvent(tx, tenantId, {
    eventType: TENANT_ENTITLEMENT_ASSIGNMENT_CHANGED_EVENT_TYPE,
    eventVersion: TENANT_ENTITLEMENT_EVENT_VERSION,
    aggregateType: "tenant_entitlement_assignment",
    aggregateId: assignmentId,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {
      assignmentId,
      planKey: input.planKey,
      offerVersion: input.offerVersion,
      changeType: "assigned",
      status: "active",
      snapshotHash
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "assign",
    resourceType: "tenant_entitlement_assignment",
    resourceId: assignmentId,
    severity: "warning",
    message: `Tenant assigned to offer "${input.planKey}" v${input.offerVersion}.`,
    attributes: {
      planKey: input.planKey,
      offerVersion: input.offerVersion,
      source: input.source,
      snapshotHash
    },
    correlationId
  });

  const assignment = await fetchAssignmentById(tx, tenantId, assignmentId);
  return { ok: true, assignment: assignment!, snapshotHash };
}

// ---------------------------------------------------------------------------
// Transition (suspend / resume / cancel)
// ---------------------------------------------------------------------------

export type TransitionResult =
  | { ok: true; assignment: EntitlementAssignmentDto; snapshotHash: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_transition"; message: string }
  | { ok: false; reason: "conflict" };

const TRANSITION_TO_CHANGE_TYPE: Record<AssignmentTransitionStatus, string> = {
  active: "resumed",
  suspended: "suspended",
  canceled: "canceled"
};

const TRANSITION_TO_AUDIT_ACTION: Record<AssignmentTransitionStatus, string> = {
  active: "resume",
  suspended: "suspend",
  canceled: "cancel"
};

export async function transitionAssignment(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  assignmentId: string,
  toStatus: AssignmentTransitionStatus,
  reason: string | null,
  deps: EntitlementResolutionDeps,
  correlationId?: string
): Promise<TransitionResult> {
  const locked = (await tx`
    SELECT id, status FROM awcms_mini_tenant_entitlement_assignments
    WHERE tenant_id = ${tenantId} AND id = ${assignmentId}
    FOR UPDATE
  `) as { id: string; status: AssignmentStatus }[];
  if (!locked[0]) {
    return { ok: false, reason: "not_found" };
  }
  const fromStatus = locked[0].status;
  if (fromStatus === toStatus) {
    // No-op transition (e.g. resume an active one) is treated as an invalid
    // request rather than a silent success — the route surfaces a clean 409.
    return {
      ok: false,
      reason: "invalid_transition",
      message: `Assignment is already "${toStatus}".`
    };
  }
  if (!isLegalTransition(fromStatus, toStatus)) {
    return {
      ok: false,
      reason: "invalid_transition",
      message: `Illegal transition ${fromStatus} -> ${toStatus} (a canceled assignment is terminal).`
    };
  }

  let updated: { id: string }[];
  if (toStatus === "suspended") {
    updated = (await tx`
      UPDATE awcms_mini_tenant_entitlement_assignments
      SET status = 'suspended', suspended_at = now(), suspended_by = ${actorTenantUserId},
          suspend_reason = ${reason}, updated_by = ${actorTenantUserId}, updated_at = now()
      WHERE id = ${assignmentId} AND status = 'active'
      RETURNING id
    `) as { id: string }[];
  } else if (toStatus === "active") {
    updated = (await tx`
      UPDATE awcms_mini_tenant_entitlement_assignments
      SET status = 'active', resumed_at = now(),
          updated_by = ${actorTenantUserId}, updated_at = now()
      WHERE id = ${assignmentId} AND status = 'suspended'
      RETURNING id
    `) as { id: string }[];
  } else {
    // cancel — entitlement loss; tenant data is NEVER deleted (ADR-0022 §6/§9).
    updated = (await tx`
      UPDATE awcms_mini_tenant_entitlement_assignments
      SET status = 'canceled', canceled_at = now(), canceled_by = ${actorTenantUserId},
          cancel_reason = ${reason}, updated_by = ${actorTenantUserId}, updated_at = now()
      WHERE id = ${assignmentId} AND status IN ('active', 'suspended')
      RETURNING id
    `) as { id: string }[];
  }

  if (updated.length === 0) {
    return { ok: false, reason: "conflict" };
  }

  const snapshotHash = await writeChangeSnapshot(
    tx,
    tenantId,
    actorTenantUserId,
    deps,
    "assignment_changed",
    TENANT_ENTITLEMENT_ASSIGNMENT_CHANGED_EVENT_TYPE,
    correlationId
  );
  await appendDomainEvent(tx, tenantId, {
    eventType: TENANT_ENTITLEMENT_ASSIGNMENT_CHANGED_EVENT_TYPE,
    eventVersion: TENANT_ENTITLEMENT_EVENT_VERSION,
    aggregateType: "tenant_entitlement_assignment",
    aggregateId: assignmentId,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {
      assignmentId,
      changeType: TRANSITION_TO_CHANGE_TYPE[toStatus],
      status: toStatus,
      snapshotHash
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: TRANSITION_TO_AUDIT_ACTION[toStatus],
    resourceType: "tenant_entitlement_assignment",
    resourceId: assignmentId,
    severity: "warning",
    message: `Tenant entitlement assignment ${TRANSITION_TO_CHANGE_TYPE[toStatus]}.`,
    attributes: { toStatus, reason, snapshotHash },
    correlationId
  });

  const assignment = await fetchAssignmentById(tx, tenantId, assignmentId);
  return { ok: true, assignment: assignment!, snapshotHash };
}

// ---------------------------------------------------------------------------
// Override create
// ---------------------------------------------------------------------------

export type CreateOverrideResult =
  | { ok: true; override: EntitlementOverrideDto; snapshotHash: string }
  | { ok: false; reason: "validation"; errors: EntitlementValidationError[] }
  | { ok: false; reason: "override_exists" };

export async function createOverride(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: OverrideInput,
  registry: EntitlementKeyRegistry,
  deps: EntitlementResolutionDeps,
  correlationId?: string
): Promise<CreateOverrideResult> {
  const errors = validateOverrideInput(input, registry);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  // Concurrency: at most one ACTIVE override per (tenant, kind, key) — the
  // partial unique index turns a concurrent duplicate into 0 rows (a clean
  // `override_exists` 409), never a raw 23505.
  const inserted = (await tx`
    INSERT INTO awcms_mini_tenant_entitlement_overrides
      (tenant_id, target_kind, target_key, effect, quota_is_unlimited, quota_limit_value,
       quota_unit, reason, source, effective_from, effective_to, created_by)
    VALUES (
      ${tenantId}, ${input.targetKind}, ${input.targetKey}, ${input.effect},
      ${input.quotaIsUnlimited}, ${input.quotaLimitValue}, ${input.quotaUnit},
      ${input.reason}, ${input.source},
      ${input.effectiveFrom ?? new Date().toISOString()}, ${input.effectiveTo},
      ${actorTenantUserId}
    )
    ON CONFLICT (tenant_id, target_kind, target_key) WHERE revoked_at IS NULL
    DO NOTHING
    RETURNING id
  `) as { id: string }[];

  if (inserted.length === 0) {
    return { ok: false, reason: "override_exists" };
  }
  const overrideId = inserted[0]!.id;

  const snapshotHash = await writeChangeSnapshot(
    tx,
    tenantId,
    actorTenantUserId,
    deps,
    "override_changed",
    TENANT_ENTITLEMENT_OVERRIDE_CHANGED_EVENT_TYPE,
    correlationId
  );
  await appendDomainEvent(tx, tenantId, {
    eventType: TENANT_ENTITLEMENT_OVERRIDE_CHANGED_EVENT_TYPE,
    eventVersion: TENANT_ENTITLEMENT_EVENT_VERSION,
    aggregateType: "tenant_entitlement_override",
    aggregateId: overrideId,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {
      overrideId,
      targetKind: input.targetKind,
      targetKey: input.targetKey,
      effect: input.effect,
      changeType: "created",
      snapshotHash
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "override",
    resourceType: "tenant_entitlement_override",
    resourceId: overrideId,
    severity: "warning",
    message: `Entitlement override created: ${input.effect} ${input.targetKind} "${input.targetKey}".`,
    attributes: {
      targetKind: input.targetKind,
      targetKey: input.targetKey,
      effect: input.effect,
      reason: input.reason,
      snapshotHash
    },
    correlationId
  });

  const override = await fetchOverrideById(tx, tenantId, overrideId);
  return { ok: true, override: override!, snapshotHash };
}

// ---------------------------------------------------------------------------
// Override revoke (one-way)
// ---------------------------------------------------------------------------

export type RevokeOverrideResult =
  | { ok: true; override: EntitlementOverrideDto; snapshotHash: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_revoked" };

export async function revokeOverride(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  overrideId: string,
  reason: string | null,
  deps: EntitlementResolutionDeps,
  correlationId?: string
): Promise<RevokeOverrideResult> {
  const locked = (await tx`
    SELECT id, revoked_at FROM awcms_mini_tenant_entitlement_overrides
    WHERE tenant_id = ${tenantId} AND id = ${overrideId}
    FOR UPDATE
  `) as { id: string; revoked_at: Date | null }[];
  if (!locked[0]) {
    return { ok: false, reason: "not_found" };
  }
  if (locked[0].revoked_at !== null) {
    return { ok: false, reason: "already_revoked" };
  }

  const updated = (await tx`
    UPDATE awcms_mini_tenant_entitlement_overrides
    SET revoked_at = now(), revoked_by = ${actorTenantUserId}, revoke_reason = ${reason}
    WHERE id = ${overrideId} AND revoked_at IS NULL
    RETURNING id
  `) as { id: string }[];
  if (updated.length === 0) {
    return { ok: false, reason: "already_revoked" };
  }

  const snapshotHash = await writeChangeSnapshot(
    tx,
    tenantId,
    actorTenantUserId,
    deps,
    "override_changed",
    TENANT_ENTITLEMENT_OVERRIDE_CHANGED_EVENT_TYPE,
    correlationId
  );
  await appendDomainEvent(tx, tenantId, {
    eventType: TENANT_ENTITLEMENT_OVERRIDE_CHANGED_EVENT_TYPE,
    eventVersion: TENANT_ENTITLEMENT_EVENT_VERSION,
    aggregateType: "tenant_entitlement_override",
    aggregateId: overrideId,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { overrideId, changeType: "revoked", snapshotHash }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "revoke",
    resourceType: "tenant_entitlement_override",
    resourceId: overrideId,
    severity: "warning",
    message: `Entitlement override revoked.`,
    attributes: { reason, snapshotHash },
    correlationId
  });

  const override = await fetchOverrideById(tx, tenantId, overrideId);
  return { ok: true, override: override!, snapshotHash };
}
