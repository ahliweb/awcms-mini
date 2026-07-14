import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import {
  getOutboundDelivery,
  listDeliveryAttempts
} from "../../../../../../modules/integration-hub/application/delivery-directory";

const READ_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "deliveries",
  action: "read" as const
};

export const GET: APIRoute = async ({ request, params, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!id) return fail(400, "VALIDATION_ERROR", "Delivery id is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

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
    if (!auth.allowed) return auth.denied;

    const delivery = await getOutboundDelivery(tx, tenantId, id);
    if (!delivery)
      return fail(404, "RESOURCE_NOT_FOUND", "Outbound delivery not found.");

    const attempts = await listDeliveryAttempts(tx, tenantId, id);

    return ok({ delivery, attempts });
  });
};
