import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";
import { loadTimeline } from "../../../../../../modules/tenant-provisioning/application/provisioning-directory";
import { authorizeOperator, isUuid } from "../../_support";

/**
 * `GET /api/v1/tenant-provisioning/tenants/{tenantId}` (Issue #872) — the full
 * provisioning timeline for a target tenant: run, steps, attempts, results,
 * compensations, reconciliations. Platform-operator only; reads under the
 * target tenant's per-tenant RLS context (ADR-0022 §6(a)). Every cross-tenant
 * operator READ is audited (§6a) — reason/time-bound support-access hardening
 * is deferred to #879.
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
    // Audit the cross-tenant operator read (ADR-0022 §6a — every cross-tenant
    // access produces an audit event, like a mutation).
    await recordAuditEvent(tx, {
      tenantId: targetTenantId,
      actorTenantUserId: auth.actorTenantUserId,
      moduleKey: "tenant_provisioning",
      action: "read",
      resourceType: "tenant_provisioning_request",
      resourceId: timeline.request.id,
      severity: "info",
      message: "Platform operator read a tenant provisioning timeline.",
      correlationId: auth.correlationId
    });
    return ok(timeline);
  });
};
