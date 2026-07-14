import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse,
  ok
} from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../../modules/identity-access/application/access-guard";
import { hashSessionToken } from "../../../../../lib/auth/session-token";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../modules/_shared/idempotency";
import { readJsonBody } from "../../../../../lib/security/request-body-limit";
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";
import {
  createIntegrationSubscription,
  InvalidOutboundTargetError,
  InvalidSubscriptionFilterError,
  listIntegrationSubscriptions,
  UnknownOutboundAdapterError,
  UnregisteredSubscribableEventTypeError
} from "../../../../../modules/integration-hub/application/subscription-directory";

const READ_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "subscriptions",
  action: "read" as const
};
const CREATE_GUARD = {
  moduleKey: "integration_hub",
  activityCode: "subscriptions",
  action: "create" as const
};
const IDEMPOTENCY_SCOPE = "integration_hub_subscription_create";

type CreateSubscriptionRequestBody = {
  subscribedEventType?: unknown;
  targetAdapterKey?: unknown;
  targetUrl?: unknown;
  targetHeaders?: unknown;
  secretReference?: unknown;
  filter?: unknown;
  maxAttempts?: unknown;
  timeoutMs?: unknown;
  description?: unknown;
};

export const GET: APIRoute = async ({ request, cookies }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
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

    const subscriptions = await listIntegrationSubscriptions(tx, tenantId);

    return ok({ subscriptions });
  });
};

/** `Idempotency-Key` required — each call creates a new persistent subscription. */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const { tenantId, token } = resolveAuthInputs(request, cookies);

  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }

  const bodyRead = await readJsonBody<CreateSubscriptionRequestBody>(request);
  if (bodyRead.tooLarge)
    return fail(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");

  const body = bodyRead.value ?? {};
  const subscribedEventType =
    typeof body.subscribedEventType === "string"
      ? body.subscribedEventType.trim()
      : "";
  const targetAdapterKey =
    typeof body.targetAdapterKey === "string"
      ? body.targetAdapterKey.trim()
      : "";
  const targetUrl =
    typeof body.targetUrl === "string" ? body.targetUrl.trim() : "";

  if (!subscribedEventType || !targetAdapterKey || !targetUrl) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "subscribedEventType, targetAdapterKey, and targetUrl are required."
    );
  }

  const requestHash = computeRequestHash(body);
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
      CREATE_GUARD
    );
    if (!auth.allowed) return auth.denied;

    const existingIdempotency = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey
    );
    if (existingIdempotency) {
      if (existingIdempotency.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existingIdempotency.responseBody, {
        status: existingIdempotency.responseStatus
      });
    }

    let subscription;

    try {
      subscription = await createIntegrationSubscription(tx, tenantId, {
        subscribedEventType,
        targetAdapterKey,
        targetUrl,
        targetHeaders:
          body.targetHeaders && typeof body.targetHeaders === "object"
            ? (body.targetHeaders as Record<string, string>)
            : undefined,
        secretReference:
          typeof body.secretReference === "string"
            ? body.secretReference
            : null,
        filter:
          body.filter && typeof body.filter === "object"
            ? (body.filter as Record<string, string | number | boolean>)
            : undefined,
        maxAttempts:
          typeof body.maxAttempts === "number" ? body.maxAttempts : undefined,
        timeoutMs:
          typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
        description:
          typeof body.description === "string" ? body.description : null,
        actorTenantUserId: auth.context.tenantUserId
      });
    } catch (error) {
      if (
        error instanceof UnknownOutboundAdapterError ||
        error instanceof UnregisteredSubscribableEventTypeError ||
        error instanceof InvalidOutboundTargetError ||
        error instanceof InvalidSubscriptionFilterError
      ) {
        return fail(400, "VALIDATION_ERROR", error.message);
      }

      throw error;
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "integration_hub",
      action: "integration_hub.subscription.created",
      resourceType: "integration_subscription",
      resourceId: subscription.id,
      severity: "info",
      message: `Outbound subscription created for event type "${subscription.subscribedEventType}".`,
      correlationId
    });

    const successResponse = ok({ subscription });
    const successBody = await successResponse.clone().json();
    await saveIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      idempotencyKey,
      requestHash,
      200,
      successBody
    );

    return successResponse;
  });
};
