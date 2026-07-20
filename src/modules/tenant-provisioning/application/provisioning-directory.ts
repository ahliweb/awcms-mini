/**
 * `tenant_provisioning` record persistence + reads (Issue #872, epic #868,
 * ADR-0022). Low-level, tenant-scoped operations the orchestrator composes:
 * materialize a run's steps, acquire/renew a lease, append attempts, transition
 * steps/requests under STATE PREDICATES (clean 409 on a lost race), record
 * results/compensations/reconciliations, and read the timeline. Every function
 * runs inside the caller's `withTenant`-scoped `tx` (RLS = the target tenant),
 * NEVER deletes tenant data, and stores only minimized/redacted I/O (no
 * secret/password/token — ADR-0022 §3/§6/§8).
 */
import type {
  ProvisioningPlan,
  ProvisioningStepDefinition
} from "../domain/provisioning-plan";
import type {
  ReadinessState,
  RequestStatus,
  StepStatus
} from "../domain/provisioning-state";
import type { ProvisioningErrorClass } from "../domain/error-classification";
import type { CompensationStatus } from "../domain/compensation";
import type { ProvisioningCompensationClass } from "../../_shared/ports/provisioning-step-port";

// ---------------------------------------------------------------------------
// DTOs (API + timeline shape)
// ---------------------------------------------------------------------------

export type ProvisioningRequestDto = {
  id: string;
  tenantId: string;
  planKey: string;
  planVersion: number;
  targetKey: string;
  status: RequestStatus;
  readiness: ReadinessState;
  totalSteps: number;
  completedSteps: number;
  currentStepKey: string | null;
  lastErrorClass: string | null;
  blockedReason: string | null;
  requestedAt: string;
  startedAt: string | null;
  provisionedAt: string | null;
  failedAt: string | null;
  canceledAt: string | null;
  cancelReason: string | null;
  lastReconciledAt: string | null;
};

