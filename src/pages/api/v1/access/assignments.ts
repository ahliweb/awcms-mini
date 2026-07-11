import type { APIRoute } from "astro";

import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../lib/security/request-body-limit";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import { recordAuditEvent } from "../../../../modules/logging/application/audit-log";

type AssignmentBody = {
  tenantUserId?: unknown;
  roleId?: unknown;
};

const ASSIGN_GUARD = {
  moduleKey: "identity_access",
  activityCode: "access_control",
  action: "assign" as const
};

function readAssignmentBody(
  body: AssignmentBody | null
): { tenantUserId: string; roleId: string } | null {
  if (
    typeof body?.tenantUserId !== "string" ||
    typeof body?.roleId !== "string"
  ) {
    return null;
  }

  return { tenantUserId: body.tenantUserId, roleId: body.roleId };
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody<AssignmentBody>(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const parsed = readAssignmentBody(bodyRead.value);

  if (!parsed) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantUserId and roleId are required."
    );
  }

  const { tenantUserId, roleId } = parsed;
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      ASSIGN_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
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
      VALUES (${tenantId}, ${tenantUserId}, ${roleId}, ${auth.context.tenantUserId})
      ON CONFLICT (tenant_id, tenant_user_id, role_id) DO UPDATE
        SET tenant_id = EXCLUDED.tenant_id
      RETURNING id
    `;

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "identity_access",
      action: "assign",
      resourceType: "access_assignment",
      resourceId: inserted[0]!.id as string,
      severity: "warning",
      message: "Role assigned to tenant user.",
      attributes: { tenantUserId, roleId }
    });

    return ok({ assignmentId: inserted[0]!.id as string });
  });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const bodyRead = await readJsonBody<AssignmentBody>(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const parsed = readAssignmentBody(bodyRead.value);

  if (!parsed) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantUserId and roleId are required."
    );
  }

  const { tenantUserId, roleId } = parsed;
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      ASSIGN_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const removed = await tx`
      DELETE FROM awcms_mini_access_assignments
      WHERE tenant_id = ${tenantId} AND tenant_user_id = ${tenantUserId}
        AND role_id = ${roleId}
      RETURNING id
    `;

    if (!removed[0]) {
      return fail(404, "RESOURCE_NOT_FOUND", "Assignment not found.");
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "identity_access",
      action: "assign",
      resourceType: "access_assignment",
      resourceId: removed[0]!.id as string,
      severity: "warning",
      message: "Role unassigned from tenant user.",
      attributes: { tenantUserId, roleId, unassigned: true }
    });

    return ok({ unassigned: true });
  });
};
