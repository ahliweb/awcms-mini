import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import { loadTimeline } from "../../../../../../modules/tenant-provisioning/application/provisioning-directory";
import { authorizeOperator, isUuid } from "../../_support";

/**
 * `GET /api/v1/tenant-provisioning/tenants/{tenantId}` (Issue #872) — the full
 * provisioning timeline for a target tenant: run, steps, attempts, results,
 * compensations, reconciliations. Platform-operator only; reads under the
 * target tenant's per-tenant RLS context (ADR-0022 §6(a)).
 */
export const GET: APIRoute = async ({ request, cookies, params, locals }) => {
  const targetTenantId = params.tenantId ?? "";
  if (!isUuid(targetTenantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
  }

  const auth = await authorizeOperator(
    request,
    cookies,
    "requests",
    "read",
    locals.correlationId
  );
  if (auth instanceof Response) return auth;

  const sql = getDatabaseClient();
  return withTenant(sql, targetTenantId, async (tx) => {
    const timeline = await loadTimeline(tx, targetTenantId);
    if (!timeline) {
      return fail(
        404,
        "RESOURCE_NOT_FOUND",
        "No provisioning run for this tenant."
      );
    }
    return ok(timeline);
  });
};
