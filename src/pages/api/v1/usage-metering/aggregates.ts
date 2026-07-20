import type { APIRoute } from "astro";

import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { listAggregates } from "../../../../modules/usage-metering/application/usage-read-query";
import {
  WINDOW_TYPES,
  type WindowType
} from "../../../../modules/usage-metering/domain/meter-semantics";

const READ_GUARD = {
  moduleKey: "usage_metering",
  activityCode: "usage",
  action: "read" as const
};

/**
 * `GET /api/v1/usage-metering/aggregates` (Issue #875) — the CURRENT tenant's
 * materialized usage windows with freshness metadata, optionally filtered by
 * `?meterKey=` and `?windowType=hour|day|month`. A present-but-invalid
 * `windowType` FAILS CLOSED (400 — never coerced). Current tenant RLS only.
 */
export const GET: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const params = new URL(request.url).searchParams;
  const meterKey = params.get("meterKey");
  const windowTypeParam = params.get("windowType");
  if (
    windowTypeParam !== null &&
    !WINDOW_TYPES.includes(windowTypeParam as WindowType)
  ) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "windowType must be one of hour, day, month."
    );
  }

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

    const aggregates = await listAggregates(
      tx,
      tenantId,
      meterKey,
      windowTypeParam as WindowType | null,
      new Date()
    );
    return ok({ aggregates });
  });
};
