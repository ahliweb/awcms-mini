import type { APIRoute } from "astro";

import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { listUsageEvents } from "../../../../modules/usage-metering/application/usage-read-query";

const READ_GUARD = {
  moduleKey: "usage_metering",
  activityCode: "usage",
  action: "read" as const
};

/**
 * `GET /api/v1/usage-metering/events` (Issue #875) — the CURRENT tenant's
 * immutable usage-event timeline (most recent first), optionally filtered by
 * `?meterKey=`. Operates ONLY on the current tenant's RLS context (ADR-0022 §6 —
 * no cross-tenant path param). Numeric-only DTOs (admitted dimensions, never a
 * raw payload). Bounded (`LIMIT`).
 */
export const GET: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const meterKey = new URL(request.url).searchParams.get("meterKey");

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

    const events = await listUsageEvents(tx, tenantId, meterKey);
    return ok({ events });
  });
};