export type ProvisioningStepDto = {
  id: string;
  stepKey: string;
  stepIndex: number;
  stepKind: string;
  compensationClass: ProvisioningCompensationClass;
  optional: boolean;
  status: StepStatus;
  attemptCount: number;
  maxAttempts: number;
  lastErrorClass: string | null;
  lastErrorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type ProvisioningAttemptDto = {
  id: string;
  stepKey: string;
  attemptNumber: number;
  outcome: string;
  errorClass: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string;
};

export type ProvisioningResultDto = {
  stepKey: string;
  resultKind: string;
  resourceType: string | null;
  resourceId: string | null;
  output: Record<string, unknown>;
  createdAt: string;
};

export type ProvisioningCompensationDto = {
  stepKey: string;
  compensationClass: ProvisioningCompensationClass;
  status: CompensationStatus;
  action: string;
  note: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export type ProvisioningReconciliationDto = {
  id: string;
  status: "consistent" | "drift_detected" | "error";
  driftCount: number;
  drift: unknown[];
  checkedAt: string;
};

type RequestRow = {
  id: string;
  tenant_id: string;
  plan_key: string;
  plan_version: number | string;
  target_key: string;
  status: RequestStatus;
  readiness_state: ReadinessState;
  total_steps: number | string;
  completed_steps: number | string;
  current_step_key: string | null;
  last_error_class: string | null;
  blocked_reason: string | null;
  requested_at: Date;
  started_at: Date | null;
  provisioned_at: Date | null;
  failed_at: Date | null;
  canceled_at: Date | null;
  cancel_reason: string | null;
  last_reconciled_at: Date | null;
};

type StepRow = {
  id: string;
  step_key: string;
  step_index: number | string;
  step_kind: string;
  compensation_class: ProvisioningCompensationClass;
  optional: boolean;
  status: StepStatus;
  attempt_count: number | string;
  max_attempts: number | string;
  checkpoint: Record<string, unknown> | null;
  last_error_class: string | null;
  last_error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
};

export function toRequestDto(row: RequestRow): ProvisioningRequestDto {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    planKey: row.plan_key,
    planVersion: Number(row.plan_version),
    targetKey: row.target_key,
    status: row.status,
    readiness: row.readiness_state,
    totalSteps: Number(row.total_steps),
    completedSteps: Number(row.completed_steps),
    currentStepKey: row.current_step_key,
    lastErrorClass: row.last_error_class,
    blockedReason: row.blocked_reason,
    requestedAt: row.requested_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    provisionedAt: row.provisioned_at?.toISOString() ?? null,
    failedAt: row.failed_at?.toISOString() ?? null,
    canceledAt: row.canceled_at?.toISOString() ?? null,
    cancelReason: row.cancel_reason,
    lastReconciledAt: row.last_reconciled_at?.toISOString() ?? null
  };
}

function toStepDto(row: StepRow): ProvisioningStepDto {
  return {
    id: row.id,
    stepKey: row.step_key,
    stepIndex: Number(row.step_index),
    stepKind: row.step_kind,
    compensationClass: row.compensation_class,
    optional: row.optional,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    lastErrorClass: row.last_error_class,
    lastErrorMessage: row.last_error_message,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null
  };
}

const REQUEST_COLUMNS = `id, tenant_id, plan_key, plan_version, target_key, status,
  readiness_state, total_steps, completed_steps, current_step_key,
  last_error_class, blocked_reason, requested_at, started_at, provisioned_at,
  failed_at, canceled_at, cancel_reason, last_reconciled_at`;

const STEP_COLUMNS = `id, step_key, step_index, step_kind, compensation_class,
  optional, status, attempt_count, max_attempts, checkpoint, last_error_class,
  last_error_message, started_at, completed_at`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function findRequestByTenant(
  tx: Bun.SQL,
  tenantId: string
): Promise<ProvisioningRequestDto | null> {
  const rows = (await tx.unsafe(
    `SELECT ${REQUEST_COLUMNS} FROM awcms_mini_tenant_provisioning_requests
     WHERE tenant_id = $1`,
    [tenantId]
  )) as RequestRow[];
  return rows[0] ? toRequestDto(rows[0]) : null;
}

/** Load the persisted minimized inputs for a run (start/resume/reconcile reconstruct step inputs from these — never a secret). */
export async function loadInputs(
  tx: Bun.SQL,
  tenantId: string
): Promise<
  import("../../_shared/ports/provisioning-step-port").ProvisioningInputs | null
> {
  const rows = (await tx`
    SELECT inputs FROM awcms_mini_tenant_provisioning_requests
    WHERE tenant_id = ${tenantId}
  `) as { inputs: Record<string, unknown> | null }[];
  const raw = rows[0]?.inputs;
  if (!raw || typeof raw !== "object") return null;
  const options = (
    raw.options && typeof raw.options === "object" ? raw.options : {}
  ) as Record<string, unknown>;
  return {
    tenantCode: typeof raw.tenantCode === "string" ? raw.tenantCode : "",
    tenantName: typeof raw.tenantName === "string" ? raw.tenantName : "",
    options: {
      defaultLocale: (options.defaultLocale as string | null) ?? null,
      defaultTheme: (options.defaultTheme as string | null) ?? null,
      timezone: (options.timezone as string | null) ?? null,
      subdomain: (options.subdomain as string | null) ?? null,
      presetKey: (options.presetKey as string | null) ?? null,
      offerPlanKey: (options.offerPlanKey as string | null) ?? null,
      offerVersion: (options.offerVersion as number | null) ?? null
    }
  };
}

export async function findRequestRowByTenant(
  tx: Bun.SQL,
  tenantId: string
): Promise<{
  id: string;
  status: RequestStatus;
  inputsHash: string;
  idempotencyKey: string | null;
} | null> {
  const rows = (await tx`
    SELECT id, status, inputs_hash, idempotency_key
    FROM awcms_mini_tenant_provisioning_requests
    WHERE tenant_id = ${tenantId}
  `) as {
    id: string;
    status: RequestStatus;
    inputs_hash: string;
    idempotency_key: string | null;
  }[];
  const row = rows[0];
  return row
    ? {
        id: row.id,
        status: row.status,
        inputsHash: row.inputs_hash,
        idempotencyKey: row.idempotency_key
      }
    : null;
}

export async function listSteps(
  tx: Bun.SQL,
  requestId: string
): Promise<ProvisioningStepDto[]> {
  const rows = (await tx.unsafe(
    `SELECT ${STEP_COLUMNS} FROM awcms_mini_tenant_provisioning_steps
     WHERE request_id = $1 ORDER BY step_index ASC`,
    [requestId]
  )) as StepRow[];
  return rows.map(toStepDto);
}

export async function listAttempts(
  tx: Bun.SQL,
  requestId: string
): Promise<ProvisioningAttemptDto[]> {
  const rows = (await tx`
    SELECT id, step_key, attempt_number, outcome, error_class, error_message,
      started_at, finished_at
    FROM awcms_mini_tenant_provisioning_step_attempts
    WHERE request_id = ${requestId}
    ORDER BY created_at ASC
    LIMIT 500
  `) as {
    id: string;
    step_key: string;
    attempt_number: number | string;
    outcome: string;
    error_class: string | null;
    error_message: string | null;
    started_at: Date;
    finished_at: Date;
  }[];
  return rows.map((r) => ({
    id: r.id,
    stepKey: r.step_key,
    attemptNumber: Number(r.attempt_number),
    outcome: r.outcome,
    errorClass: r.error_class,
    errorMessage: r.error_message,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at.toISOString()
  }));
}

export async function listResults(
  tx: Bun.SQL,
  requestId: string
): Promise<ProvisioningResultDto[]> {
  const rows = (await tx`
    SELECT step_key, result_kind, resource_type, resource_id, output, created_at
    FROM awcms_mini_tenant_provisioning_results
    WHERE request_id = ${requestId}
    ORDER BY created_at ASC
  `) as {
    step_key: string;
    result_kind: string;
    resource_type: string | null;
    resource_id: string | null;
    output: Record<string, unknown>;
    created_at: Date;
  }[];
  return rows.map((r) => ({
    stepKey: r.step_key,
    resultKind: r.result_kind,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    output: r.output ?? {},
    createdAt: r.created_at.toISOString()
  }));
}

export async function listCompensations(
  tx: Bun.SQL,
  requestId: string
): Promise<ProvisioningCompensationDto[]> {
  const rows = (await tx`
    SELECT step_key, compensation_class, status, action, note, resolved_at, created_at
    FROM awcms_mini_tenant_provisioning_compensations
    WHERE request_id = ${requestId}
    ORDER BY created_at ASC
  `) as {
    step_key: string;
    compensation_class: ProvisioningCompensationClass;
    status: CompensationStatus;
    action: string;
    note: string | null;
    resolved_at: Date | null;
    created_at: Date;
  }[];
  return rows.map((r) => ({
    stepKey: r.step_key,
    compensationClass: r.compensation_class,
    status: r.status,
    action: r.action,
    note: r.note,
    resolvedAt: r.resolved_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString()
  }));
}

export async function listReconciliations(
  tx: Bun.SQL,
  requestId: string
): Promise<ProvisioningReconciliationDto[]> {
  const rows = (await tx`
    SELECT id, status, drift_count, drift, checked_at
    FROM awcms_mini_tenant_provisioning_reconciliations
    WHERE request_id = ${requestId}
    ORDER BY checked_at DESC
    LIMIT 100
  `) as {
    id: string;
    status: "consistent" | "drift_detected" | "error";
    drift_count: number | string;
    drift: unknown[];
    checked_at: Date;
  }[];
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    driftCount: Number(r.drift_count),
    drift: Array.isArray(r.drift) ? r.drift : [],
    checkedAt: r.checked_at.toISOString()
  }));
}

