/**
 * `tenant_provisioning` orchestration engine (Issue #872, epic #868, ADR-0022
 * §9/§11.1). Idempotent, resumable commands: request, start/resume, cancel,
 * retry, reconcile.
 *
 * TRANSACTION MODEL (durable checkpoints + provider outside the source tx):
 *   - `request` runs ONE transaction: create the tenant (ACID anti-duplicate on
 *     `tenant_code`), owner, office, settings, request + step rows, and emit the
 *     `requested` event — all same-commit. The two secret-bearing steps
 *     (tenant bootstrap + owner) run here (they need the request-time owner
 *     password, which is never stored) and are recorded pre-completed.
 *   - `start`/`resume`/`retry` acquire an exclusive LEASE (row-lock +
 *     state-predicate → clean 409 on a concurrent run; an expired lease is
 *     reclaimable → worker-restart safe), then run each remaining step in its
 *     OWN transaction, RE-ASSERTING + renewing the lease as a fencing token at
 *     the start of each step tx (M-1) so a completed step's checkpoint is durable
 *     before the next step starts and a zombie worker whose lease expired can
 *     never complete a step / activate a tenant behind a canceled/expired run. A
 *     `provider` step that dispatches external work returns `waiting` (event out
 *     via the outbox, OUTSIDE any provider call) and the run pauses until resumed.
 *   - A non-retryable step failure BLOCKS the run (visible), leaving completed
 *     steps intact so a later retry resumes — compensation is NEVER run on
 *     failure (AC "provider failure yields retry/manual state, not rollback of
 *     committed core state"). COMPENSATION (reversible undo / manual / forbidden
 *     — never a tenant-data delete) runs only on explicit CANCEL, which is
 *     terminal and non-resumable. A failed/canceled run NEVER leaves the tenant
 *     active (it stays inactive + visible blocked/failed/canceled +
 *     readiness=blocked, AC). ACTIVATION happens ONLY in the finalize path,
 *     gated on (lease owned + in_progress + all steps completed/skipped with no
 *     compensated step + activation being the terminal step).
 *
 * All cross-module work (tenant/owner creation, entitlement, module preset,
 * subdomain, tenant activation) is via INJECTED deps assembled at the
 * composition root; `domain_event_runtime`/`logging` are imported directly
 * (foundational infra, same as `tenant_entitlement`).
 */
import { createHash } from "node:crypto";
import { assertUuid } from "../../../lib/database/tenant-context";
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  TENANT_PROVISIONING_COMPLETED_EVENT_TYPE,
  TENANT_PROVISIONING_EVENT_VERSION,
  TENANT_PROVISIONING_FAILED_EVENT_TYPE,
  TENANT_PROVISIONING_RECONCILED_EVENT_TYPE,
  TENANT_PROVISIONING_REQUESTED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import type {
  ProvisioningInputs,
  ProvisioningPriorResult,
  ProvisioningStepContext,
  ProvisioningStepExecution,
  ProvisioningStepHandler
} from "../../_shared/ports/provisioning-step-port";
import {
  classifyThrownError,
  shouldRetry,
  type ProvisioningErrorClass
} from "../domain/error-classification";
import { compensationActionFor } from "../domain/compensation";
import {
  CORE_STEP_KEYS,
  getProvisioningPlan,
  type ProvisioningPlan
} from "../domain/provisioning-plan";
import { isCancelableStatus } from "../domain/provisioning-state";
import type { ProvisioningRequestInput } from "../domain/request-validation";
import { validateProvisioningRequest } from "../domain/request-validation";
import { getContributedProvisioningStep } from "../infrastructure/step-handler-registry";
import type { CoreStepDeps } from "./core-step-handlers";
import { createCoreStepHandlers } from "./core-step-handlers";
import {
  acquireLease,
  completeStep,
  countCompensatedSteps,
  failStep,
  fenceAndRenewLease,
  findRequestByTenant,
  findRequestRowByTenant,
  insertResult,
  insertSteps,
  listSteps,
  loadInputs,
  loadRequestForUpdate,
  loadResultsMap,
  loadStepForUpdate,
  markStepCompensated,
  markStepWaiting,
  planToMaterializeSteps,
  recordAttempt,
  recordCompensation,
  recordReconciliation,
  releaseLease,
  beginStepRun,
  skipStep,
  transitionRequest,
  toRequestDto,
  type ProvisioningRequestDto
} from "./provisioning-directory";

const MODULE_KEY = "tenant_provisioning";
const DEFAULT_LEASE_TTL_MS = 60_000;

/**
 * Run `fn` in a fresh transaction scoped to `tenantId` (RLS). Deliberately NOT
 * `withTenant` (which is route-shaped: it can return a 503 `Response` on pool
 * saturation, which would corrupt the engine's typed result checks). The engine
 * manages ONE transaction per step so a completed step's checkpoint commits
 * before the next step starts (durable checkpoints / resumability).
 */
async function inTenantTx<T>(
  sql: Bun.SQL,
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  const safe = assertUuid(tenantId);
  return sql.begin(async (tx: Bun.SQL) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${safe}'`);
    return fn(tx);
  }) as Promise<T>;
}

