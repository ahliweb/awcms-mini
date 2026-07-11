import type { APIRoute } from "astro";

import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { hashPassword } from "../../../../lib/auth/password";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../lib/security/request-body-limit";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import { recordAuditEvent } from "../../../../modules/logging/application/audit-log";
import { validateCreateUserInput } from "../../../../modules/identity-access/domain/user-management";
import { fetchTenantUsersWithRoles } from "../../../../modules/identity-access/application/user-directory";

const READ_GUARD = {
  moduleKey: "identity_access",
  activityCode: "user_management",
  action: "read" as const
};

const CREATE_GUARD = {
  moduleKey: "identity_access",
  activityCode: "user_management",
  action: "create" as const
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

    const users = await fetchTenantUsersWithRoles(tx, tenantId);

    return ok({ users });
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

  const bodyRead = await readJsonBody(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateCreateUserInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "User input is invalid.",
      {},
      validation.errors
    );
  }

  const input = validation.value;
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  // Argon2 hashing is deliberately outside the transaction (it is CPU-bound
  // and must not hold a DB connection/lock while it runs).
  const passwordHash = await hashPassword(input.password);

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      CREATE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const duplicate = await tx`
      SELECT 1 FROM awcms_mini_identities
      WHERE tenant_id = ${tenantId} AND login_identifier = ${input.loginIdentifier}
    `;

    if (duplicate[0]) {
      return fail(
        409,
        "RESOURCE_CONFLICT",
        "A user with that login identifier already exists."
      );
    }

    // Referential guard: every requested role must exist for this tenant.
    if (input.roleIds.length > 0) {
      const foundRoles = (await tx`
        SELECT id FROM awcms_mini_roles
        WHERE tenant_id = ${tenantId} AND id = ANY(${tx.array(input.roleIds, "uuid")})
          AND deleted_at IS NULL
      `) as { id: string }[];

      if (foundRoles.length !== input.roleIds.length) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "One or more roleIds are unknown."
        );
      }
    }

    const profileRows = await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', ${input.displayName})
      RETURNING id
    `;
    const profileId = profileRows[0]!.id as string;

    const identityRows = await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profileId}, ${input.loginIdentifier}, ${passwordHash})
      RETURNING id
    `;
    const identityId = identityRows[0]!.id as string;

    const tenantUserRows = await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identityId})
      RETURNING id
    `;
    const tenantUserId = tenantUserRows[0]!.id as string;

    if (input.roleIds.length > 0) {
      // Batched (single round trip) instead of one INSERT per role —
      // Issue #435 N+1 audit (skill `awcms-mini-performance` §Hindari N+1).
      await tx`
        INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id, assigned_by)
        SELECT ${tenantId}, ${tenantUserId}, role_id, ${auth.context.tenantUserId}
        FROM unnest(${tx.array(input.roleIds, "uuid")}) AS role_id
        ON CONFLICT (tenant_id, tenant_user_id, role_id) DO NOTHING
      `;
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "identity_access",
      action: "create",
      resourceType: "tenant_user",
      resourceId: tenantUserId,
      severity: "warning",
      message: "Tenant user created.",
      // loginIdentifier is redacted by recordAuditEvent (email/identifier is
      // sensitive); roleIds/displayName are safe to keep for the trail.
      attributes: {
        loginIdentifier: input.loginIdentifier,
        displayName: input.displayName,
        roleIds: input.roleIds
      }
    });

    return ok({
      tenantUserId,
      identityId,
      profileId
    });
  });
};