/** Map of stepKey -> completed result (for cross-step dependency access + reconciliation). */
export async function loadResultsMap(
  tx: Bun.SQL,
  requestId: string
): Promise<
  Map<
    string,
    {
      resultKind: string;
      resourceType: string | null;
      resourceId: string | null;
      output: Record<string, unknown>;
    }
  >
> {
  const results = await listResults(tx, requestId);
  return new Map(
    results.map((r) => [
      r.stepKey,
      {
        resultKind: r.resultKind,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        output: r.output
      }
    ])
  );
}

// ---------------------------------------------------------------------------
// Materialize a run's steps (request creation)
// ---------------------------------------------------------------------------

export type MaterializeStepInput = ProvisioningStepDefinition & {
  status: StepStatus;
  checkpoint?: Record<string, unknown> | null;
};

/** Insert the plan's steps for a request (bootstrap/owner pre-completed, rest pending). */
export async function insertSteps(
  tx: Bun.SQL,
  tenantId: string,
  requestId: string,
  steps: readonly MaterializeStepInput[]
): Promise<void> {
  let index = 0;
  for (const step of steps) {
    await tx`
      INSERT INTO awcms_mini_tenant_provisioning_steps
        (tenant_id, request_id, step_key, step_index, step_kind, compensation_class,
         optional, status, max_attempts, checkpoint,
         started_at, completed_at)
      VALUES (
        ${tenantId}, ${requestId}, ${step.stepKey}, ${index}, ${step.kind},
        ${step.compensationClass}, ${step.optional}, ${step.status},
        ${step.maxAttempts ?? 3}, ${step.checkpoint ?? null},
        ${step.status === "completed" ? new Date() : null},
        ${step.status === "completed" ? new Date() : null}
      )
    `;
    index += 1;
  }
}