/** Onboarding deps (reuse `tenant_admin` tenant-onboarding helpers), injected at the composition root. */
export type ProvisioningOnboardingDeps = {
  createTenantIfAbsent(
    tx: Bun.SQL,
    input: {
      tenantCode: string;
      tenantName: string;
      legalName: string | null;
      defaultLocale: string | null;
      createdBy: string | null;
    }
  ): Promise<{ tenantId: string; created: boolean }>;
  initTenantSettings(tx: Bun.SQL, tenantId: string): Promise<void>;
  createHeadOffice(
    tx: Bun.SQL,
    tenantId: string,
    input: { officeCode: string; officeName: string; createdBy: string | null }
  ): Promise<{ officeId: string }>;
  createOwner(
    tx: Bun.SQL,
    tenantId: string,
    input: {
      ownerDisplayName: string;
      ownerLoginIdentifier: string;
      ownerPassword: string;
      createdBy: string | null;
    }
  ): Promise<{
    ownerProfileId: string;
    ownerIdentityId: string;
    ownerTenantUserId: string;
    ownerRoleId: string;
  }>;
};

export type ProvisioningEngineDeps = {
  onboarding: ProvisioningOnboardingDeps;
  steps: CoreStepDeps;
};

/** Bind the idempotency/inputs hash to the target identity (tenantCode) + immutable inputs — never the raw password (only its fingerprint). */
export function computeProvisioningInputsHash(
  input: ProvisioningRequestInput
): string {
  const passwordFingerprint = createHash("sha256")
    .update(input.owner.password)
    .digest("hex");
  return createHash("sha256")
    .update(
      JSON.stringify({
        planKey: input.planKey,
        planVersion: input.planVersion,
        tenantCode: input.tenantCode,
        tenantName: input.tenantName,
        legalName: input.legalName,
        ownerDisplayName: input.owner.displayName,
        ownerLoginIdentifier: input.owner.loginIdentifier,
        ownerPasswordFingerprint: passwordFingerprint,
        officeCode: input.officeCode,
        officeName: input.officeName,
        options: input.options
      })
    )
    .digest("hex");
}

function toInputs(input: ProvisioningRequestInput): ProvisioningInputs {
  return {
    tenantCode: input.tenantCode,
    tenantName: input.tenantName,
    options: {
      defaultLocale: input.options.defaultLocale,
      defaultTheme: input.options.defaultTheme,
      timezone: input.options.timezone,
      subdomain: input.options.subdomain,
      presetKey: input.options.presetKey,
      offerPlanKey: input.options.offerPlanKey,
      offerVersion: input.options.offerVersion
    }
  };
}

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

export type RequestProvisioningResult =
  | { ok: true; replayed: boolean; request: ProvisioningRequestDto }
  | {
      ok: false;
      reason: "validation";
      errors: { field: string; message: string }[];
    }
  | { ok: false; reason: "conflict"; message: string };

/**
 * Create a provisioning run. Runs inside the caller's transaction, which must
 * already have authorized the operator (in the operator's tenant context). This
 * function creates the target tenant (RLS-free), switches `app.current_tenant_id`
 * to it, and writes all tenant-scoped provisioning records under it.
 */
