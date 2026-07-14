import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import { readJsonBody } from "../../../../../lib/security/request-body-limit";
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";
import {
  getIntegrationSubscription,
  softDeleteIntegrationSubscription
} from "../../../../../modules/integration-hub/application/subscription-directory";

const READ_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "subscriptions",
  action: "read" as const
};
const DELETE_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "subscriptions",
  action: "delete" as const
};
const MAX_REASON_LENGTH = 500;

type DeleteRequestBody = { reason?: unknown };

export const GET: APIRoute = async ({ request, params, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!id) return fail(400, "VALIDATION_ERROR", "Subscription id is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

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

    const subscription = await getIntegrationSubscription(tx, tenantId, id);
    if (!subscription)
      return fail(404, "RESOURCE_NOT_FOUND", "Subscription not found.");

    return ok({ subscription });
  });
};

export const DELETE: APIRoute = async ({
  request,
  params,
  cookies,
  locals
}) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  const id = params.id;

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!id) return fail(400, "VALIDATION_ERROR", "Subscription id is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const bodyRead = await readJsonBody<DeleteRequestBody>(request);
  if (bodyRead.tooLarge)
    return fail(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");

  const reason =
    typeof bodyRead.value?.reason === "string"
      ? bodyRead.value.reason.trim()
      : "";
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    return fail(
      400,
      "VALIDATION_ERROR",
      `reason is required and must be 1-${MAX_REASON_LENGTH} characters.`
    );
  }

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
      DELETE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const deleted = await softDeleteIntegrationSubscription(
      tx,
      tenantId,
      id,
      reason,
      auth.context.tenantUserId
    );

    if (!deleted)
      return fail(404, "RESOURCE_NOT_FOUND", "Subscription not found.");

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "integration_hub",
      action: "integration_hub.subscription.deleted",
      resourceType: "integration_subscription",
      resourceId: id,
      severity: "warning",
      message: `Outbound subscription soft-deleted: ${reason}`,
      correlationId
    });

    return ok({ deleted: true });
  });
};