/** Insert a result reference for a completed step (append-only). */
export async function insertResult(
  tx: Bun.SQL,
  tenantId: string,
  requestId: string,
  stepId: string,
  stepKey: string,
  input: {
    resultKind: string;
    resourceType?: string | null;
    resourceId?: string | null;
    output?: Record<string, unknown>;
    createdBy?: string | null;
  }
): Promise<void> {
  await tx`
    INSERT INTO awcms_mini_tenant_provisioning_results
      (tenant_id, request_id, step_id, step_key, result_kind, resource_type,
       resource_id, output, created_by)
    VALUES (
      ${tenantId}, ${requestId}, ${stepId}, ${stepKey}, ${input.resultKind},
      ${input.resourceType ?? null}, ${input.resourceId ?? null},
      ${input.output ?? {}}, ${input.createdBy ?? null}
    )
    ON CONFLICT (step_id) DO NOTHING
  `;
}

// ---------------------------------------------------------------------------
// Lease (concurrency ownership) + request row-lock
// ---------------------------------------------------------------------------

export async function loadRequestForUpdate(
  tx: Bun.SQL,
  tenantId: string,
  requestId: string
): Promise<{
  id: string;
  status: RequestStatus;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
} | null> {
  const rows = (await tx`
    SELECT id, status, lease_owner, lease_expires_at
    FROM awcms_mini_tenant_provisioning_requests
    WHERE tenant_id = ${tenantId} AND id = ${requestId}
    FOR UPDATE
  `) as {
    id: string;
    status: RequestStatus;
    lease_owner: string | null;
    lease_expires_at: Date | null;
  }[];
  const row = rows[0];
  return row
    ? {
        id: row.id,
        status: row.status,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at
      }
    : null;
}

/**
 * Acquire the run's exclusive lease. Assumes the row is already locked
 * (`loadRequestForUpdate`). Sets a fresh lease + moves `requested`/`failed`/
 * `blocked` -> `in_progress`. The state predicate + row lock make this a clean
 * check-then-act: a concurrent worker with a live lease is refused.
 */