export async function requestProvisioning(
  tx: Bun.SQL,
  ctx: {
    actorTenantUserId: string | null;
    idempotencyKey: string;
    correlationId?: string;
  },
  input: ProvisioningRequestInput,
  deps: ProvisioningOnboardingDeps
): Promise<RequestProvisioningResult> {
  const errors = validateProvisioningRequest(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }
  const plan = getProvisioningPlan(input.planKey, input.planVersion)!;
  const inputsHash = computeProvisioningInputsHash(input);

  // ACID anti-duplicate: create the tenant (RLS-free). A concurrent request for
  // the same tenant_code blocks here on the unique index, then finds it taken.
  const { tenantId, created } = await deps.createTenantIfAbsent(tx, {
    tenantCode: input.tenantCode,
    tenantName: input.tenantName,
    legalName: input.legalName,
    defaultLocale: input.options.defaultLocale,
    createdBy: ctx.actorTenantUserId
  });

  // Every provisioning record for the target tenant is RLS-scoped to it. The id
  // is DB-generated (safe), but wrap with assertUuid for defense-in-depth,
  // consistent with `inTenantTx` (review L-4).
  await tx.unsafe(
    `SET LOCAL app.current_tenant_id = '${assertUuid(tenantId)}'`
  );

  if (!created) {
    // The tenant already exists. If a matching request (same idempotency key +
    // inputs hash) exists, REPLAY it (idempotent retry, incl. a concurrent
    // same-key winner); otherwise the target is taken by a different request.
    const existing = await findRequestRowByTenant(tx, tenantId);
    if (
      existing &&
      existing.idempotencyKey === ctx.idempotencyKey &&
      existing.inputsHash === inputsHash
    ) {
      const request = await findRequestByTenant(tx, tenantId);
      return { ok: true, replayed: true, request: request! };
    }
    return {
      ok: false,
      reason: "conflict",
      message: `A tenant with code "${input.tenantCode}" already exists.`
    };
  }

  await deps.initTenantSettings(tx, tenantId);
  const owner = await deps.createOwner(tx, tenantId, {
    ownerDisplayName: input.owner.displayName,
    ownerLoginIdentifier: input.owner.loginIdentifier,
    ownerPassword: input.owner.password,
    createdBy: ctx.actorTenantUserId
  });
  const office = await deps.createHeadOffice(tx, tenantId, {
    officeCode: input.officeCode,
    officeName: input.officeName,
    createdBy: ctx.actorTenantUserId
  });

  // Pre-completed checkpoints for the two request-time (secret-bearing) steps.
  const preCompleted: Record<string, Record<string, unknown>> = {
    [CORE_STEP_KEYS.tenantBootstrap]: { tenantId, officeId: office.officeId },
    [CORE_STEP_KEYS.ownerIdentity]: {
      ownerTenantUserId: owner.ownerTenantUserId,
      ownerRoleId: owner.ownerRoleId
    }
  };
  const materialized = planToMaterializeSteps(plan, preCompleted);
  const completedCount = materialized.filter(
    (s) => s.status === "completed"
  ).length;

  const requestRows = (await tx`
    INSERT INTO awcms_mini_tenant_provisioning_requests
      (tenant_id, plan_key, plan_version, target_key, status, readiness_state,
       inputs_hash, inputs, idempotency_key, correlation_id, total_steps,
       completed_steps, requested_by, created_by, updated_by)
    VALUES (
      ${tenantId}, ${plan.planKey}, ${plan.version}, ${input.tenantCode},
      'requested', 'pending', ${inputsHash}, ${toInputs(input)},
      ${ctx.idempotencyKey}, ${ctx.correlationId ?? null}, ${plan.steps.length},
      ${completedCount}, ${ctx.actorTenantUserId}, ${ctx.actorTenantUserId},
      ${ctx.actorTenantUserId}
    )
    RETURNING id
  `) as { id: string }[];
  const requestId = requestRows[0]!.id;

  await insertSteps(tx, tenantId, requestId, materialized);

  // Result references for the pre-completed steps (reconciliation/compensation).
  const stepRows = await listSteps(tx, requestId);
  for (const stepRow of stepRows) {
    if (stepRow.stepKey === CORE_STEP_KEYS.tenantBootstrap) {
      await insertResult(tx, tenantId, requestId, stepRow.id, stepRow.stepKey, {
        resultKind: "tenant_bootstrapped",
        resourceType: "tenant",
        resourceId: tenantId,
        output: { officeId: office.officeId },
        createdBy: ctx.actorTenantUserId
      });
    } else if (stepRow.stepKey === CORE_STEP_KEYS.ownerIdentity) {
      await insertResult(tx, tenantId, requestId, stepRow.id, stepRow.stepKey, {
        resultKind: "owner_created",
        resourceType: "tenant_user",
        resourceId: owner.ownerTenantUserId,
        output: { ownerRoleId: owner.ownerRoleId },
        createdBy: ctx.actorTenantUserId
      });
    }
  }

  await appendDomainEvent(tx, tenantId, {
    eventType: TENANT_PROVISIONING_REQUESTED_EVENT_TYPE,
    eventVersion: TENANT_PROVISIONING_EVENT_VERSION,
    aggregateType: "tenant_provisioning_request",
    aggregateId: requestId,
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      requestId,
      tenantId,
      planKey: plan.planKey,
      planVersion: plan.version,
      targetKey: input.tenantCode,
      totalSteps: plan.steps.length
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "tenant_provisioning_request",
    resourceId: requestId,
    severity: "warning",
    message: `Provisioning requested for tenant "${input.tenantCode}" (plan ${plan.planKey} v${plan.version}).`,
    attributes: {
      planKey: plan.planKey,
      planVersion: plan.version,
      targetKey: input.tenantCode
    },
    correlationId: ctx.correlationId
  });

  const request = await findRequestByTenant(tx, tenantId);
  return { ok: true, replayed: false, request: request! };
}

// ---------------------------------------------------------------------------
// start / resume / retry (one engine entry)
// ---------------------------------------------------------------------------

export type RunProvisioningResult =
  | { ok: true; request: ProvisioningRequestDto }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "lease_conflict" }
  | { ok: false; reason: "not_resumable"; status: string };

function resolveHandler(
  coreHandlers: Map<string, ProvisioningStepHandler>,
  stepKey: string
): ProvisioningStepHandler | null {
  return coreHandlers.get(stepKey) ?? getContributedProvisioningStep(stepKey);
}

async function buildStepContext(
  tx: Bun.SQL,
  tenantId: string,
  requestId: string,
  actorTenantUserId: string | null,
  inputs: ProvisioningInputs,
  correlationId?: string
): Promise<ProvisioningStepContext> {
  const resultsMap = await loadResultsMap(tx, requestId);
  const getResult = (stepKey: string): ProvisioningPriorResult | null => {
    const r = resultsMap.get(stepKey);
    return r
      ? {
          stepKey,
          resultKind: r.resultKind,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          output: r.output
        }
      : null;
  };
  return { tx, tenantId, actorTenantUserId, inputs, getResult, correlationId };
}

type StepLoopOutcome =
  "continue" | "waiting" | "failed" | "blocked" | "lease_lost";

