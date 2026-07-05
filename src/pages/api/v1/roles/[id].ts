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
import { validateUpdateRoleInput } from "../../../../modules/identity-access/domain/user-management";
import { validateDeleteReasonRequestBody } from "../../../../modules/profile-identity/domain/lifecycle-validation";

const CONFIGURE_GUARD = {
  moduleKey: "identity_access",
  activityCode: "access_control",
  action: "configure" as const
};

type RoleRow = { id: string; role_code: string; is_system: boolean };

export const PATCH: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const roleId = params.id;

  if (!roleId) {
    return fail(400, "VALIDATION_ERROR", "Role id is required.");
  }

  const validation = validateUpdateRoleInput(
    await request.json().catch(() => null)
  );

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Role update is invalid.",
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

    const roleRows = (await tx`
      SELECT id, role_code, is_system FROM awcms_mini_roles
      WHERE tenant_id = ${tenantId} AND id = ${roleId} AND deleted_at IS NULL
    `) as RoleRow[];
    const role = roleRows[0];

    if (!role) {
      return fail(404, "RESOURCE_NOT_FOUND", "Role not found.");
    }

    // Safety rail: a system role (e.g. the owner role seeded at setup) keeps
    // its full permission set so an admin cannot accidentally lock everyone
    // out by editing it. Renaming is still allowed.
    if (role.is_system && input.permissionIds !== undefined) {
      return fail(
        409,
        "RESOURCE_CONFLICT",
        "Cannot modify the permissions of a system role."
      );
    }

    if (input.permissionIds !== undefined && input.permissionIds.length > 0) {
      const found = (await tx`
        SELECT id FROM awcms_mini_permissions
        WHERE id = ANY(${tx.array(input.permissionIds, "uuid")})
      `) as { id: string }[];

      if (found.length !== input.permissionIds.length) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "One or more permissionIds are unknown."
        );
      }
    }

    if (input.roleName !== undefined) {
      await tx`
        UPDATE awcms_mini_roles
        SET role_name = ${input.roleName}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${roleId}
      `;
    }

    if (input.permissionIds !== undefined) {
      // Replace the whole set: delete then re-insert (the role_permissions row
      // is a pure join with no history to preserve here).
      await tx`
        DELETE FROM awcms_mini_role_permissions
        WHERE tenant_id = ${tenantId} AND role_id = ${roleId}
      `;

      for (const permissionId of input.permissionIds) {
        await tx`
          INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
          VALUES (${tenantId}, ${roleId}, ${permissionId})
          ON CONFLICT (tenant_id, role_id, permission_id) DO NOTHING
        `;
      }
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "identity_access",
      action: "configure",
      resourceType: "role",
      resourceId: roleId,
      severity: "warning",
      message: "Role updated.",
      attributes: {
        roleName: input.roleName,
        permissionCount: input.permissionIds?.length
      }
    });

    return ok({ roleId });
  });
};

export const DELETE: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const roleId = params.id;

  if (!roleId) {
    return fail(400, "VALIDATION_ERROR", "Role id is required.");
  }

  const validation = validateDeleteReasonRequestBody(
    await request.json().catch(() => null)
  );

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Delete reason input is invalid.",
      {},
      validation.errors
    );
  }

  const reason = validation.value.reason;

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

    const roleRows = (await tx`
      SELECT id, role_code, is_system FROM awcms_mini_roles
      WHERE tenant_id = ${tenantId} AND id = ${roleId} AND deleted_at IS NULL
    `) as RoleRow[];
    const role = roleRows[0];

    if (!role) {
      return fail(404, "RESOURCE_NOT_FOUND", "Role not found.");
    }

    if (role.is_system) {
      return fail(409, "RESOURCE_CONFLICT", "Cannot delete a system role.");
    }

    const assignments = await tx`
      SELECT 1 FROM awcms_mini_access_assignments
      WHERE tenant_id = ${tenantId} AND role_id = ${roleId}
      LIMIT 1
    `;

    if (assignments[0]) {
      return fail(
        409,
        "RESOURCE_CONFLICT",
        "Role is still assigned to one or more users."
      );
    }

    await tx`
      UPDATE awcms_mini_roles
      SET deleted_at = ${now}, deleted_by = ${auth.context.tenantUserId},
          delete_reason = ${reason}
      WHERE tenant_id = ${tenantId} AND id = ${roleId}
    `;

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "identity_access",
      action: "delete",
      resourceType: "role",
      resourceId: roleId,
      severity: "warning",
      message: "Role soft-deleted.",
      attributes: { roleCode: role.role_code, reason }
    });

    return ok({ roleId, status: "deleted" });
  });
};
