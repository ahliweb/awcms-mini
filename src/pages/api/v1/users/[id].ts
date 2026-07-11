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
import { validateUpdateUserInput } from "../../../../modules/identity-access/domain/user-management";

const UPDATE_GUARD = {
  moduleKey: "identity_access",
  activityCode: "user_management",
  action: "update" as const
};

export const PATCH: APIRoute = async ({ request, cookies, params }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const tenantUserId = params.id;

  if (!tenantUserId) {
    return fail(400, "VALIDATION_ERROR", "User id is required.");
  }

  const bodyRead = await readJsonBody(request);

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const validation = validateUpdateUserInput(bodyRead.value);

  if (!validation.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "User update is invalid.",
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
      UPDATE_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const userRows = (await tx`
      SELECT tu.id, tu.identity_id, i.profile_id
      FROM awcms_mini_tenant_users tu
      JOIN awcms_mini_identities i
        ON i.id = tu.identity_id AND i.tenant_id = tu.tenant_id
      WHERE tu.tenant_id = ${tenantId} AND tu.id = ${tenantUserId}
    `) as { id: string; identity_id: string; profile_id: string }[];
    const user = userRows[0];

    if (!user) {
      return fail(404, "RESOURCE_NOT_FOUND", "Tenant user not found.");
    }

    if (input.displayName !== undefined) {
      await tx`
        UPDATE awcms_mini_profiles
        SET display_name = ${input.displayName}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${user.profile_id}
      `;
    }

    if (input.status !== undefined) {
      await tx`
        UPDATE awcms_mini_tenant_users
        SET status = ${input.status}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${tenantUserId}
      `;
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "identity_access",
      action: "update",
      resourceType: "tenant_user",
      resourceId: tenantUserId,
      severity: "warning",
      message: "Tenant user updated.",
      attributes: {
        displayName: input.displayName,
        status: input.status
      }
    });

    return ok({
      tenantUserId,
      displayName: input.displayName,
      status: input.status
    });
  });
};
