import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import { listOutboundDeliveries } from "../../../../../../modules/integration-hub/application/delivery-directory";

const READ_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "deliveries",
  action: "read" as const
};

/** `GET /api/v1/integration-hub/deliveries/outbound?subscriptionId=&status=&limit=` — includes `dead_letter` deliveries (Issue #754: "recent delivery metadata, failures"). */
export const GET: APIRoute = async ({ request, url, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const subscriptionId = url.searchParams.get("subscriptionId") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;

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

    const deliveries = await listOutboundDeliveries(tx, tenantId, {
      subscriptionId,
      status,
      limit
    });

    return ok({ deliveries });
  });
};