/**
 * Start, resume, or retry a provisioning run. `inputs` is passed by the route
 * (the run's non-secret inputs — the owner password is NOT re-supplied and NOT
 * needed after request time).
 */
export async function runProvisioning(
  sql: Bun.SQL,
  tenantId: string,
  requestId: string,
  ctx: {
    actorTenantUserId: string | null;
    correlationId?: string;
    leaseOwner: string;
    leaseTtlMs?: number;
  },
  deps: ProvisioningEngineDeps
): Promise<RunProvisioningResult> {
  const coreHandlers = createCoreStepHandlers(deps.steps);
  const leaseTtl = ctx.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  // 1. Acquire the lease (row-lock + state-predicate) and load the run inputs.
  const leaseResult = await inTenantTx(sql, tenantId, async (tx) => {
    const req = await loadRequestForUpdate(tx, tenantId, requestId);
    if (!req) return { kind: "not_found" as const };
    if (
      req.status !== "requested" &&
      req.status !== "in_progress" &&
      req.status !== "failed" &&
      req.status !== "blocked"
    ) {
      return { kind: "not_resumable" as const, status: req.status };
    }
    // Refuse resume of a run that has any COMPENSATED step (review Med-B): those
    // steps were UNDONE (e.g. an entitlement really canceled), so a resume that
    // skipped them (they are not `pending`/`failed`/`waiting`) could reach
    // provisioned+active with an undone side effect. A compensated run is
    // terminal-for-resume; recovery is a fresh provisioning run (#873 lifecycle).
    if ((await countCompensatedSteps(tx, requestId)) > 0) {
      return { kind: "not_resumable" as const, status: "compensated" };
    }
    const acquired = await acquireLease(
      tx,
      requestId,
      ctx.leaseOwner,
      new Date(),
      leaseTtl
    );
    if (!acquired) return { kind: "lease_conflict" as const };
    const inputs = await loadInputs(tx, tenantId);
    return { kind: "acquired" as const, inputs: inputs! };
  });

  if (leaseResult.kind === "not_found")
    return { ok: false, reason: "not_found" };
  if (leaseResult.kind === "lease_conflict")
    return { ok: false, reason: "lease_conflict" };
  if (leaseResult.kind === "not_resumable")
    return { ok: false, reason: "not_resumable", status: leaseResult.status };

  const inputs = leaseResult.inputs;

  // 2. Run pending steps, each in its own transaction (durable checkpoints).
  let loopOutcome: StepLoopOutcome = "continue";
  const stepCtx = { ...ctx, leaseTtlMs: leaseTtl };
  // Bounded by total steps * (maxAttempts+2) so a stuck retry can never spin.
  for (let guard = 0; guard < 200; guard += 1) {
    const step = await inTenantTx(sql, tenantId, async (tx) => {
      const steps = await listSteps(tx, requestId);
      return (
        steps.find(
          (s) =>
            s.status === "pending" ||
            s.status === "failed" ||
            s.status === "waiting"
        ) ?? null
      );
    });
    if (!step) break; // all steps completed/skipped

    loopOutcome = await inTenantTx(sql, tenantId, async (tx) =>
      executeStepOnce(
        tx,
        tenantId,
        requestId,
        step.id,
        coreHandlers,
        inputs,
        stepCtx
      )
    );
    if (loopOutcome !== "continue") break;
  }

  // If this worker was fenced out (lost its lease mid-saga), do NOT release the
  // lease (a new owner may hold it) and NEVER finalize/activate — just report.
  if (loopOutcome === "lease_lost") {
    const request = await inTenantTx(sql, tenantId, (tx) =>
      findRequestByTenant(tx, tenantId)
    );
    return request ? { ok: true, request } : { ok: false, reason: "not_found" };
  }

  // 3. Finalize. Activation happens ONLY here (never inside a step handler),
  // gated on: this worker still owns a live lease, the run is still
  // `in_progress`, and every step genuinely completed/skipped (no compensated
  // step) — one coherent guard against activating a canceled/undone/zombie run.
  return inTenantTx(sql, tenantId, async (tx) => {
    const steps = await listSteps(tx, requestId);
    const allDone = steps.every(
      (s) => s.status === "completed" || s.status === "skipped"
    );
    const req = await loadRequestForUpdate(tx, tenantId, requestId);
    if (!req) {
      await releaseLease(tx, requestId, ctx.leaseOwner);
      return { ok: false, reason: "not_found" };
    }

    if (allDone && req.status === "in_progress") {
      // Lease-fenced + status-predicated provisioned transition: if this worker
      // lost the lease or the run left `in_progress` (e.g. canceled), this
      // affects 0 rows and the tenant is NEVER activated.
      const activated = await transitionRequest(
        tx,
        requestId,
        "in_progress",
        "provisioned",
        {
          readiness: "ready",
          currentStepKey: null,
          setProvisionedAt: true,
          updatedBy: ctx.actorTenantUserId,
          expectedLeaseOwner: ctx.leaseOwner
        }
      );
      if (!activated) {
        // Lost the fence — do not activate, do not release someone else's lease.
        const request = await findRequestByTenant(tx, tenantId);
        return { ok: true, request: request! };
      }
      // Tenant becomes active ONLY here, same-commit with the provisioned
      // transition (reuses tenant_admin `setTenantStatus`).
      await deps.steps.setTenantActive(tx, tenantId, ctx.actorTenantUserId);
      await appendDomainEvent(tx, tenantId, {
        eventType: TENANT_PROVISIONING_COMPLETED_EVENT_TYPE,
        eventVersion: TENANT_PROVISIONING_EVENT_VERSION,
        aggregateType: "tenant_provisioning_request",
        aggregateId: requestId,
        producerModule: MODULE_KEY,
        correlationId: ctx.correlationId,
        actorTenantUserId: ctx.actorTenantUserId,
        payload: { requestId, tenantId, status: "provisioned" }
      });
      await recordAuditEvent(tx, {
        tenantId,
        actorTenantUserId: ctx.actorTenantUserId ?? undefined,
        moduleKey: MODULE_KEY,
        action: "create",
        resourceType: "tenant_provisioning_request",
        resourceId: requestId,
        severity: "info",
        message: "Tenant provisioning completed; tenant is active.",
        correlationId: ctx.correlationId
      });
    }
    // Release OUR lease for every finalized path (provisioned/blocked/failed/
    // waiting). `releaseLease` predicates on our ownership → no-op if lost.
    await releaseLease(tx, requestId, ctx.leaseOwner);
    const request = await findRequestByTenant(tx, tenantId);
    return { ok: true, request: request! };
  });
}

