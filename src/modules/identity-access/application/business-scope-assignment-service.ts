/**
 * Business-scope assignment service (Issue #746, epic #738
 * platform-evolution Wave 2). Persistence + audit + SoD-conflict-evaluation
 * wrapper around `domain/business-scope-assignment.ts`'s pure rules, same
 * "not-found/invalid-state is a discriminated union, never a thrown error"
 * convention `data-lifecycle/application/legal-hold-service.ts` documents.
 *
 * CREATE validates the scope through `BusinessScopeHierarchyPort` (never
 * trusts `scopeType`/`scopeId` from the request alone — issue #746 security
 * requirement), denies self-grant (grantor === subject), and evaluates SoD
 * conflicts against the subject's OTHER active assignments — recording an
 * append-only decision to `awcms_mini_sod_conflict_evaluations` regardless
 * of outcome.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { recordCounter } from "../../../lib/observability/metrics-port";
import type { SoDRuleDescriptor } from "../../_shared/module-contract";
import type { BusinessScopeHierarchyPort } from "../../_shared/ports/business-scope-hierarchy-port";
import {
  validateCreateBusinessScopeAssignmentInput,
  validateRevokeBusinessScopeAssignmentInput,
  type CreateBusinessScopeAssignmentInput,
  type BusinessScopeAssignmentValidationError,
  type RevokeBusinessScopeAssignmentInput
} from "../domain/business-scope-assignment";
import { detectSoDConflicts } from "../domain/sod-conflict-evaluation";
import {
  resolveRolePermissionKeys,
  resolveSoDAssignmentFacts
} from "./business-scope-facts";
import { recordSoDConflictEvaluation } from "./sod-conflict-evaluation-log";
import { findValidSoDConflictException } from "./sod-exception-service";

const IDENTITY_ACCESS_MODULE_KEY = "identity_access";

export type BusinessScopeAssignmentRow = {
  id: string;
  tenantId: string;
  tenantUserId: string;
  roleId: string | null;
  scopeType: string;
  scopeId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isTemporary: boolean;
  reason: string | null;
  grantedByTenantUserId: string;
  approvedByTenantUserId: string | null;
  status: "active" | "expired" | "revoked";
  revokedAt: Date | null;
  revokedByTenantUserId: string | null;
  revokeReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type BusinessScopeAssignmentDbRow = {
  id: string;
  tenant_id: string;
  tenant_user_id: string;
  role_id: string | null;
  scope_type: string;
  scope_id: string;
  effective_from: Date;
  effective_to: Date | null;
  is_temporary: boolean;
  reason: string | null;
  granted_by_tenant_user_id: string;
  approved_by_tenant_user_id: string | null;
  status: BusinessScopeAssignmentRow["status"];
  revoked_at: Date | null;
  revoked_by_tenant_user_id: string | null;
  revoke_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

function toRow(row: BusinessScopeAssignmentDbRow): BusinessScopeAssignmentRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantUserId: row.tenant_user_id,
    roleId: row.role_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    isTemporary: row.is_temporary,
    reason: row.reason,
    grantedByTenantUserId: row.granted_by_tenant_user_id,
    approvedByTenantUserId: row.approved_by_tenant_user_id,
    status: row.status,
    revokedAt: row.revoked_at,
    revokedByTenantUserId: row.revoked_by_tenant_user_id,
    revokeReason: row.revoke_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export type SoDConflictSummary = {
  ruleKey: string;
  severity: string;
  conflictingPermissionKey: string;
  indeterminate: boolean;
};

export type CreateBusinessScopeAssignmentResult =
  | { ok: true; assignment: BusinessScopeAssignmentRow }
  | {
      ok: false;
      reason: "validation";
      errors: BusinessScopeAssignmentValidationError[];
    }
  | { ok: false; reason: "scope_unresolved" }
  | { ok: false; reason: "self_grant_denied" }
  | { ok: false; reason: "sod_conflict"; conflicts: SoDConflictSummary[] };

export async function createBusinessScopeAssignment(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateBusinessScopeAssignmentInput,
  deps: {
    hierarchyPort: BusinessScopeHierarchyPort;
    sodRules: readonly SoDRuleDescriptor[];
  },
  now: Date,
  correlationId?: string
): Promise<CreateBusinessScopeAssignmentResult> {
  const errors = validateCreateBusinessScopeAssignmentInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  // "Scope identifiers are validated through the owning capability and
  // cannot be trusted from request input alone" (issue #746 security
  // requirement).
  const resolution = await deps.hierarchyPort.resolveScope(
    tx,
    tenantId,
    input.scopeType,
    input.scopeId
  );
  if (!resolution.resolved) {
    // Best-effort operational signal — `resolved: false` conflates "unknown
    // scope type", "scope id does not exist", and "scope belongs to a
    // different tenant" (the hierarchy port's own contract does not
    // distinguish these to avoid leaking cross-tenant existence via a
    // separate check), so this counter is a proxy for all three, not a
    // precise cross-tenant-only signal — documented here, not overstated
    // in the metric's own definition.
    recordCounter("business_scope_cross_tenant_denied_total");
    return { ok: false, reason: "scope_unresolved" };
  }

  // Self-grant denial — granting yourself a business-scope assignment is
  // always denied, not conditioned on a finer "is this specific grant
  // high-risk" test (issue #746: "Self-grant/self-approval for high-risk
  // assignment or SoD exception is denied" — a scope assignment that
  // narrows/extends the subject's own effective access is treated as
  // high-risk by construction here).
  if (actorTenantUserId === input.tenantUserId) {
    return { ok: false, reason: "self_grant_denied" };
  }

  const requestedScope = { scopeType: input.scopeType, scopeId: input.scopeId };
  const conflicts: SoDConflictSummary[] = [];

  if (input.roleId) {
    const [requestedPermissionKeys, subjectFacts] = await Promise.all([
      resolveRolePermissionKeys(tx, tenantId, input.roleId),
      resolveSoDAssignmentFacts(tx, tenantId, input.tenantUserId, now, null)
    ]);

    for (const permissionKey of requestedPermissionKeys) {
      const matches = detectSoDConflicts(
        deps.sodRules,
        permissionKey,
        requestedScope,
        subjectFacts
      );

      for (const match of matches) {
        const exception = match.indeterminate
          ? null
          : await findValidSoDConflictException(
              tx,
              tenantId,
              match.rule.ruleKey,
              input.tenantUserId,
              now,
              requestedScope
            );

        const resolvedVia = match.indeterminate
          ? "denied"
          : exception
            ? "exception"
            : "denied";

        await recordSoDConflictEvaluation(tx, tenantId, {
          ruleKey: match.rule.ruleKey,
          subjectTenantUserId: input.tenantUserId,
          triggerContext: "assignment_create",
          conflictDetected: true,
          resolvedVia,
          decisionReason: match.indeterminate
            ? `Conflict with "${match.conflictingPermissionKey}" could not be scope-resolved for a same-scope-only rule.`
            : exception
              ? `Conflict with "${match.conflictingPermissionKey}" covered by an approved exception.`
              : `Conflict with "${match.conflictingPermissionKey}" — no approved exception on file.`,
          metadata: { requestedPermissionKey: permissionKey }
        });

        recordCounter("sod_conflicts_detected_total", {
          ruleKey: match.rule.ruleKey,
          resolvedVia
        });

        if (resolvedVia === "denied") {
          conflicts.push({
            ruleKey: match.rule.ruleKey,
            severity: match.rule.severity,
            conflictingPermissionKey: match.conflictingPermissionKey,
            indeterminate: match.indeterminate
          });
        }
      }
    }
  }

  if (conflicts.length > 0) {
    return { ok: false, reason: "sod_conflict", conflicts };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_business_scope_assignments
      (tenant_id, tenant_user_id, role_id, scope_type, scope_id, effective_from, effective_to,
       is_temporary, reason, granted_by_tenant_user_id, status)
    VALUES (
      ${tenantId}, ${input.tenantUserId}, ${input.roleId}, ${input.scopeType}, ${input.scopeId},
      ${input.effectiveFrom}, ${input.effectiveTo}, ${input.isTemporary}, ${input.reason},
      ${actorTenantUserId}, 'active'
    )
    RETURNING id, tenant_id, tenant_user_id, role_id, scope_type, scope_id, effective_from,
      effective_to, is_temporary, reason, granted_by_tenant_user_id, approved_by_tenant_user_id,
      status, revoked_at, revoked_by_tenant_user_id, revoke_reason, created_at, updated_at
  `) as BusinessScopeAssignmentDbRow[];

  const assignment = toRow(rows[0]!);

  await tx`
    INSERT INTO awcms_mini_business_scope_assignment_events
      (tenant_id, assignment_id, event_type, actor_tenant_user_id, reason)
    VALUES (${tenantId}, ${assignment.id}, 'granted', ${actorTenantUserId}, ${input.reason})
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: IDENTITY_ACCESS_MODULE_KEY,
    action: "create",
    resourceType: "business_scope_assignment",
    resourceId: assignment.id,
    severity: "warning",
    message: `Business-scope assignment granted for subject to scope "${assignment.scopeType}".`,
    attributes: {
      tenantUserId: assignment.tenantUserId,
      scopeType: assignment.scopeType,
      isTemporary: assignment.isTemporary
    },
    correlationId
  });

  return { ok: true, assignment };
}

export type RevokeBusinessScopeAssignmentResult =
  | { ok: true; assignment: BusinessScopeAssignmentRow }
  | {
      ok: false;
      reason: "validation";
      errors: BusinessScopeAssignmentValidationError[];
    }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_revoked" };

export async function revokeBusinessScopeAssignment(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  assignmentId: string,
  input: RevokeBusinessScopeAssignmentInput,
  correlationId?: string
): Promise<RevokeBusinessScopeAssignmentResult> {
  const errors = validateRevokeBusinessScopeAssignmentInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existingRows = (await tx`
    SELECT id, status FROM awcms_mini_business_scope_assignments
    WHERE tenant_id = ${tenantId} AND id = ${assignmentId}
  `) as { id: string; status: string }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status !== "active") {
    return { ok: false, reason: "already_revoked" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_business_scope_assignments
    SET status = 'revoked', revoked_at = now(), revoked_by_tenant_user_id = ${actorTenantUserId},
        revoke_reason = ${input.revokeReason}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${assignmentId} AND status = 'active'
    RETURNING id, tenant_id, tenant_user_id, role_id, scope_type, scope_id, effective_from,
      effective_to, is_temporary, reason, granted_by_tenant_user_id, approved_by_tenant_user_id,
      status, revoked_at, revoked_by_tenant_user_id, revoke_reason, created_at, updated_at
  `) as BusinessScopeAssignmentDbRow[];

  if (!rows[0]) {
    // Lost a race against a concurrent revoke between the SELECT and
    // UPDATE above — same convention `legal-hold-service.ts`'s
    // `releaseLegalHold` documents for its own equivalent race.
    return { ok: false, reason: "already_revoked" };
  }

  const assignment = toRow(rows[0]);

  await tx`
    INSERT INTO awcms_mini_business_scope_assignment_events
      (tenant_id, assignment_id, event_type, actor_tenant_user_id, reason)
    VALUES (${tenantId}, ${assignment.id}, 'revoked', ${actorTenantUserId}, ${input.revokeReason})
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: IDENTITY_ACCESS_MODULE_KEY,
    action: "revoke",
    resourceType: "business_scope_assignment",
    resourceId: assignment.id,
    severity: "critical",
    message: `Business-scope assignment revoked for subject at scope "${assignment.scopeType}".`,
    attributes: {
      tenantUserId: assignment.tenantUserId,
      scopeType: assignment.scopeType,
      revokeReason: input.revokeReason
    },
    correlationId
  });

  return { ok: true, assignment };
}

export type ListBusinessScopeAssignmentsFilter = {
  status?: BusinessScopeAssignmentRow["status"];
  tenantUserId?: string;
  scopeType?: string;
};

/** `LIMIT 200`, newest first — bounded-list convention (`legal-hold-service.ts`'s `listLegalHolds`). */
export async function listBusinessScopeAssignments(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListBusinessScopeAssignmentsFilter = {}
): Promise<BusinessScopeAssignmentRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, tenant_user_id, role_id, scope_type, scope_id, effective_from,
      effective_to, is_temporary, reason, granted_by_tenant_user_id, approved_by_tenant_user_id,
      status, revoked_at, revoked_by_tenant_user_id, revoke_reason, created_at, updated_at
    FROM awcms_mini_business_scope_assignments
    WHERE tenant_id = ${tenantId}
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
      AND (${filter.tenantUserId ?? null}::uuid IS NULL OR tenant_user_id = ${filter.tenantUserId ?? null})
      AND (${filter.scopeType ?? null}::text IS NULL OR scope_type = ${filter.scopeType ?? null})
    ORDER BY created_at DESC
    LIMIT 200
  `) as BusinessScopeAssignmentDbRow[];

  return rows.map(toRow);
}
