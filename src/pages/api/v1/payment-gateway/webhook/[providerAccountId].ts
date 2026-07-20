import type { APIRoute } from "astro";

import {
  fail,
  jsonResponse
} from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  bodyTooLargeResponse,
  readTextBody
} from "../../../../../lib/security/request-body-limit";
import { resolveProviderAccountLookup } from "../../../../../modules/payment-gateway/application/payment-directory";
import { processInboundPaymentWebhook } from "../../../../../modules/payment-gateway/application/webhook-intake";
import { createPaymentOutcomePort } from "../_support";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `POST /api/v1/payment-gateway/webhook/{providerAccountId}` (Issue #877) — the
 * ONE public-facing signed inbound payment webhook receiver. NOT tenant-JWT
 * authenticated (a payment provider has no AWCMS-Mini session) — authenticated
 * instead by (1) the opaque `providerAccountId` (which binds to exactly ONE
 * tenant via the global unique (provider_key, account_ref) — cross-tenant
 * substitution guard) and (2) the registered adapter's own signature +
 * freshness + account-binding verification. Anti-replay is a DURABLE DB unique
 * constraint inside `processInboundPaymentWebhook`, not an in-memory check.
 *
 * Payment status is NEVER trusted from a browser redirect — only a delivery that
 * clears every fail-closed gate here updates payment (exactly once). Every
 * failure returns a generic, safe error.
 *
 * Route parity: this receiver is deliberately NOT part of the public tenant
 * OpenAPI contract (it is a provider callback, like integration_hub's inbound
 * endpoint) — it is listed in ROUTE_PARITY_EXEMPTIONS (scripts/api-spec-check.ts).
 */
export const POST: APIRoute = async ({ request, params }) => {
  const providerAccountId = params.providerAccountId ?? "";
  if (!UUID_RE.test(providerAccountId)) {
    return fail(404, "RESOURCE_NOT_FOUND", "Unknown payment endpoint.");
  }

  // Stricter `webhook` tier (1 MiB) — aligned with the per-account
  // `max_webhook_body_bytes` DB hard-cap — caps buffering for this UNAUTHENTICATED
  // edge before the per-account limit (checked in the intake) rejects it.
  const bodyRead = await readTextBody(request, "webhook");
  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const sql = getDatabaseClient();
  const account = await resolveProviderAccountLookup(sql, providerAccountId);
  if (!account) {
    return fail(404, "RESOURCE_NOT_FOUND", "Unknown payment endpoint.");
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key.toLowerCase()] = value;
  }
  const contentType = request.headers.get("content-type");
  const correlationId = crypto.randomUUID();
  const now = new Date();

  const result = await withTenant(sql, account.tenant_id, (tx) =>
    processInboundPaymentWebhook(tx, {
      account,
      rawBody: bodyRead.value,
      headers,
      contentType,
      now,
      correlationId,
      billing: createPaymentOutcomePort(tx, account.tenant_id, correlationId)
    })
  );

  if (result.outcome === "rejected") {
    return fail(result.httpStatus, result.code, "Webhook rejected.");
  }
  // Accepted (new or idempotent duplicate) — a signed delivery is acknowledged
  // with 200 so the provider does not needlessly retry a delivery we durably
  // recorded. The applied status is intentionally NOT leaked in detail.
  return jsonResponse(
    { success: true, data: { accepted: true }, meta: {} },
    { status: 200 }
  );
};