/**
 * Execute the next runnable step ONCE, in the caller's transaction. Re-asserts
 * the lease as a fencing token first (M-1), enforces the bounded attempt budget
 * (Med-A), records the attempt, transitions the step + request under state
 * predicates, and — on a non-retryable failure — BLOCKS the run (completed steps
 * stay intact so a later retry resumes; compensation runs only on explicit
 * cancel, per the "provider failure -> retry/manual state, not rollback" AC).
 */
async function executeStepOnce(
  tx: Bun.SQL,
  tenantId: string,
  requestId: string,
  stepId: string,
  coreHandlers: Map<string, ProvisioningStepHandler>,
  inputs: ProvisioningInputs,
  ctx: {
    actorTenantUserId: string | null;
    correlationId?: string;
    leaseOwner: string;
    leaseTtlMs: number;
  }
): Promise<StepLoopOutcome> {
  // Fence + renew the lease inside this step's transaction (M-1). If this worker
  // no longer owns a live lease OR the run left `in_progress` (e.g. canceled
  // after the lease expired), ABORT before any step work — a zombie worker can
  // never complete a step / activate a tenant behind a canceled/expired run.
  const stillLeased = await fenceAndRenewLease(
    tx,
    requestId,
    ctx.leaseOwner,
    new Date(),
    ctx.leaseTtlMs
  );
  if (!stillLeased) return "lease_lost";

  const step = await loadStepForUpdate(tx, tenantId, stepId);
  if (
    !step ||
    (step.status !== "pending" &&
      step.status !== "failed" &&
      step.status !== "waiting")
  ) {
    return "continue"; // already handled (idempotent resume)
  }
  const stepKey = step.step_key;
  const maxAttempts = Number(step.max_attempts);
  const attemptStart = new Date();

  // Bounded attempt budget (Med-A): once a step has exhausted its budget
  // (attempt_count already at max_attempts + 1), never `beginStepRun` again —
  // that would violate the DB CHECK (attempt_count <= max_attempts + 1), throw
  // an UNHANDLED error, and leak the lease. Permanently block instead (clean).
  // The step is already `failed` with its last real attempt recorded; this is a
  // pure request-state transition (no phantom attempt row that would collide
  // with the existing (step_id, attempt_number) unique).
  if (Number(step.attempt_count) >= maxAttempts + 1) {
    await blockRun(tx, tenantId, requestId, stepKey, "permanent", ctx);
    return "blocked";
  }

  const attemptNumber = await beginStepRun(tx, stepId);
  if (attemptNumber === null) return "continue"; // lost race

  const handler = resolveHandler(coreHandlers, stepKey);
  if (!handler) {
    // Fail-closed: a step with no resolvable handler blocks the run.
    await recordAttempt(tx, {
      tenantId,
      requestId,
      stepId,
      stepKey,
      attemptNumber,
      outcome: "failed",
      errorClass: "dependency_missing",
      errorMessage: "no_registered_handler",
      correlationId: ctx.correlationId,
      startedAt: attemptStart,
      createdBy: ctx.actorTenantUserId
    });
    await failStep(tx, stepId, "dependency_missing", "no_registered_handler");
    await blockRun(tx, tenantId, requestId, stepKey, "dependency_missing", ctx);
    return "blocked";
  }

  const stepCtx = await buildStepContext(
    tx,
    tenantId,
    requestId,
    ctx.actorTenantUserId,
    inputs,
    ctx.correlationId
  );

  let exec: ProvisioningStepExecution;
  try {
    exec = await handler.execute(stepCtx);
  } catch (error) {
    const classified = classifyThrownError(error);
    exec = {
      outcome: "failed",
      errorClass: classified.errorClass,
      message: classified.message
    };
  }

  if (exec.outcome === "completed") {
    await insertResult(tx, tenantId, requestId, stepId, stepKey, {
      resultKind: exec.resultKind,
      resourceType: exec.resourceType ?? null,
      resourceId: exec.resourceId ?? null,
      output: exec.output ?? {},
      createdBy: ctx.actorTenantUserId
    });
    await completeStep(tx, stepId, {
      resultKind: exec.resultKind,
      ...(exec.output ?? {})
    });
    await recordAttempt(tx, {
      tenantId,
      requestId,
      stepId,
      stepKey,
      attemptNumber,
      outcome: "succeeded",
      correlationId: ctx.correlationId,
      startedAt: attemptStart,
      createdBy: ctx.actorTenantUserId
    });
    await transitionRequest(tx, requestId, "in_progress", "in_progress", {
      completedStepsDelta: 1,
      currentStepKey: stepKey,
      lastErrorClass: null,
      updatedBy: ctx.actorTenantUserId
    });
    return "continue";
  }

  if (exec.outcome === "skipped") {
    await skipStep(tx, stepId, exec.reason);
    await recordAttempt(tx, {
      tenantId,
      requestId,
      stepId,
      stepKey,
      attemptNumber,
      outcome: "skipped",
      correlationId: ctx.correlationId,
      startedAt: attemptStart,
      createdBy: ctx.actorTenantUserId
    });
    await transitionRequest(tx, requestId, "in_progress", "in_progress", {
      completedStepsDelta: 1,
      currentStepKey: stepKey,
      updatedBy: ctx.actorTenantUserId
    });
    return "continue";
  }

  if (exec.outcome === "waiting") {
    await markStepWaiting(tx, stepId);
    await recordAttempt(tx, {
      tenantId,
      requestId,
      stepId,
      stepKey,
      attemptNumber,
      outcome: "waiting",
      correlationId: ctx.correlationId,
      startedAt: attemptStart,
      createdBy: ctx.actorTenantUserId
    });
    return "waiting"; // provider async — the run pauses (event already dispatched by the handler)
  }

  // failed
  await recordAttempt(tx, {
    tenantId,
    requestId,
    stepId,
    stepKey,
    attemptNumber,
    outcome: "failed",
    errorClass: exec.errorClass,
    errorMessage: exec.message,
    correlationId: ctx.correlationId,
    startedAt: attemptStart,
    createdBy: ctx.actorTenantUserId
  });
  await failStep(tx, stepId, exec.errorClass, exec.message);

  if (shouldRetry(exec.errorClass, attemptNumber, maxAttempts)) {
    // Retryable within budget: leave the step failed; the loop re-runs it.
    return "continue";
  }

  // Non-retryable / budget exhausted: BLOCK the run (visible), leaving completed
  // steps INTACT so a later operator retry resumes correctly (no compensation on
  // failure — AC "optional provider failure yields retry/manual-intervention
  // state rather than transaction rollback of committed core state"). The tenant
  // stays inactive; compensation runs only on explicit cancel.
  await blockRun(tx, tenantId, requestId, stepKey, exec.errorClass, ctx);
  return "blocked";
}

