import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { listInboundDeliveries } from "../../../../../modules/integration-hub/application/delivery-directory";

const READ_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "deliveries",
  action: "read" as const
};

/** `GET /api/v1/integration-hub/deliveries/inbound?endpointId=&limit=` — recent inbound delivery metadata (never raw payload beyond the already-bounded/redacted snippet field, which this listing does not even project). */
export const GET: APIRoute = async ({ request, url, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const endpointId = url.searchParams.get("endpointId") ?? undefined;
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

    const deliveries = await listInboundDeliveries(tx, tenantId, {
      endpointId,
      limit
    });

    return ok({ deliveries });
  });
};
