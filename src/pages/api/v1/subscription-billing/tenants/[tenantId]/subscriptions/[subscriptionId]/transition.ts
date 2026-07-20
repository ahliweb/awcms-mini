import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../../modules/_shared/idempotency";
import { parseSubscriptionTransitionBody } from "../../../../../../../../modules/subscription-billing/application/request-parsing";
import { validateSubscriptionTransition } from "../../../../../../../../modules/subscription-billing/domain/request-validation";
import { transitionSubscription } from "../../../../../../../../modules/subscription-billing/application/subscription-engine";
import type {
  SubscriptionSource,
  SubscriptionState
} from "../../../../../../../../modules/subscription-billing/domain/subscription-state";
import {
  authorizeOperator,
  billingFailureResponse,
  errorBody,
  isUuid,
  runIdempotentBillingMutation,
  successBody
} from "../../../../_support";

const SCOPE = "subscription_billing_transition_subscription";

/** `POST /.../subscriptions/{subscriptionId}/transition` — validated subscription transition (operator). */
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
  const input = parseSubscriptionTransitionBody(raw);
  const errors = validateSubscriptionTransition(input);
  if (errors.length > 0) {
    return fail(
      400,
      "VALIDATION_ERROR",
      errors.map((e) => `${e.field}: ${e.message}`).join("; ")
    );
  }
  const auth = await authorizeOperator(
    request,
    cookies,
    "subscriptions",
    "update"
  );
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash({
    tenantId,
    subscriptionId,
    toState: input.toState,
    source: input.source,
    expectedVersion: input.expectedVersion
  });

  return runIdempotentBillingMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await transitionSubscription(
        tx,
        tenantId,
        subscriptionId,
        {
          toState: input.toState as SubscriptionState,
          source: input.source as SubscriptionSource,
          reason: input.reason,
          expectedVersion: input.expectedVersion
        },
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      if (result.ok) {
        return {
          kind: "success",
          status: 200,
          body: successBody({ subscription: result.subscription })
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