export async function acquireLease(
  tx: Bun.SQL,
  requestId: string,
  leaseOwner: string,
  now: Date,
  leaseTtlMs: number
): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + leaseTtlMs);
  const rows = (await tx`
    UPDATE awcms_mini_tenant_provisioning_requests
    SET lease_owner = ${leaseOwner},
        lease_expires_at = ${expiresAt},
        status = CASE WHEN status IN ('requested', 'failed', 'blocked')
                      THEN 'in_progress' ELSE status END,
        started_at = COALESCE(started_at, ${now}),
        updated_at = now()
    WHERE id = ${requestId}
      AND status IN ('requested', 'in_progress', 'failed', 'blocked')
      AND (lease_owner IS NULL OR lease_expires_at < ${now})
    RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}

export async function releaseLease(
  tx: Bun.SQL,
  requestId: string,
  leaseOwner: string
): Promise<void> {
  await tx`
    UPDATE awcms_mini_tenant_provisioning_requests
    SET lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = ${requestId} AND lease_owner = ${leaseOwner}
  `;
}

/**
 * Re-assert AND renew the lease as a FENCING TOKEN at the start of each step's
 * transaction (Issue #872 review M-1). Returns false if this worker no longer
 * owns a live lease OR the run is no longer `in_progress` (e.g. it was canceled
 * by another actor after this worker's lease expired) — the caller then ABORTS
 * without completing/activating anything, so a zombie worker can never activate
 * a tenant behind a canceled/expired run. Locks the request row for the step's
 * duration (serializing with cancel), and extends the lease so a legitimately
 * running saga does not lose it mid-step.
 */
export async function fenceAndRenewLease(
  tx: Bun.SQL,
  requestId: string,
  leaseOwner: string,
  now: Date,
  leaseTtlMs: number
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_mini_tenant_provisioning_requests
    SET lease_expires_at = ${new Date(now.getTime() + leaseTtlMs)}, updated_at = now()
    WHERE id = ${requestId}
      AND lease_owner = ${leaseOwner}
      AND lease_expires_at > ${now}
      AND status = 'in_progress'
    RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}

/** Count steps that were compensated/undone (any compensation_* status) — used to refuse resume of an already-compensated run (review Med-B). */
export async function countCompensatedSteps(
  tx: Bun.SQL,
  requestId: string
): Promise<number> {
  const rows = (await tx`
    SELECT count(*)::int AS c FROM awcms_mini_tenant_provisioning_steps
    WHERE request_id = ${requestId}
      AND status IN ('compensation_pending', 'compensated', 'compensation_failed', 'compensation_manual')
  `) as { c: number }[];
  return Number(rows[0]?.c ?? 0);
}

/**
 * Transition a COMPLETED reversible step to `compensated` (completed ->
 * compensation_pending -> compensated) so the timeline records it was undone and
 * `reconcileProvisioning` treats it as drift, never a false `completed` (review
 * Med-B). Two state-predicated UPDATEs (the trigger forbids a direct
 * completed->compensated jump). Best-effort: a lost race is a no-op.
 */
export async function markStepCompensated(
  tx: Bun.SQL,
  stepId: string
): Promise<void> {
  await tx`
    UPDATE awcms_mini_tenant_provisioning_steps
    SET status = 'compensation_pending', updated_at = now()
    WHERE id = ${stepId} AND status = 'completed'
  `;
  await tx`
    UPDATE awcms_mini_tenant_provisioning_steps
    SET status = 'compensated', updated_at = now()
    WHERE id = ${stepId} AND status = 'compensation_pending'
  `;
}

// ---------------------------------------------------------------------------
// Step transitions (state-predicated)
// ---------------------------------------------------------------------------

export async function loadStepForUpdate(
  tx: Bun.SQL,
  tenantId: string,
  stepId: string
): Promise<StepRow | null> {
  const rows = (await tx.unsafe(
    `SELECT ${STEP_COLUMNS} FROM awcms_mini_tenant_provisioning_steps
     WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, stepId]
  )) as StepRow[];
  return rows[0] ?? null;
}

/** Mark a pending/failed step `running` and increment the attempt counter. Returns the new attempt number, or null on a lost race. */
export async function beginStepRun(
  tx: Bun.SQL,
  stepId: string
): Promise<number | null> {
  const rows = (await tx`
    UPDATE awcms_mini_tenant_provisioning_steps
    SET status = 'running', attempt_count = attempt_count + 1,
        started_at = COALESCE(started_at, now()), updated_at = now()
    WHERE id = ${stepId} AND status IN ('pending', 'failed', 'waiting')
    RETURNING attempt_count
  `) as { attempt_count: number | string }[];
  return rows[0] ? Number(rows[0].attempt_count) : null;
}

export async function recordAttempt(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    requestId: string;
    stepId: string;
    stepKey: string;
    attemptNumber: number;
    outcome: "succeeded" | "failed" | "waiting" | "skipped";
    errorClass?: ProvisioningErrorClass | null;
    errorMessage?: string | null;
    correlationId?: string | null;
    startedAt: Date;
    createdBy?: string | null;
  }
): Promise<void> {
  await tx`
    INSERT INTO awcms_mini_tenant_provisioning_step_attempts
      (tenant_id, request_id, step_id, step_key, attempt_number, outcome,
       error_class, error_message, correlation_id, started_at, finished_at, created_by)
    VALUES (
      ${input.tenantId}, ${input.requestId}, ${input.stepId}, ${input.stepKey},
      ${input.attemptNumber}, ${input.outcome}, ${input.errorClass ?? null},
      ${input.errorMessage ?? null}, ${input.correlationId ?? null},
      ${input.startedAt}, ${new Date()}, ${input.createdBy ?? null}
    )
  `;
}

