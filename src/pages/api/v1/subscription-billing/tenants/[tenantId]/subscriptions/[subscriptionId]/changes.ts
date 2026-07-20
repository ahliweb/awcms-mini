import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../../modules/_shared/idempotency";
import { parseSubscriptionChangeBody } from "../../../../../../../../modules/subscription-billing/application/request-parsing";
import { validateSubscriptionChange } from "../../../../../../../../modules/subscription-billing/domain/request-validation";
import { scheduleSubscriptionChange } from "../../../../../../../../modules/subscription-billing/application/subscription-change-engine";
import { listSubscriptionChanges } from "../../../../../../../../modules/subscription-billing/application/billing-directory";
import {
  authorizeOperator,
  authorizeRead,
  billingFailureResponse,
  catalogDeps,
  errorBody,
  isUuid,
  runIdempotentBillingMutation,
  successBody,
  withTargetTenant
} from "../../../../_support";

const SCOPE = "subscription_billing_schedule_change";

/** `GET` — list scheduled/applied changes (platform op or self). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const tenantId = params.tenantId ?? "";
  const subscriptionId = params.subscriptionId ?? "";
  if (!isUuid(tenantId) || !isUuid(subscriptionId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and subscriptionId must be UUIDs."
    );
  }
  const auth = await authorizeRead(request, cookies, tenantId, "subscriptions");
  if (auth instanceof Response) return auth;
  const rows = await withTargetTenant(tenantId, (tx) =>
    listSubscriptionChanges(tx, tenantId, subscriptionId)
  );
  return new Response(JSON.stringify(successBody({ changes: rows })), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

/** `POST` — schedule an upgrade/downgrade/cancel (operator; deterministic; preserves history). */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  const subscriptionId = params.subscriptionId ?? "";
  if (!isUuid(tenantId) || !isUuid(subscriptionId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and subscriptionId must be UUIDs."
    );
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key header is required."
    );
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  const input = parseSubscriptionChangeBody(raw);
  const errors = validateSubscriptionChange(input);
  if (errors.length > 0) {
    return fail(
      400,
      "VALIDATION_ERROR",
      errors.map((e) => `${e.field}: ${e.message}`).join("; ")
    );
  }
  const auth = await authorizeOperator(request, cookies, "changes", "update");
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash({
    tenantId,
    subscriptionId,
    changeType: input.changeType,
    toOfferPlanKey: input.toOfferPlanKey,
    toOfferVersion: input.toOfferVersion,
    effectiveAt: input.effectiveAt
  });

  return runIdempotentBillingMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await scheduleSubscriptionChange(
        tx,
        tenantId,
        subscriptionId,
        {
          changeType: input.changeType as "upgrade" | "downgrade" | "cancel",
          toOfferPlanKey: input.toOfferPlanKey,
          toOfferVersion: input.toOfferVersion,
          prorationPolicy: input.prorationPolicy,
          effectiveAt: input.effectiveAt,
          reason: input.reason
        },
        catalogDeps(tx),
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      if (result.ok) {
        return {
          kind: "success",
          status: 201,
          body: successBody({ changeId: result.changeId })
        };
      }
      const mapped = billingFailureResponse(result.reason);
      return {
        kind: "conflict",
        status: mapped.status,
        body: errorBody(mapped.code, result.message)
      };
    }
  );
};
