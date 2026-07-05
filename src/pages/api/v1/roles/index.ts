import type { APIRoute } from "astro";

import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import { recordAuditEvent } from "../../../../modules/logging/application/audit-log";
import { validateCreateRoleInput } from "../../../../modules/identity-access/domain/user-management";
import { fetchRolesWithPermissions } from "../../../../modules/identity-access/application/user-directory";

const READ_GUARD = {
  moduleKey: "identity_access",
  activityCode: "access_control",
  action: "read" as const
};

const CONFIGURE_GUARD = {
  moduleKey: "identity_access",
  activityCode: "access_control",
  action: "configure" as const
};

export const GET: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      READ_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const roles = await fetchRolesWithPermissions(tx, tenantId);

    return ok({ roles });
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const validation = validateCreateRoleInput(
    await request.json().catch(() => null)
  );

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Role input is invalid.",
      {},
      validation.errors
    );
  }

  const input = validation.value;
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      CONFIGURE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const duplicate = await tx`
      SELECT 1 FROM awcms_mini_roles
      WHERE tenant_id = ${tenantId} AND role_code = ${input.roleCode}
        AND deleted_at IS NULL
    `;

    if (duplicate[0]) {
      return fail(
        409,
        "RESOURCE_CONFLICT",
        "A role with that code already exists."
      );
    }

    if (input.permissionIds.length > 0) {
      const foundPermissions = (await tx`
        SELECT id FROM awcms_mini_permissions
        WHERE id = ANY(${tx.array(input.permissionIds, "uuid")})
      `) as { id: string }[];

      if (foundPermissions.length !== input.permissionIds.length) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "One or more permissionIds are unknown."
        );
      }
    }

    const roleRows = await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, ${input.roleCode}, ${input.roleName})
      RETURNING id
    `;
    const roleId = roleRows[0]!.id as string;

    for (const permissionId of input.permissionIds) {
      await tx`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        VALUES (${tenantId}, ${roleId}, ${permissionId})
        ON CONFLICT (tenant_id, role_id, permission_id) DO NOTHING
      `;
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "identity_access",
      action: "create",
      resourceType: "role",
      resourceId: roleId,
      severity: "warning",
      message: "Role created.",
      attributes: {
        roleCode: input.roleCode,
        roleName: input.roleName,
        permissionCount: input.permissionIds.length
      }
    });

    return ok({ roleId });
  });
};
