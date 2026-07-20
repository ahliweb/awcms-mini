import type { APIRoute } from "astro";

import { fail } from "../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../modules/_shared/idempotency";
import { parseCreateSubscriptionBody } from "../../../../../../../modules/subscription-billing/application/request-parsing";
import { validateCreateSubscription } from "../../../../../../../modules/subscription-billing/domain/request-validation";
import {
  createSubscriptionForOffer,
  toSubscriptionDto
} from "../../../../../../../modules/subscription-billing/application/subscription-engine";
import type { SubscriptionSource } from "../../../../../../../modules/subscription-billing/domain/subscription-state";
import type { RoundingMode } from "../../../../../../../modules/subscription-billing/domain/money";
import { listSubscriptions } from "../../../../../../../modules/subscription-billing/application/billing-directory";
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
} from "../../../_support";

const SCOPE = "subscription_billing_create_subscription";

/** `GET /api/v1/subscription-billing/tenants/{tenantId}/subscriptions` — list (platform op or self). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const tenantId = params.tenantId ?? "";
  if (!isUuid(tenantId))
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
  const auth = await authorizeRead(request, cookies, tenantId, "subscriptions");
  if (auth instanceof Response) return auth;
  const rows = await withTargetTenant(tenantId, (tx) =>
    listSubscriptions(tx, tenantId)
  );
  return new Response(
    JSON.stringify(successBody({ subscriptions: rows.map(toSubscriptionDto) })),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

/** `POST` — create a subscription bound to an immutable published offer (platform operator). */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  if (!isUuid(tenantId))
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
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
  const input = parseCreateSubscriptionBody(raw);
  const errors = validateCreateSubscription(input);
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
    "create"
  );
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash({
    tenantId,
    offerPlanKey: input.offerPlanKey,
    offerVersion: input.offerVersion,
    billingInterval: input.billingInterval,
    trialEndsAt: input.trialEndsAt
  });

  return runIdempotentBillingMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await createSubscriptionForOffer(
        tx,
        tenantId,
        {
          offerPlanKey: input.offerPlanKey,
          offerVersion: input.offerVersion,
          billingInterval: input.billingInterval,
          billingAnchorDay: input.billingAnchorDay,
          prorationPolicy: input.prorationPolicy,
          roundingMode: input.roundingMode as RoundingMode,
          collectionMode: input.collectionMode,
          trialEndsAt: input.trialEndsAt,
          billingContactRef: input.billingContactRef,
          reason: input.reason,
          source: input.source as SubscriptionSource
        },
        catalogDeps(tx),
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      if (result.ok) {
        return {
          kind: "success",
          status: 201,
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