async function blockRun(
  tx: Bun.SQL,
  tenantId: string,
  requestId: string,
  stepKey: string,
  errorClass: ProvisioningErrorClass,
  ctx: { actorTenantUserId: string | null; correlationId?: string }
): Promise<void> {
  await transitionRequest(tx, requestId, "in_progress", "blocked", {
    readiness: "blocked",
    currentStepKey: stepKey,
    lastErrorClass: errorClass,
    blockedReason: `step ${stepKey} failed (${errorClass})`,
    updatedBy: ctx.actorTenantUserId
  });
  await emitFailedEvent(tx, tenantId, requestId, "blocked", stepKey, ctx);
}

async function emitFailedEvent(
  tx: Bun.SQL,
  tenantId: string,
  requestId: string,
  status: "failed" | "blocked",
  stepKey: string,
  ctx: { actorTenantUserId: string | null; correlationId?: string }
): Promise<void> {
  await appendDomainEvent(tx, tenantId, {
    eventType: TENANT_PROVISIONING_FAILED_EVENT_TYPE,
    eventVersion: TENANT_PROVISIONING_EVENT_VERSION,
    aggregateType: "tenant_provisioning_request",
    aggregateId: requestId,
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: { requestId, tenantId, status, failedStepKey: stepKey }
  });
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "tenant_provisioning_request",
    resourceId: requestId,
    severity: "critical",
    message: `Provisioning ${status}; tenant left inactive (step ${stepKey}).`,
    attributes: { status, failedStepKey: stepKey },
    correlationId: ctx.correlationId
  });
}

// ---------------------------------------------------------------------------
// cancel (when safe)
// ---------------------------------------------------------------------------

export type CancelProvisioningResult =
  | { ok: true; request: ProvisioningRequestDto }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "lease_conflict" }
  | { ok: false; reason: "not_cancelable"; status: string };

/**
 * Cancel a run when safe: acquire the lease (so no worker is mid-step),
 * compensate completed steps by class, and mark the run canceled. Never deletes
 * tenant data; the tenant stays inactive.
 */
