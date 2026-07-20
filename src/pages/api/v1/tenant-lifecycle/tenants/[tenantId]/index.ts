import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import { readTenantRestrictionSnapshot } from "../../../../../../modules/_shared/tenant-lifecycle-restriction-read";
import {
  listHistory,
  loadState,
  toLifecycleDto
} from "../../../../../../modules/tenant-lifecycle/application/lifecycle-directory";
import { authorizeOperator, isUuid } from "../../_support";

/**
 * `GET /api/v1/tenant-lifecycle/tenants/{tenantId}` (Issue #873) — read a
 * tenant's current lifecycle state, the server-derived restriction profile,
 * any pending scheduled transition, and the recent transition timeline.
 * Platform-operator only; read under the target tenant's per-tenant RLS context.
 */
export const GET: APIRoute = async ({ request, cookies, params, locals }) => {
  const targetTenantId = params.tenantId ?? "";
  if (!isUuid(targetTenantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
  }

  const auth = await authorizeOperator(
    request,
    cookies,
    "states",
    "read",
    locals.correlationId
  );
  if (auth instanceof Response) return auth;

  const sql = getDatabaseClient();
  return withTenant(sql, targetTenantId, async (tx) => {
    const row = await loadState(tx, targetTenantId);
    if (!row) {
      return fail(
        404,
        "RESOURCE_NOT_FOUND",
        "This tenant has no lifecycle record."
      );
    }
    const restriction = await readTenantRestrictionSnapshot(tx, targetTenantId);
    const timeline = await listHistory(tx, targetTenantId, 50);
    return ok({
      lifecycle: toLifecycleDto(row),
      restrictions: {
        governing: restriction.governing,
        state: restriction.state,
        profile: restriction.profile
      },
      timeline
    });
  });
};
