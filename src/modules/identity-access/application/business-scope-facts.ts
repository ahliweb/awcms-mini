/**
 * Resolves the bounded, I/O-derived facts `domain/access-control.ts`'s
 * `evaluateAccess`/`domain/sod-conflict-evaluation.ts`'s
 * `detectSoDConflicts` need to stay pure (Issue #746, epic #738
 * platform-evolution Wave 2).
 *
 * - `resolveBusinessScopeFacts` — plain `(scopeType, scopeId)` pairs the
 *   subject currently holds ANY active assignment for, regardless of role/
 *   permission — feeds `evaluateAccess`'s optional `businessScopeFacts`
 *   parameter (a route opts in via `resourceAttributes.requiredScopeType`/
 *   `.requiredScopeId`).
 * - `resolveSoDAssignmentFacts` — `(permissionKey, scopeType, scopeId)`
 *   triples feeding SoD conflict detection. **Security-auditor finding on
 *   PR #776, fixed**: this originally reasoned ONLY about permissions
 *   held via an active business-scope assignment's role, silently missing
 *   the realistic case where BOTH halves of a registered conflict are
 *   held through an ORDINARY RBAC role grant (e.g. the setup wizard's
 *   "owner" role, which grants every permission in the tenant, including
 *   both `data_lifecycle.legal_hold.create` and `.release`) — the "zero
 *   regression for existing tenants" reasoning previously documented here
 *   was true only because the check was, in effect, blind to the most
 *   common real path. Now merges BOTH sources: the
 *   business-scope-assignment path (its own facts carry that assignment's
 *   real scope) and the ordinary `awcms_mini_access_assignments` →
 *   `awcms_mini_role_permissions` path (`resolveOrdinaryRbacFacts` below —
 *   the exact same source `auth-context.ts`'s `fetchGrantedPermissionKeys`
 *   already reads for every ordinary ABAC decision), with `scopeType`/
 *   `scopeId: null` for the latter (an ordinary role grant is not confined
 *   to any business scope). This DOES mean a tenant whose existing role
 *   composition already holds both halves of a registered conflict is now
 *   genuinely affected the moment this ships — the intended, correct
 *   behavior for a rule a module registered as a real SoD conflict, not a
 *   regression to work around.
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

type OrdinaryRbacPermissionRow = {
  module_key: string;
  activity_code: string;
  action: string;
};

/**
 * Permissions the subject holds via an ORDINARY RBAC role grant
 * (`awcms_mini_access_assignments` → `awcms_mini_role_permissions` →
 * `awcms_mini_permissions`) — the exact same path
 * `auth-context.ts`'s `fetchGrantedPermissionKeys` already reads for
 * every ordinary ABAC decision in this codebase. Security-auditor finding
 * on PR #776: SoD conflict detection originally reasoned ONLY about
 * permissions held via the NEW business-scope-assignment path, silently
 * missing the realistic case where a subject holds BOTH halves of a
 * registered conflict through an ordinary role (e.g. the setup wizard's
 * "owner" role, which grants every permission including both
 * `data_lifecycle.legal_hold.create` and `.release`). Returned facts have
 * `scopeType`/`scopeId: null` — an ordinary role grant is not confined to
 * any business scope, so `detectSoDConflicts` treats it as conflicting at
 * EVERY requested scope for a `"same_scope_only"` rule (see
 * `sod-conflict-evaluation.ts`'s `SoDAssignmentFact` doc comment).
 */
async function resolveOrdinaryRbacFacts(
  tx: Bun.SQL,
  tenantId: string,
  tenantUserId: string
): Promise<SoDAssignmentFact[]> {
  const rows = (await tx`
    SELECT DISTINCT p.module_key, p.activity_code, p.action
    FROM awcms_mini_access_assignments aa
    JOIN awcms_mini_role_permissions rp ON rp.role_id = aa.role_id AND rp.tenant_id = aa.tenant_id
    JOIN awcms_mini_permissions p ON p.id = rp.permission_id
    JOIN awcms_mini_roles r ON r.id = aa.role_id
    WHERE aa.tenant_id = ${tenantId} AND aa.tenant_user_id = ${tenantUserId}
      AND r.deleted_at IS NULL
  `) as OrdinaryRbacPermissionRow[];

  return rows.map((row) => ({
    permissionKey: `${row.module_key}.${row.activity_code}.${row.action}`,
    scopeType: null,
    scopeId: null
  }));
}

/**
 * `excludeAssignmentId` lets `assignment_create` conflict evaluation check
 * the subject's OTHER existing active assignments without the
 * not-yet-committed new one interfering (it does not exist yet at
 * validation time anyway, but this also matters for a RENEWAL/update
 * flow that might reuse this helper against an existing row).
 *
 * Merges TWO sources into one fact set (see `resolveOrdinaryRbacFacts`'s
 * own header for why the second source is required): the
 * business-scope-assignment-granted permissions this function has always
 * resolved, PLUS the subject's ordinary RBAC-granted permissions.
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

  facts.push(...(await resolveOrdinaryRbacFacts(tx, tenantId, tenantUserId)));

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