export async function completeStep(
  tx: Bun.SQL,
  stepId: string,
  checkpoint: Record<string, unknown>
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_mini_tenant_provisioning_steps
    SET status = 'completed', checkpoint = ${checkpoint},
        completed_at = now(), last_error_class = NULL, last_error_message = NULL,
        updated_at = now()
    WHERE id = ${stepId} AND status = 'running'
    RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}

export async function skipStep(
  tx: Bun.SQL,
  stepId: string,
  reason: string
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_mini_tenant_provisioning_steps
    SET status = 'skipped', checkpoint = ${{ skipped: true, reason }},
        completed_at = now(), updated_at = now()
    WHERE id = ${stepId} AND status IN ('pending', 'running')
    RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}

export async function markStepWaiting(
  tx: Bun.SQL,
  stepId: string
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_mini_tenant_provisioning_steps
    SET status = 'waiting', waiting_since = now(), updated_at = now()
    WHERE id = ${stepId} AND status = 'running'
    RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}

export async function failStep(
  tx: Bun.SQL,
  stepId: string,
  errorClass: ProvisioningErrorClass,
  message: string
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_mini_tenant_provisioning_steps
    SET status = 'failed', last_error_class = ${errorClass},
        last_error_message = ${message.slice(0, 2000)}, updated_at = now()
    WHERE id = ${stepId} AND status IN ('running', 'waiting')
    RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Request transitions (state-predicated)
// ---------------------------------------------------------------------------

export type RequestPatch = {
  readiness?: ReadinessState;
  currentStepKey?: string | null;
  lastErrorClass?: string | null;
  blockedReason?: string | null;
  completedStepsDelta?: number;
  setProvisionedAt?: boolean;
  setFailedAt?: boolean;
  setCanceledAt?: boolean;
  canceledBy?: string | null;
  cancelReason?: string | null;
  setLastReconciledAt?: boolean;
  updatedBy?: string | null;
  /** When set, the UPDATE also re-asserts `lease_owner = expectedLeaseOwner AND lease_expires_at > now()` — a fencing token so a zombie worker whose lease was lost can never mark the run provisioned / activate the tenant (review M-1). */
  expectedLeaseOwner?: string;
};

/**
 * Transition a request from `expectedFrom` to `to` (or a same-status counter
 * write when `to === expectedFrom`) under a state predicate. Returns false on a
 * lost race (the caller returns a clean 409). Partial-column writes: only the
 * fields present in `patch` are written; the rest keep their live value.
 * `expectedLeaseOwner` additionally fences the transition to lease ownership.
 */
export async function transitionRequest(
  tx: Bun.SQL,
  requestId: string,
  expectedFrom: RequestStatus,
  to: RequestStatus,
  patch: RequestPatch = {}
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_mini_tenant_provisioning_requests
    SET status = ${to},
        readiness_state = COALESCE(${patch.readiness ?? null}, readiness_state),
        current_step_key = CASE WHEN ${patch.currentStepKey !== undefined}
          THEN ${patch.currentStepKey ?? null} ELSE current_step_key END,
        last_error_class = CASE WHEN ${patch.lastErrorClass !== undefined}
          THEN ${patch.lastErrorClass ?? null} ELSE last_error_class END,
        blocked_reason = CASE WHEN ${patch.blockedReason !== undefined}
          THEN ${patch.blockedReason ?? null} ELSE blocked_reason END,
        completed_steps = completed_steps + ${patch.completedStepsDelta ?? 0},
        provisioned_at = CASE WHEN ${patch.setProvisionedAt ?? false}
          THEN COALESCE(provisioned_at, now()) ELSE provisioned_at END,
        failed_at = CASE WHEN ${patch.setFailedAt ?? false}
          THEN now() ELSE failed_at END,
        canceled_at = CASE WHEN ${patch.setCanceledAt ?? false}
          THEN COALESCE(canceled_at, now()) ELSE canceled_at END,
        canceled_by = COALESCE(${patch.canceledBy ?? null}, canceled_by),
        cancel_reason = CASE WHEN ${patch.cancelReason !== undefined}
          THEN ${patch.cancelReason ?? null} ELSE cancel_reason END,
        last_reconciled_at = CASE WHEN ${patch.setLastReconciledAt ?? false}
          THEN now() ELSE last_reconciled_at END,
        updated_by = COALESCE(${patch.updatedBy ?? null}, updated_by),
        updated_at = now()
    WHERE id = ${requestId} AND status = ${expectedFrom}
      AND (${patch.expectedLeaseOwner ?? null}::text IS NULL
           OR (lease_owner = ${patch.expectedLeaseOwner ?? null}
               AND lease_expires_at > now()))
    RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Compensation + reconciliation records
// ---------------------------------------------------------------------------

export async function recordCompensation(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    requestId: string;
    stepId: string;
    stepKey: string;
    compensationClass: ProvisioningCompensationClass;
    status: CompensationStatus;
    action: string;
    note?: string | null;
    resolvedBy?: string | null;
    createdBy?: string | null;
  }
): Promise<void> {
  const resolved =
    input.status === "completed" ||
    input.status === "skipped_forbidden" ||
    input.status === "manual_required";
  await tx`
    INSERT INTO awcms_mini_tenant_provisioning_compensations
      (tenant_id, request_id, step_id, step_key, compensation_class, status,
       action, note, resolved_at, resolved_by, created_by)
    VALUES (
      ${input.tenantId}, ${input.requestId}, ${input.stepId}, ${input.stepKey},
      ${input.compensationClass}, ${input.status}, ${input.action},
      ${input.note ?? null}, ${resolved ? new Date() : null},
      ${input.resolvedBy ?? null}, ${input.createdBy ?? null}
    )
    ON CONFLICT (step_id) DO NOTHING
  `;
}

export async function recordReconciliation(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    requestId: string;
    status: "consistent" | "drift_detected" | "error";
    drift: unknown[];
    correlationId?: string | null;
    checkedBy?: string | null;
  }
): Promise<string> {
  const rows = (await tx`
    INSERT INTO awcms_mini_tenant_provisioning_reconciliations
      (tenant_id, request_id, status, drift_count, drift, correlation_id, checked_by)
    VALUES (
      ${input.tenantId}, ${input.requestId}, ${input.status},
      ${input.drift.length}, ${input.drift}, ${input.correlationId ?? null},
      ${input.checkedBy ?? null}
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

/** Assemble the full timeline DTO for a run (request + steps + attempts + results + compensations + reconciliations). */
export async function loadTimeline(
  tx: Bun.SQL,
  tenantId: string
): Promise<{
  request: ProvisioningRequestDto;
  steps: ProvisioningStepDto[];
  attempts: ProvisioningAttemptDto[];
  results: ProvisioningResultDto[];
  compensations: ProvisioningCompensationDto[];
  reconciliations: ProvisioningReconciliationDto[];
} | null> {
  const request = await findRequestByTenant(tx, tenantId);
  if (!request) return null;
  // Sequential (NOT Promise.all) — concurrent queries on one transaction hang
  // (memory `promise-all-on-single-tx-hang`).
  const steps = await listSteps(tx, request.id);
  const attempts = await listAttempts(tx, request.id);
  const results = await listResults(tx, request.id);
  const compensations = await listCompensations(tx, request.id);
  const reconciliations = await listReconciliations(tx, request.id);
  return { request, steps, attempts, results, compensations, reconciliations };
}

/** Build the materialize list from a plan: bootstrap+owner pre-completed, rest pending. */
export function planToMaterializeSteps(
  plan: ProvisioningPlan,
  preCompleted: Readonly<Record<string, Record<string, unknown>>>
): MaterializeStepInput[] {
  return plan.steps.map((step) => {
    const checkpoint = preCompleted[step.stepKey];
    return {
      ...step,
      status: checkpoint ? "completed" : "pending",
      checkpoint: checkpoint ?? null
    };
  });
}
