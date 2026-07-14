import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import { restoreOperationalLocation } from "../../../../../../modules/organization-structure/application/operational-location-directory";

const RESTORE_GUARD = {
  moduleKey: "organization_structure",
  activityCode: "locations",
  action: "restore" as const
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const locationId = params.id;
  if (!locationId)
    return fail(400, "VALIDATION_ERROR", "Location id is required.");

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

    const result = await restoreOperationalLocation(
      tx,
      tenantId,
      auth.context.tenantUserId,
      locationId,
      correlationId
    );

    if (!result.ok) {
      if (result.reason === "not_found")
        return fail(404, "NOT_FOUND", "Operational location not found.");
      return fail(
        409,
        "NOT_DELETED",
        "Operational location is not currently deleted."
      );
    }

    return ok({ location: result.location });
  });
};
