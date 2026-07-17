/**
 * SoD conflict exception service (Issue #746, epic #738 platform-evolution
 * Wave 2). Persistence + audit wrapper around `domain/sod-conflict-
 * evaluation.ts`'s pure rules, same "not-found/invalid-state is a
 * discriminated union, never a thrown error" convention `data-lifecycle/
 * application/legal-hold-service.ts` documents. Column lists are spelled
 * out per-query (not composed via `tx.unsafe()` inside a tagged template —
 * that method builds a whole raw SQL STRING, it does not compose as an
 * interpolated fragment inside `` tx`...` ``), same convention that file's
 * own header documents.
 *
 * Approve requires a DIFFERENT approver than the requester — re-checked
 * from the DB row itself (never trusted from the request body), same
 * "re-check from DB, don't trust body" idiom `tenant-auth-policy.ts`'s
 * break-glass evaluation documents for its own self-referential guard.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { recordCounter } from "../../../lib/observability/metrics-port";
import type { SoDRuleDescriptor } from "../../_shared/module-contract";
import {
  isSoDConflictExceptionCurrentlyValid,
  validateCreateSoDConflictExceptionInput,
  validateRevokeSoDConflictExceptionInput,
  type CreateSoDConflictExceptionInput,
  type RequestedScope,
  type RevokeSoDConflictExceptionInput,
  type SoDConflictExceptionValidationError
} from "../domain/sod-conflict-evaluation";

const IDENTITY_ACCESS_MODULE_KEY = "identity_access";

export type SoDConflictExceptionRow = {
  id: string;
  tenantId: string;
  ruleKey: string;
  subjectTenantUserId: string;
  scopeType: string | null;
  scopeId: string | null;
  justification: string;
  requestedByTenantUserId: string;
  approvedByTenantUserId: string | null;
  status: "pending" | "approved" | "rejected" | "expired" | "revoked";
  effectiveFrom: Date;
  effectiveTo: Date;
  createdAt: Date;
  updatedAt: Date;
};

type SoDConflictExceptionDbRow = {
  id: string;
  tenant_id: string;
  rule_key: string;
  subject_tenant_user_id: string;
  scope_type: string | null;
  scope_id: string | null;
  justification: string;
  requested_by_tenant_user_id: string;
  approved_by_tenant_user_id: string | null;
  status: SoDConflictExceptionRow["status"];
  effective_from: Date;
  effective_to: Date;
  created_at: Date;
  updated_at: Date;
};

function toRow(row: SoDConflictExceptionDbRow): SoDConflictExceptionRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ruleKey: row.rule_key,
    subjectTenantUserId: row.subject_tenant_user_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    justification: row.justification,
    requestedByTenantUserId: row.requested_by_tenant_user_id,
    approvedByTenantUserId: row.approved_by_tenant_user_id,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export type CreateSoDConflictExceptionResult =
  | { ok: true; exception: SoDConflictExceptionRow }
  | {
      ok: false;
      reason: "validation";
      errors: SoDConflictExceptionValidationError[];
    }
  | { ok: false; reason: "rule_not_found" }
  | { ok: false; reason: "exception_not_allowed" }
  | { ok: false; reason: "exceeds_max_duration"; maxDurationDays: number };

export async function createSoDConflictException(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  subjectTenantUserId: string,
  input: CreateSoDConflictExceptionInput,
  rules: readonly SoDRuleDescriptor[],
  correlationId?: string
): Promise<CreateSoDConflictExceptionResult> {
  const errors = validateCreateSoDConflictExceptionInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const rule = rules.find((candidate) => candidate.ruleKey === input.ruleKey);
  if (!rule) {
    return { ok: false, reason: "rule_not_found" };
  }
  if (!rule.exceptionPolicy.allowed) {
    return { ok: false, reason: "exception_not_allowed" };
  }

  const maxDurationDays = rule.exceptionPolicy.maxDurationDays;
  if (typeof maxDurationDays === "number") {
    const durationDays =
      (input.effectiveTo.getTime() - input.effectiveFrom.getTime()) /
      (24 * 60 * 60 * 1000);
    if (durationDays > maxDurationDays) {
      return { ok: false, reason: "exceeds_max_duration", maxDurationDays };
    }
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_sod_conflict_exceptions
      (tenant_id, rule_key, subject_tenant_user_id, scope_type, scope_id, justification,
       requested_by_tenant_user_id, status, effective_from, effective_to)
    VALUES (
      ${tenantId}, ${input.ruleKey}, ${subjectTenantUserId}, ${input.scopeType}, ${input.scopeId},
      ${input.justification}, ${actorTenantUserId}, 'pending', ${input.effectiveFrom}, ${input.effectiveTo}
    )
    RETURNING id, tenant_id, rule_key, subject_tenant_user_id, scope_type, scope_id,
      justification, requested_by_tenant_user_id, approved_by_tenant_user_id, status,
      effective_from, effective_to, created_at, updated_at
  `) as SoDConflictExceptionDbRow[];

  const exception = toRow(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: IDENTITY_ACCESS_MODULE_KEY,
    action: "create",
    resourceType: "sod_conflict_exception",
    resourceId: exception.id,
    severity: "warning",
    message: `SoD conflict exception requested for rule "${exception.ruleKey}".`,
    attributes: {
      ruleKey: exception.ruleKey,
      subjectTenantUserId: exception.subjectTenantUserId,
      scopeType: exception.scopeType
    },
    correlationId
  });

  return { ok: true, exception };
}

export type DecideSoDConflictExceptionResult =
  | { ok: true; exception: SoDConflictExceptionRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_state" }
  | { ok: false; reason: "self_approval_denied" };

/**
 * Approve — requires a DIFFERENT tenant user than the one who requested it.
 * `requestedByTenantUserId` is re-read from the fetched ROW, never trusted
 * from a caller-supplied value, so a forged request body cannot spoof its
 * way past the self-approval guard.
 */
