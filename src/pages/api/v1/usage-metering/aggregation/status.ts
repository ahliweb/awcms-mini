import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { getAggregationStatus } from "../../../../../modules/usage-metering/application/rebuild-directory";

const READ_GUARD = {
  moduleKey: "usage_metering",
  activityCode: "usage",
  action: "read" as const
};

/**
 * `GET /api/v1/usage-metering/aggregation/status` (Issue #875) — the current
 * tenant's aggregation checkpoint/lease status and any pending rebuild request.
 * Current tenant RLS only. Gated by `usage.read` (operational visibility, not a
 * mutation).
 */
export const GET: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      new Date(),
      READ_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const status = await getAggregationStatus(tx, tenantId);
    return ok({ status });
  });
};
