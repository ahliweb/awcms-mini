/**
 * `tenant_lifecycle` data access (Issue #873). Every write path follows the
 * concurrency discipline (epic pattern #3): row-lock the single state row
 * (`SELECT ... FOR UPDATE`) BEFORE a check-then-write, then a state+version-
 * predicated `UPDATE` so a concurrent/invalid transition yields 0 rows (a
 * deterministic 409). The initial record is an `INSERT ... ON CONFLICT DO
 * NOTHING` so two concurrent initializations cannot both create a lifecycle
 * row. All queries run inside an already tenant-scoped `tx` (RLS predicate is
 * ALWAYS AND ONLY `tenant_id`). Pure SQL — no cross-module imports.
 */
import type {
  LifecycleSource,
  LifecycleState
} from "../domain/lifecycle-state";

export type LifecycleStateRow = {
  id: string;
  tenant_id: string;
  state: LifecycleState;
  previous_state: LifecycleState | null;
  version: number;
  reason: string | null;
  source: LifecycleSource;
  actor: string | null;
  effective_at: string;
  entered_at: string;
  trial_ends_at: string | null;
  grace_ends_at: string | null;
  scheduled_to_state: LifecycleState | null;
  scheduled_at: string | null;
  scheduled_reason: string | null;
  scheduled_source: LifecycleSource | null;
  scheduled_by: string | null;
  created_at: string;
  updated_at: string;
};

export type LifecycleStateDto = {
  tenantId: string;
  state: LifecycleState;
  previousState: LifecycleState | null;
  version: number;
  reason: string | null;
  source: LifecycleSource;
  effectiveAt: string;
  enteredAt: string;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  scheduledToState: LifecycleState | null;
  scheduledAt: string | null;
  scheduledReason: string | null;
};

export function toLifecycleDto(row: LifecycleStateRow): LifecycleStateDto {
  return {
    tenantId: row.tenant_id,
    state: row.state,
    previousState: row.previous_state,
    version: Number(row.version),
    reason: row.reason,
    source: row.source,
    effectiveAt: row.effective_at,
    enteredAt: row.entered_at,
    trialEndsAt: row.trial_ends_at,
    graceEndsAt: row.grace_ends_at,
    scheduledToState: row.scheduled_to_state,
    scheduledAt: row.scheduled_at,
    scheduledReason: row.scheduled_reason
  };
}

/**
 * Create the lifecycle record if absent (idempotent; `ON CONFLICT DO NOTHING`).
 * Returns the current row either way (the created one or the pre-existing).
 */
export async function ensureLifecycleRecord(
  tx: Bun.SQL,
  tenantId: string,
  input: {
    initialState: LifecycleState;
    reason: string;
    source: LifecycleSource;
    actor: string | null;
    trialEndsAt: string | null;
    graceEndsAt: string | null;
  }
): Promise<{ row: LifecycleStateRow; created: boolean }> {
  const inserted = (await tx`
    INSERT INTO awcms_mini_tenant_lifecycle_states
      (tenant_id, state, reason, source, actor, trial_ends_at, grace_ends_at,
       created_by, updated_by)
    VALUES (${tenantId}, ${input.initialState}, ${input.reason}, ${input.source},
       ${input.actor}, ${input.trialEndsAt}, ${input.graceEndsAt},
       ${input.actor}, ${input.actor})
    ON CONFLICT (tenant_id) DO NOTHING
    RETURNING *
  `) as LifecycleStateRow[];

  if (inserted[0]) {
    return { row: inserted[0], created: true };
  }

  const existing = await loadState(tx, tenantId);
  // The ON CONFLICT loser re-reads the winner's row (guaranteed to exist).
  return { row: existing!, created: false };
}

export async function loadState(
  tx: Bun.SQL,
  tenantId: string
): Promise<LifecycleStateRow | null> {
  const rows = (await tx`
    SELECT * FROM awcms_mini_tenant_lifecycle_states
    WHERE tenant_id = ${tenantId}
  `) as LifecycleStateRow[];
  return rows[0] ?? null;
}

/** Row-lock the state row before a check-then-write (epic pattern #3). */
export async function loadStateForUpdate(
  tx: Bun.SQL,
  tenantId: string
): Promise<LifecycleStateRow | null> {
  const rows = (await tx`
    SELECT * FROM awcms_mini_tenant_lifecycle_states
    WHERE tenant_id = ${tenantId}
    FOR UPDATE
  `) as LifecycleStateRow[];
  return rows[0] ?? null;
}

/**
 * State+version-predicated transition. Advances `version` by one, records
 * `previous_state`, refreshes provenance, and CLEARS any pending schedule. The
 * `WHERE ... state = ${fromState} AND version = ${fromVersion}` predicate makes
 * a lost race a 0-row result (deterministic conflict), even though the caller
 * already holds the row lock (defence in depth + mirrors the DB trigger).
 */