export async function approveSoDConflictException(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  exceptionId: string,
  decisionReason: string | null,
  correlationId?: string
): Promise<DecideSoDConflictExceptionResult> {
  const existingRows = (await tx`
    SELECT id, tenant_id, rule_key, subject_tenant_user_id, scope_type, scope_id,
      justification, requested_by_tenant_user_id, approved_by_tenant_user_id, status,
      effective_from, effective_to, created_at, updated_at
    FROM awcms_mini_sod_conflict_exceptions
    WHERE tenant_id = ${tenantId} AND id = ${exceptionId}
  `) as SoDConflictExceptionDbRow[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status !== "pending") {
    return { ok: false, reason: "invalid_state" };
  }
  if (existing.requested_by_tenant_user_id === actorTenantUserId) {
    return { ok: false, reason: "self_approval_denied" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_sod_conflict_exceptions
    SET status = 'approved', approved_by_tenant_user_id = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${exceptionId} AND status = 'pending'
    RETURNING id, tenant_id, rule_key, subject_tenant_user_id, scope_type, scope_id,
      justification, requested_by_tenant_user_id, approved_by_tenant_user_id, status,
      effective_from, effective_to, created_at, updated_at
  `) as SoDConflictExceptionDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "invalid_state" };
  }

  const exception = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: IDENTITY_ACCESS_MODULE_KEY,
    action: "approve",
    resourceType: "sod_conflict_exception",
    resourceId: exception.id,
    severity: "critical",
    message: `SoD conflict exception approved for rule "${exception.ruleKey}".`,
    attributes: {
      ruleKey: exception.ruleKey,
      subjectTenantUserId: exception.subjectTenantUserId,
      decisionReason
    },
    correlationId
  });

  recordCounter("sod_exceptions_granted_total", { ruleKey: exception.ruleKey });

  return { ok: true, exception };
}

export async function rejectSoDConflictException(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  exceptionId: string,
  decisionReason: string | null,
  correlationId?: string
): Promise<DecideSoDConflictExceptionResult> {
  const rows = (await tx`
    UPDATE awcms_mini_sod_conflict_exceptions
    SET status = 'rejected', updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${exceptionId} AND status = 'pending'
    RETURNING id, tenant_id, rule_key, subject_tenant_user_id, scope_type, scope_id,
      justification, requested_by_tenant_user_id, approved_by_tenant_user_id, status,
      effective_from, effective_to, created_at, updated_at
  `) as SoDConflictExceptionDbRow[];

  if (!rows[0]) {
    const existingRows = (await tx`
      SELECT id FROM awcms_mini_sod_conflict_exceptions
      WHERE tenant_id = ${tenantId} AND id = ${exceptionId}
    `) as { id: string }[];
    return {
      ok: false,
      reason: existingRows[0] ? "invalid_state" : "not_found"
    };
  }

  const exception = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: IDENTITY_ACCESS_MODULE_KEY,
    action: "reject",
    resourceType: "sod_conflict_exception",
    resourceId: exception.id,
    severity: "warning",
    message: `SoD conflict exception rejected for rule "${exception.ruleKey}".`,
    attributes: { ruleKey: exception.ruleKey, decisionReason },
    correlationId
  });

  return { ok: true, exception };
}

export type RevokeSoDConflictExceptionResult =
  | { ok: true; exception: SoDConflictExceptionRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_state" }
  | {
      ok: false;
      reason: "validation";
      errors: SoDConflictExceptionValidationError[];
    };

export async function revokeSoDConflictException(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  exceptionId: string,
  input: RevokeSoDConflictExceptionInput,
  correlationId?: string
): Promise<RevokeSoDConflictExceptionResult> {
  const errors = validateRevokeSoDConflictExceptionInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const rows = (await tx`
    UPDATE awcms_mini_sod_conflict_exceptions
    SET status = 'revoked', updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${exceptionId} AND status = 'approved'
    RETURNING id, tenant_id, rule_key, subject_tenant_user_id, scope_type, scope_id,
      justification, requested_by_tenant_user_id, approved_by_tenant_user_id, status,
      effective_from, effective_to, created_at, updated_at
  `) as SoDConflictExceptionDbRow[];

  if (!rows[0]) {
    const existingRows = (await tx`
      SELECT id FROM awcms_mini_sod_conflict_exceptions
      WHERE tenant_id = ${tenantId} AND id = ${exceptionId}
    `) as { id: string }[];
    return {
      ok: false,
      reason: existingRows[0] ? "invalid_state" : "not_found"
    };
  }

  const exception = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: IDENTITY_ACCESS_MODULE_KEY,
    action: "revoke",
    resourceType: "sod_conflict_exception",
    resourceId: exception.id,
    severity: "critical",
    message: `SoD conflict exception revoked for rule "${exception.ruleKey}".`,
    attributes: {
      ruleKey: exception.ruleKey,
      revokeReason: input.revokeReason
    },
    correlationId
  });

  return { ok: true, exception };
}

export type ListSoDConflictExceptionsFilter = {
  status?: SoDConflictExceptionRow["status"];
  ruleKey?: string;
};

/** `LIMIT 200`, newest first — bounded-list convention (`legal-hold-service.ts`'s `listLegalHolds`). */
export async function listSoDConflictExceptions(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListSoDConflictExceptionsFilter = {}
): Promise<SoDConflictExceptionRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, rule_key, subject_tenant_user_id, scope_type, scope_id,
      justification, requested_by_tenant_user_id, approved_by_tenant_user_id, status,
      effective_from, effective_to, created_at, updated_at
    FROM awcms_mini_sod_conflict_exceptions
    WHERE tenant_id = ${tenantId}
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
      AND (${filter.ruleKey ?? null}::text IS NULL OR rule_key = ${filter.ruleKey ?? null})
    ORDER BY created_at DESC
    LIMIT 200
  `) as SoDConflictExceptionDbRow[];

  return rows.map(toRow);
}

/**
 * The valid, currently-in-force approved exception (if any) per rule key,
 * for MANY rule keys in ONE query (Issue #833, epic #818).
 * `business-scope-assignment-service.ts` used to call the single-key
 * `findValidSoDConflictException` below once PER DETECTED MATCH — an N+1
 * round trip inside the assignment transaction, on a latency path an admin
 * waits on. Keys are deduplicated here, so a rule matched by several of the
 * role's permission keys still costs one row lookup, and an empty key list
 * costs no query at all.
 *
 * `Map` semantics are identical to calling the single-key function per key:
 * a key absent from the returned map means "no valid exception on file",
 * which the caller must treat exactly like the previous `null`.
 */
export async function findValidSoDConflictExceptionsByRuleKeys(
  tx: Bun.SQL,
  tenantId: string,
  ruleKeys: readonly string[],
  subjectTenantUserId: string,
  now: Date,
  requestedScope: RequestedScope | null
): Promise<Map<string, SoDConflictExceptionRow>> {
  const validByRuleKey = new Map<string, SoDConflictExceptionRow>();

  const distinctRuleKeys = [...new Set(ruleKeys)];
  if (distinctRuleKeys.length === 0) {
    return validByRuleKey;
  }

  const rows = (await tx`
    SELECT id, tenant_id, rule_key, subject_tenant_user_id, scope_type, scope_id,
      justification, requested_by_tenant_user_id, approved_by_tenant_user_id, status,
      effective_from, effective_to, created_at, updated_at
    FROM awcms_mini_sod_conflict_exceptions
    WHERE tenant_id = ${tenantId}
      AND rule_key = ANY(${tx.array(distinctRuleKeys, "text")})
      AND subject_tenant_user_id = ${subjectTenantUserId} AND status = 'approved'
      AND (
        (scope_type IS NULL AND scope_id IS NULL)
        OR (
          ${requestedScope?.scopeType ?? null}::text IS NOT NULL
          AND scope_type = ${requestedScope?.scopeType ?? null}
          AND scope_id = ${requestedScope?.scopeId ?? null}
        )
      )
  `) as SoDConflictExceptionDbRow[];

  for (const row of rows) {
    // First VALID row per rule key wins — the same "return the first row
    // that passes `isSoDConflictExceptionCurrentlyValid`" rule the
    // single-key path has always applied (neither path orders rows; the
    // caller only ever consumes presence/absence, never a row's identity).
    if (validByRuleKey.has(row.rule_key)) {
      continue;
    }

    const exception = toRow(row);
    if (
      isSoDConflictExceptionCurrentlyValid(
        {
          status: exception.status,
          effectiveFrom: exception.effectiveFrom,
          effectiveTo: exception.effectiveTo,
          scopeType: exception.scopeType,
          scopeId: exception.scopeId
        },
        now,
        requestedScope
      )
    ) {
      validByRuleKey.set(exception.ruleKey, exception);
    }
  }

  return validByRuleKey;
}

/**
 * The single valid, currently-in-force approved exception (if any) for
 * `(ruleKey, subjectTenantUserId)` covering `requestedScope` — used by
 * `access-guard.ts`'s chokepoint (`high_risk_decision` trigger), which only
 * ever evaluates ONE permission key per request. Delegates to the batch
 * function above so both paths share one SQL statement and one validity
 * rule ("status is a cache, effective_to vs now() is the real gate",
 * `isSoDConflictExceptionCurrentlyValid`) — there is no second copy to
 * drift.
 */
export async function findValidSoDConflictException(
  tx: Bun.SQL,
  tenantId: string,
  ruleKey: string,
  subjectTenantUserId: string,
  now: Date,
  requestedScope: RequestedScope | null
): Promise<SoDConflictExceptionRow | null> {
  const validByRuleKey = await findValidSoDConflictExceptionsByRuleKeys(
    tx,
    tenantId,
    [ruleKey],
    subjectTenantUserId,
    now,
    requestedScope
  );

  return validByRuleKey.get(ruleKey) ?? null;
}
