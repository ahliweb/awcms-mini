import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import {
  getSubscription,
  listPeriods
} from "../../../../../../../../modules/subscription-billing/application/billing-directory";
import { toSubscriptionDto } from "../../../../../../../../modules/subscription-billing/application/subscription-engine";
import {
  authorizeRead,
  isUuid,
  successBody,
  withTargetTenant
} from "../../../../_support";

/** `GET /.../subscriptions/{subscriptionId}` — one subscription + its periods (platform op or self). */
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
  const data = await withTargetTenant(tenantId, async (tx) => {
    const sub = await getSubscription(tx, tenantId, subscriptionId);
    if (!sub) return null;
    const periods = await listPeriods(tx, tenantId, subscriptionId);
    return { subscription: toSubscriptionDto(sub), periods };
  });
  if (!data) return fail(404, "RESOURCE_NOT_FOUND", "Subscription not found.");
  return new Response(JSON.stringify(successBody(data)), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