export async function applyTransition(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    fromState: LifecycleState;
    fromVersion: number;
    toState: LifecycleState;
    reason: string;
    source: LifecycleSource;
    actor: string | null;
    effectiveAt: string | null;
  }
): Promise<LifecycleStateRow | null> {
  const rows = (await tx`
    UPDATE awcms_mini_tenant_lifecycle_states
    SET state = ${input.toState},
        previous_state = ${input.fromState},
        version = version + 1,
        reason = ${input.reason},
        source = ${input.source},
        actor = ${input.actor},
        effective_at = ${input.effectiveAt ?? new Date().toISOString()},
        entered_at = now(),
        scheduled_to_state = NULL,
        scheduled_at = NULL,
        scheduled_reason = NULL,
        scheduled_source = NULL,
        scheduled_by = NULL,
        updated_at = now(),
        updated_by = ${input.actor}
    WHERE tenant_id = ${input.tenantId}
      AND state = ${input.fromState}
      AND version = ${input.fromVersion}
    RETURNING *
  `) as LifecycleStateRow[];
  return rows[0] ?? null;
}

/** Set the single pending scheduled transition (no version change — not a state change). */
export async function setSchedule(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    currentState: LifecycleState;
    version: number;
    toState: LifecycleState;
    at: string;
    reason: string;
    source: LifecycleSource;
    actor: string | null;
  }
): Promise<LifecycleStateRow | null> {
  const rows = (await tx`
    UPDATE awcms_mini_tenant_lifecycle_states
    SET scheduled_to_state = ${input.toState},
        scheduled_at = ${input.at},
        scheduled_reason = ${input.reason},
        scheduled_source = ${input.source},
        scheduled_by = ${input.actor},
        updated_at = now(),
        updated_by = ${input.actor}
    WHERE tenant_id = ${input.tenantId}
      AND state = ${input.currentState}
      AND version = ${input.version}
    RETURNING *
  `) as LifecycleStateRow[];
  return rows[0] ?? null;
}

/** Clear the pending scheduled transition (no version change). */
export async function clearSchedule(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    currentState: LifecycleState;
    version: number;
    actor: string | null;
  }
): Promise<LifecycleStateRow | null> {
  const rows = (await tx`
    UPDATE awcms_mini_tenant_lifecycle_states
    SET scheduled_to_state = NULL,
        scheduled_at = NULL,
        scheduled_reason = NULL,
        scheduled_source = NULL,
        scheduled_by = NULL,
        updated_at = now(),
        updated_by = ${input.actor}
    WHERE tenant_id = ${input.tenantId}
      AND state = ${input.currentState}
      AND version = ${input.version}
    RETURNING *
  `) as LifecycleStateRow[];
  return rows[0] ?? null;
}

export type LifecycleHistoryEventKind =
  | "transition"
  | "downgrade"
  | "schedule_set"
  | "schedule_canceled"
  | "restore"
  | "reconciled";

export async function appendHistory(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    eventKind: LifecycleHistoryEventKind;
    fromState: LifecycleState | null;
    toState: LifecycleState;
    version: number;
    reason: string | null;
    source: LifecycleSource;
    actor: string | null;
    correlationId: string | null;
    scheduledAt: string | null;
    metadata: Record<string, unknown>;
    effectiveAt: string | null;
  }
): Promise<void> {
  await tx`
    INSERT INTO awcms_mini_tenant_lifecycle_history
      (tenant_id, event_kind, from_state, to_state, version, reason, source,
       actor, correlation_id, scheduled_at, metadata, effective_at, created_by)
    VALUES (${input.tenantId}, ${input.eventKind}, ${input.fromState},
       ${input.toState}, ${input.version}, ${input.reason}, ${input.source},
       ${input.actor}, ${input.correlationId}, ${input.scheduledAt},
       ${input.metadata}, ${input.effectiveAt ?? new Date().toISOString()},
       ${input.actor})
  `;
}

export type LifecycleHistoryDto = {
  eventKind: string;
  fromState: string | null;
  toState: string;
  version: number;
  reason: string | null;
  source: string;
  scheduledAt: string | null;
  metadata: Record<string, unknown>;
  effectiveAt: string;
  createdAt: string;
};

export async function listHistory(
  tx: Bun.SQL,
  tenantId: string,
  limit: number
): Promise<LifecycleHistoryDto[]> {
  const rows = (await tx`
    SELECT event_kind, from_state, to_state, version, reason, source,
           scheduled_at, metadata, effective_at, created_at
    FROM awcms_mini_tenant_lifecycle_history
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `) as {
    event_kind: string;
    from_state: string | null;
    to_state: string;
    version: number;
    reason: string | null;
    source: string;
    scheduled_at: string | null;
    metadata: Record<string, unknown>;
    effective_at: string;
    created_at: string;
  }[];
  return rows.map((row) => ({
    eventKind: row.event_kind,
    fromState: row.from_state,
    toState: row.to_state,
    version: Number(row.version),
    reason: row.reason,
    source: row.source,
    scheduledAt: row.scheduled_at,
    metadata: row.metadata,
    effectiveAt: row.effective_at,
    createdAt: row.created_at
  }));
}
