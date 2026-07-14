import type { APIRoute } from "astro";

import { fail, ok } from "../../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../../lib/database/client";
import { withTenant } from "../../../../../lib/database/tenant-context";
import {
  bodyTooLargeResponse,
  readTextBody
} from "../../../../../lib/security/request-body-limit";
import {
  processInboundWebhook,
  resolveIntegrationEndpointByToken
} from "../../../../../modules/integration-hub/application/inbound-webhook-intake";

/**
 * `POST /api/v1/integration-hub/inbound/{endpointToken}` (Issue #754) —
 * the ONE public-facing inbound webhook receiver. NOT tenant-JWT
 * authenticated (an external provider has no AWCMS-Mini session) —
 * authenticated instead by (1) an opaque, unguessable `endpointToken` path
 * segment and (2) the registered adapter's own signature verification
 * (timing-safe HMAC, see `domain/signature-primitives.ts`). Replay
 * protection is enforced by a REAL database uniqueness constraint inside
 * `processInboundWebhook` (`(tenant_id, endpoint_id, replay_key)`), not
 * only the in-process logic here.
 *
 * Every failure path returns a generic, safe error — never distinguishes
 * "unknown token" from "known token, verification failed" via response
 * shape/timing beyond what the single `SECURITY DEFINER` lookup round
 * trip already bounds (see migration 071's own comment).
 */
export const POST: APIRoute = async ({ request, params }) => {
  const endpointToken = params.endpointToken;

  if (!endpointToken) {
    return fail(404, "RESOURCE_NOT_FOUND", "Unknown inbound endpoint.");
  }

  const bodyRead = await readTextBody(request, "large");

  if (bodyRead.tooLarge) {
    return bodyTooLargeResponse(bodyRead.limitBytes);
  }

  const sql = getDatabaseClient();
  const endpoint = await resolveIntegrationEndpointByToken(sql, endpointToken);

  if (!endpoint) {
    return fail(404, "RESOURCE_NOT_FOUND", "Unknown inbound endpoint.");
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key] = value;
  }

  const correlationId = crypto.randomUUID();
  const now = new Date();

  return withTenant(sql, endpoint.tenant_id, async (tx) => {
    const result = await processInboundWebhook(tx, {
      endpoint,
      rawBody: bodyRead.value,
      headers,
      contentType: request.headers.get("content-type"),
      now,
      correlationId
    });

    if (result.outcome === "rejected") {
      return fail(result.httpStatus, result.code, result.message);
    }

    if (result.outcome === "accepted_duplicate") {
      return ok({ status: "duplicate_ignored" });
    }

    return ok({ status: "accepted", deliveryId: result.deliveryId });
  });
};
