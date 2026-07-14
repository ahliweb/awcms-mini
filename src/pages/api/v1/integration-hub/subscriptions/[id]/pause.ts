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
import { setIntegrationSubscriptionStatus } from "../../../../../../modules/integration-hub/application/subscription-directory";

const DISABLE_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "subscriptions",
  action: "disable" as const
};

export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!id) return fail(400, "VALIDATION_ERROR", "Subscription id is required.");
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

    const subscription = await setIntegrationSubscriptionStatus(
      tx,
      tenantId,
      id,
      "paused",
      auth.context.tenantUserId
    );

    if (!subscription)
      return fail(404, "RESOURCE_NOT_FOUND", "Subscription not found.");

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "integration_hub",
      action: "integration_hub.subscription.paused",
      resourceType: "integration_subscription",
      resourceId: id,
      severity: "info",
      message: "Outbound subscription paused.",
      correlationId
    });

    return ok({ subscription });
  });
};
