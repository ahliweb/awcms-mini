/**
 * Resolves the bounded, I/O-derived facts `domain/access-control.ts`'s
 * `evaluateAccess`/`domain/sod-conflict-evaluation.ts`'s
 * `detectSoDConflicts` need to stay pure (Issue #746, epic #738
 * platform-evolution Wave 2). Two independent projections over the SAME
 * underlying `awcms_mini_business_scope_assignments` rows:
 *
 * - `resolveBusinessScopeFacts` — plain `(scopeType, scopeId)` pairs the
 *   subject currently holds ANY active assignment for, regardless of role/
 *   permission — feeds `evaluateAccess`'s optional `businessScopeFacts`
 *   parameter (a route opts in via `resourceAttributes.requiredScopeType`/
 *   `.requiredScopeId`).
 * - `resolveSoDAssignmentFacts` — `(permissionKey, scopeType, scopeId)`
 *   triples, resolved via each active assignment's `role_id` (when set) —
 *   feeds SoD conflict detection, which reasons about PERMISSIONS the
 *   subject holds through a business-scope assignment, not the RBAC
 *   `awcms_mini_access_assignments` grant (`auth-context.ts`'s
 *   `fetchGrantedPermissionKeys`) that ordinary ABAC already checks. This
 *   is deliberate (see `access-guard.ts`'s SoD wiring comment): SoD
 *   conflict enforcement here is scoped to what THIS feature introduces
 *   (business-scope assignments), which is a genuine no-op for every
 *   tenant until the first assignment is ever created — never a
 *   retroactive re-evaluation of pre-existing RBAC role grants.
 */
import { isBusinessScopeAssignmentCurrentlyActive } from "../domain/business-scope-assignment";
import type { BusinessScopeFact } from "../domain/access-control";
import type { SoDAssignmentFact } from "../domain/sod-conflict-evaluation";

type ActiveAssignmentRow = {
  id: string;
  scope_type: string;
  scope_id: string;
  effective_from: Date;
  effective_to: Date | null;
  status: "active" | "expired" | "revoked";
};

async function fetchActiveAssignmentRows(
  tx: Bun.SQL,
  tenantId: string,
  tenantUserId: string,
  excludeAssignmentId: string | null
): Promise<ActiveAssignmentRow[]> {
  return (await tx`
    SELECT id, scope_type, scope_id, effective_from, effective_to, status
    FROM awcms_mini_business_scope_assignments
    WHERE tenant_id = ${tenantId} AND tenant_user_id = ${tenantUserId}
      AND status = 'active'
      AND (${excludeAssignmentId}::uuid IS NULL OR id <> ${excludeAssignmentId})
  `) as ActiveAssignmentRow[];
}

export async function resolveBusinessScopeFacts(
  tx: Bun.SQL,
  tenantId: string,
  tenantUserId: string,
  now: Date
): Promise<BusinessScopeFact[]> {
  const rows = await fetchActiveAssignmentRows(
    tx,
    tenantId,
    tenantUserId,
    null
  );
  const facts: BusinessScopeFact[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (
      !isBusinessScopeAssignmentCurrentlyActive(
        {
          status: row.status,
          effectiveFrom: row.effective_from,
          effectiveTo: row.effective_to
        },
        now
      )
    ) {
      continue;
    }

    const dedupeKey = `${row.scope_type}:${row.scope_id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    facts.push({ scopeType: row.scope_type, scopeId: row.scope_id });
  }

  return facts;
}

type AssignmentPermissionRow = {
  scope_type: string;
  scope_id: string;
  effective_from: Date;
  effective_to: Date | null;
  status: "active" | "expired" | "revoked";
  module_key: string;
  activity_code: string;
  action: string;
};

/**
 * `excludeAssignmentId` lets `assignment_create` conflict evaluation check
 * the subject's OTHER existing active assignments without the
 * not-yet-committed new one interfering (it does not exist yet at
 * validation time anyway, but this also matters for a RENEWAL/update
 * flow that might reuse this helper against an existing row).
 */
export async function resolveSoDAssignmentFacts(
  tx: Bun.SQL,
  tenantId: string,
  tenantUserId: string,
  now: Date,
  excludeAssignmentId: string | null = null
): Promise<SoDAssignmentFact[]> {
  const rows = (await tx`
    SELECT bsa.scope_type, bsa.scope_id, bsa.effective_from, bsa.effective_to, bsa.status,
      p.module_key, p.activity_code, p.action
    FROM awcms_mini_business_scope_assignments bsa
    JOIN awcms_mini_role_permissions rp
      ON rp.role_id = bsa.role_id AND rp.tenant_id = bsa.tenant_id
    JOIN awcms_mini_permissions p ON p.id = rp.permission_id
    WHERE bsa.tenant_id = ${tenantId} AND bsa.tenant_user_id = ${tenantUserId}
      AND bsa.status = 'active' AND bsa.role_id IS NOT NULL
      AND (${excludeAssignmentId}::uuid IS NULL OR bsa.id <> ${excludeAssignmentId})
  `) as AssignmentPermissionRow[];

  const facts: SoDAssignmentFact[] = [];

  for (const row of rows) {
    if (
      !isBusinessScopeAssignmentCurrentlyActive(
        {
          status: row.status,
          effectiveFrom: row.effective_from,
          effectiveTo: row.effective_to
        },
        now
      )
    ) {
      continue;
    }

    facts.push({
      permissionKey: `${row.module_key}.${row.activity_code}.${row.action}`,
      scopeType: row.scope_type,
      scopeId: row.scope_id
    });
  }

  return facts;
}

/**
 * The permission keys `roleId` grants — used at assignment-CREATE time to
 * know which permission keys the NOT-YET-created assignment would newly
 * confer at its scope, so SoD conflict detection can check each one
 * against the subject's OTHER already-active assignment facts.
 */
export async function resolveRolePermissionKeys(
  tx: Bun.SQL,
  tenantId: string,
  roleId: string
): Promise<string[]> {
  const rows = (await tx`
    SELECT DISTINCT p.module_key, p.activity_code, p.action
    FROM awcms_mini_role_permissions rp
    JOIN awcms_mini_permissions p ON p.id = rp.permission_id
    WHERE rp.tenant_id = ${tenantId} AND rp.role_id = ${roleId}
  `) as { module_key: string; activity_code: string; action: string }[];

  return rows.map(
    (row) => `${row.module_key}.${row.activity_code}.${row.action}`
  );
}
