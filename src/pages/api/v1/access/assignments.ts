import type { APIRoute } from "astro";
import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { extractBearerToken } from "../../../../modules/identity-access/application/session-lookup";
import {
  fetchGrantedPermissionKeys,
  resolveTenantContext
} from "../../../../modules/identity-access/application/auth-context";
import { recordDecisionLog } from "../../../../modules/identity-access/application/decision-log";
import { evaluateAccess } from "../../../../modules/identity-access/domain/access-control";

type AssignmentBody = {
  tenantUserId?: unknown;
  roleId?: unknown;
};

const GUARD_REQUEST = {
  moduleKey: "identity_access",
  activityCode: "access_control",
  action: "assign" as const
};

export const POST: APIRoute = async ({ request }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const body = (await request
    .json()
    .catch(() => null)) as AssignmentBody | null;

  if (
    typeof body?.tenantUserId !== "string" ||
    typeof body?.roleId !== "string"
  ) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantUserId and roleId are required."
    );
  }

  const tenantUserId = body.tenantUserId;
  const roleId = body.roleId;
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const context = await resolveTenantContext(tx, tenantId, tokenHash, now);

    if (!context) {
      return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
    }

    const grantedPermissionKeys = await fetchGrantedPermissionKeys(
      tx,
      tenantId,
      context.tenantUserId
    );
    const decision = evaluateAccess(
      context,
      GUARD_REQUEST,
      grantedPermissionKeys
    );

    await recordDecisionLog(
      tx,
      tenantId,
      context.tenantUserId,
      GUARD_REQUEST,
      decision
    );

    if (!decision.allowed) {
      return fail(403, "ACCESS_DENIED", decision.reason);
    }

    const roleRows = await tx`
      SELECT id FROM awcms_mini_roles
      WHERE tenant_id = ${tenantId} AND id = ${roleId} AND deleted_at IS NULL
    `;

    if (!roleRows[0]) {
      return fail(404, "RESOURCE_NOT_FOUND", "Role not found.");
    }

    const tenantUserRows = await tx`
      SELECT id FROM awcms_mini_tenant_users
      WHERE tenant_id = ${tenantId} AND id = ${tenantUserId}
    `;

    if (!tenantUserRows[0]) {
      return fail(404, "RESOURCE_NOT_FOUND", "Tenant user not found.");
    }

    const inserted = await tx`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id, assigned_by)
      VALUES (${tenantId}, ${tenantUserId}, ${roleId}, ${context.tenantUserId})
      ON CONFLICT (tenant_id, tenant_user_id, role_id) DO UPDATE
        SET tenant_id = EXCLUDED.tenant_id
      RETURNING id
    `;

    return ok({ assignmentId: inserted[0]!.id as string });
  });
};
