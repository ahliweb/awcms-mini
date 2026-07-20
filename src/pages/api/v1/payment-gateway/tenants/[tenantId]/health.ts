import type { APIRoute } from "astro";

import { fail } from "../../../../../../modules/_shared/api-response";
import {
  authorizeRead,
  isUuid,
  successBody,
  withTargetTenant
} from "../../_support";

/** `GET /.../health` — provider adapter health/readiness + circuit-breaker state (operator or self-read). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const tenantId = params.tenantId ?? "";
  if (!isUuid(tenantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
  }
  const auth = await authorizeRead(request, cookies, tenantId, "health");
  if (auth instanceof Response) return auth;
  const rows = await withTargetTenant(
    tenantId,
    (tx) =>
      tx`
      SELECT h.provider_account_id, a.provider_key, h.direction, h.state,
             h.consecutive_failures, h.consecutive_successes, h.circuit_open_until,
             h.last_success_at, h.last_failure_at, h.last_checked_at
      FROM awcms_mini_payment_gateway_provider_health AS h
      JOIN awcms_mini_payment_gateway_provider_accounts AS a ON a.id = h.provider_account_id
      WHERE h.tenant_id = ${tenantId}
      ORDER BY h.updated_at DESC
      LIMIT 200
    `
  );
  return new Response(JSON.stringify(successBody({ providerHealth: rows })), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
