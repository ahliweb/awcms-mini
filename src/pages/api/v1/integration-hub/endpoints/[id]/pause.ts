import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../../lib/database/client";
import { withTenant } from "../../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../../lib/auth/session-token";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";
import { setIntegrationEndpointStatus } from "../../../../../../modules/integration-hub/application/endpoint-directory";

const DISABLE_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "endpoints",
  action: "disable" as const
};

/** Naturally idempotent (pausing an already-paused endpoint has the same end state) — no `Idempotency-Key` required, same convention `domain_event_runtime`'s consumer pause/resume already establishes. Still audited. */
export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!id) return fail(400, "VALIDATION_ERROR", "Endpoint id is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const correlationId = locals.correlationId;

  return withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      DISABLE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const endpoint = await setIntegrationEndpointStatus(
      tx,
      tenantId,
      id,
      "paused",
      auth.context.tenantUserId
    );

    if (!endpoint)
      return fail(404, "RESOURCE_NOT_FOUND", "Inbound endpoint not found.");

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "integration_hub",
      action: "integration_hub.endpoint.paused",
      resourceType: "integration_endpoint",
      resourceId: id,
      severity: "info",
      message: "Inbound webhook endpoint paused.",
      correlationId
    });

    return ok({ endpoint });
  });
};
