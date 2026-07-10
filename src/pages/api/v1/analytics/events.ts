import type { APIRoute } from "astro";

import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import {
  decodeKeysetCursor,
  encodeKeysetCursor
} from "../../../../modules/_shared/keyset-pagination";
import {
  listVisitEvents,
  VISIT_EVENT_LIST_LIMIT
} from "../../../../modules/visitor-analytics/application/event-directory";
import { shapeVisitEvent } from "../../../../modules/visitor-analytics/domain/analytics-response-shaping";

const EVENTS_GUARD = {
  moduleKey: "visitor_analytics",
  activityCode: "events",
  action: "read" as const
};

const RAW_DETAIL_PERMISSION_KEY = "visitor_analytics.raw_detail.read";

/**
 * `GET /api/v1/analytics/events` (Issue #621) — keyset-paginated, newest
 * first. Raw detail (`ipHash`/`userAgentHash`) included only when the
 * caller also holds `visitor_analytics.raw_detail.read`.
 */
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const cursorParam = url.searchParams.get("cursor");
  const cursor = cursorParam ? decodeKeysetCursor(cursorParam) : null;

  if (cursorParam && !cursor) {
    return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
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
      EVENTS_GUARD
    );

    if (!auth.allowed) {
      return auth.denied;
    }

    const canSeeRawDetail = auth.grantedPermissionKeys.has(
      RAW_DETAIL_PERMISSION_KEY
    );

    const rows = await listVisitEvents(tx, tenantId, cursor ?? undefined);
    const events = rows.map((row) => shapeVisitEvent(row, canSeeRawDetail));

    const nextCursor =
      rows.length === VISIT_EVENT_LIST_LIMIT
        ? encodeKeysetCursor(
            rows[rows.length - 1]!.occurred_at,
            rows[rows.length - 1]!.id
          )
        : null;

    return ok({ events, nextCursor });
  });
};
