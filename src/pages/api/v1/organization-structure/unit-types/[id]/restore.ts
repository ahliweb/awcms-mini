import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import { restoreOrganizationUnitType } from "../../../../../../modules/organization-structure/application/organization-unit-type-directory";

const RESTORE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "unit_types",
  action: "restore" as const
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const unitTypeId = params.id;
  if (!unitTypeId)
    return fail(400, "VALIDATION_ERROR", "Unit type id is required.");

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      RESTORE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const result = await restoreOrganizationUnitType(
      tx,
      tenantId,
      auth.context.tenantUserId,
      unitTypeId,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Organization-unit type not found.");
      return fail(
        409,
        "NOT_DELETED",
        "Organization-unit type is not currently deleted."
      );
    }

    return ok({ unitType: result.unitType });
  });
};