export async function cancelProvisioning(
  sql: Bun.SQL,
  tenantId: string,
  requestId: string,
  reason: string | null,
  ctx: {
    actorTenantUserId: string | null;
    correlationId?: string;
    leaseOwner: string;
  },
  deps: ProvisioningEngineDeps
): Promise<CancelProvisioningResult> {
  const coreHandlers = createCoreStepHandlers(deps.steps);
  return inTenantTx(sql, tenantId, async (tx) => {
    const req = await loadRequestForUpdate(tx, tenantId, requestId);
    if (!req) return { ok: false, reason: "not_found" };
    if (!isCancelableStatus(req.status)) {
      return { ok: false, reason: "not_cancelable", status: req.status };
    }
    // Take the lease so no concurrent worker is executing a step.
    if (
      req.leaseOwner &&
      req.leaseExpiresAt &&
      req.leaseExpiresAt >= new Date()
    ) {
      return { ok: false, reason: "lease_conflict" };
    }
    const inputs = (await loadInputs(tx, tenantId))!;
    // Move to compensating (from whatever cancelable state) via in_progress.
    const fromStatus = req.status;
    if (fromStatus !== "in_progress") {
      await transitionRequest(tx, requestId, fromStatus, "in_progress", {
        updatedBy: ctx.actorTenantUserId
      });
    }
    // Compensate completed steps (reverse, by class) — reuse the shared routine
    // but finalize to canceled instead of failed.
    await runCancelCompensation(
      tx,
      tenantId,
      requestId,
      coreHandlers,
      inputs,
      ctx
    );

    await transitionRequest(tx, requestId, "in_progress", "canceled", {
      readiness: "blocked",
      setCanceledAt: true,
      canceledBy: ctx.actorTenantUserId,
      cancelReason: reason,
      blockedReason: reason ?? "canceled by operator",
      updatedBy: ctx.actorTenantUserId
    });

    await appendDomainEvent(tx, tenantId, {
      eventType: TENANT_PROVISIONING_FAILED_EVENT_TYPE,
      eventVersion: TENANT_PROVISIONING_EVENT_VERSION,
      aggregateType: "tenant_provisioning_request",
      aggregateId: requestId,
      producerModule: MODULE_KEY,
      correlationId: ctx.correlationId,
      actorTenantUserId: ctx.actorTenantUserId,
      payload: { requestId, tenantId, status: "canceled" }
    });
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: ctx.actorTenantUserId ?? undefined,
      moduleKey: MODULE_KEY,
      action: "cancel",
      resourceType: "tenant_provisioning_request",
      resourceId: requestId,
      severity: "warning",
      message: "Tenant provisioning canceled (tenant data preserved).",
      attributes: { reason },
      correlationId: ctx.correlationId
    });

    const request = await findRequestByTenant(tx, tenantId);
    return { ok: true, request: request! };
  });
}

async function runCancelCompensation(
  tx: Bun.SQL,
  tenantId: string,
  requestId: string,
  coreHandlers: Map<string, ProvisioningStepHandler>,
  inputs: ProvisioningInputs,
  ctx: { actorTenantUserId: string | null; correlationId?: string }
): Promise<void> {
  const steps = await listSteps(tx, requestId);
  const completed = steps
    .filter((s) => s.status === "completed")
    .sort((a, b) => b.stepIndex - a.stepIndex);
  const stepCtx = await buildStepContext(
    tx,
    tenantId,
    requestId,
    ctx.actorTenantUserId,
    inputs,
    ctx.correlationId
  );
  for (const s of completed) {
    const action = compensationActionFor(s.compensationClass);
    if (action === "skip_forbidden") {
      await recordCompensation(tx, {
        tenantId,
        requestId,
        stepId: s.id,
        stepKey: s.stepKey,
        compensationClass: s.compensationClass,
        status: "skipped_forbidden",
        action: "skip_forbidden",
        note: "compensation forbidden (never delete tenant data)",
        createdBy: ctx.actorTenantUserId
      });
      continue;
    }
    if (action === "mark_manual") {
      await recordCompensation(tx, {
        tenantId,
        requestId,
        stepId: s.id,
        stepKey: s.stepKey,
        compensationClass: s.compensationClass,
        status: "manual_required",
        action: "mark_manual",
        note: "manual operator intervention required",
        createdBy: ctx.actorTenantUserId
      });
      continue;
    }
    const handler = resolveHandler(coreHandlers, s.stepKey);
    let status: "completed" | "failed" = "completed";
    let note: string | null = null;
    if (handler?.compensate) {
      try {
        const outcome = await handler.compensate(stepCtx);
        if (outcome.outcome === "failed") {
          status = "failed";
          note = outcome.message.slice(0, 2000);
        } else if (outcome.outcome === "manual_required") {
          await recordCompensation(tx, {
            tenantId,
            requestId,
            stepId: s.id,
            stepKey: s.stepKey,
            compensationClass: s.compensationClass,
            status: "manual_required",
            action: "run_compensation",
            note: outcome.note.slice(0, 2000),
            createdBy: ctx.actorTenantUserId
          });
          continue;
        } else {
          note = outcome.note ?? null;
        }
      } catch (error) {
        status = "failed";
        note = classifyThrownError(error).message;
      }
    }
    await recordCompensation(tx, {
      tenantId,
      requestId,
      stepId: s.id,
      stepKey: s.stepKey,
      compensationClass: s.compensationClass,
      status,
      action: "run_compensation",
      note,
      createdBy: ctx.actorTenantUserId
    });
    // Transition the step itself out of `completed` -> `compensated` (review
    // Med-B) so the timeline records it was UNDONE and a later reconcile/read
    // never reports a compensated step as a false `completed`. Only on a clean
    // reversible undo (a failed undo leaves the step completed for operator
    // review). Forbidden/manual steps are not undone → they stay completed.
    if (status === "completed") {
      await markStepCompensated(tx, s.id);
    }
  }
}

// ---------------------------------------------------------------------------
// reconcile (non-destructive desired-vs-actual)
// ---------------------------------------------------------------------------

export type ReconcileProvisioningResult =
  | {
      ok: true;
      status: "consistent" | "drift_detected" | "error";
      drift: unknown[];
      request: ProvisioningRequestDto;
    }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_reconcilable"; status: string };

/**
 * Non-destructive reconciliation: compare the plan's DESIRED steps against the
 * ACTUAL recorded step/result state and report drift with SAFE operator actions
 * — NEVER an auto-fix (ADR-0022 §9, AC). Runs only on a provisioned run.
 */
export async function reconcileProvisioning(
  sql: Bun.SQL,
  tenantId: string,
  requestId: string,
  ctx: { actorTenantUserId: string | null; correlationId?: string }
): Promise<ReconcileProvisioningResult> {
  return inTenantTx(sql, tenantId, async (tx) => {
    const req = await loadRequestForUpdate(tx, tenantId, requestId);
    if (!req) return { ok: false, reason: "not_found" };
    if (req.status !== "provisioned") {
      return { ok: false, reason: "not_reconcilable", status: req.status };
    }
    const requestDto = await findRequestByTenant(tx, tenantId);
    const plan = getProvisioningPlan(
      requestDto!.planKey,
      requestDto!.planVersion
    );
    const steps = await listSteps(tx, requestId);
    const resultsMap = await loadResultsMap(tx, requestId);

    const drift: {
      stepKey: string;
      expected: string;
      actual: string;
      safeActions: string[];
    }[] = [];

    // DESIRED: every non-optional plan step must be completed; optional steps
    // may be skipped. ACTUAL: the step's recorded status/result.
    for (const def of plan?.steps ?? []) {
      const step = steps.find((s) => s.stepKey === def.stepKey);
      if (!step) {
        drift.push({
          stepKey: def.stepKey,
          expected: "materialized",
          actual: "missing",
          safeActions: ["retry_provisioning"]
        });
        continue;
      }
      const ok =
        step.status === "completed" ||
        (def.optional && step.status === "skipped");
      if (!ok) {
        drift.push({
          stepKey: def.stepKey,
          expected: def.optional ? "completed_or_skipped" : "completed",
          actual: step.status,
          safeActions: ["retry_provisioning", "review_step"]
        });
      }
      // A completed non-optional step that produced no result reference is drift.
      if (
        step.status === "completed" &&
        !def.optional &&
        def.stepKey !== CORE_STEP_KEYS.readinessCheck &&
        def.stepKey !== CORE_STEP_KEYS.defaultConfiguration &&
        !resultsMap.has(def.stepKey)
      ) {
        drift.push({
          stepKey: def.stepKey,
          expected: "result_recorded",
          actual: "no_result",
          safeActions: ["review_step"]
        });
      }
    }

    const status = drift.length === 0 ? "consistent" : "drift_detected";

    // Transition provisioned -> reconciling -> provisioned (records the pass).
    await transitionRequest(tx, requestId, "provisioned", "reconciling", {
      updatedBy: ctx.actorTenantUserId
    });
    await recordReconciliation(tx, {
      tenantId,
      requestId,
      status,
      drift,
      correlationId: ctx.correlationId,
      checkedBy: ctx.actorTenantUserId
    });
    await transitionRequest(tx, requestId, "reconciling", "provisioned", {
      setLastReconciledAt: true,
      updatedBy: ctx.actorTenantUserId
    });

    await appendDomainEvent(tx, tenantId, {
      eventType: TENANT_PROVISIONING_RECONCILED_EVENT_TYPE,
      eventVersion: TENANT_PROVISIONING_EVENT_VERSION,
      aggregateType: "tenant_provisioning_request",
      aggregateId: requestId,
      producerModule: MODULE_KEY,
      correlationId: ctx.correlationId,
      actorTenantUserId: ctx.actorTenantUserId,
      payload: { requestId, tenantId, status, driftCount: drift.length }
    });
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: ctx.actorTenantUserId ?? undefined,
      moduleKey: MODULE_KEY,
      action: "check",
      resourceType: "tenant_provisioning_request",
      resourceId: requestId,
      severity: status === "drift_detected" ? "warning" : "info",
      message: `Reconciliation ${status} (${drift.length} drift item(s)); no auto-fix applied.`,
      attributes: { status, driftCount: drift.length },
      correlationId: ctx.correlationId
    });

    const request = await findRequestByTenant(tx, tenantId);
    return { ok: true, status, drift, request: request! };
  });
}

export type { ProvisioningInputs };
export { toInputs };
export { toRequestDto };
