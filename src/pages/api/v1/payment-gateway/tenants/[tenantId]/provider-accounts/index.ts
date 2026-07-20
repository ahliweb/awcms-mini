import type { APIRoute } from "astro";

import { fail } from "../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../modules/_shared/idempotency";
import { parseConfigureProviderAccountBody } from "../../../../../../../modules/payment-gateway/application/request-parsing";
import { validateConfigureProviderAccount } from "../../../../../../../modules/payment-gateway/domain/request-validation";
import {
  findProviderAccountByBinding,
  insertProviderAccount,
  updateProviderAccount
} from "../../../../../../../modules/payment-gateway/application/payment-directory";
import {
  authorizeOperator,
  authorizeRead,
  errorBody,
  isUuid,
  runIdempotentPaymentMutation,
  successBody,
  withTargetTenant
} from "../../../_support";

const SCOPE = "payment_gateway_configure_provider_account";

/** `GET /.../provider-accounts` — list provider account bindings (never the secret). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const tenantId = params.tenantId ?? "";
  if (!isUuid(tenantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
  }
  const auth = await authorizeRead(
    request,
    cookies,
    tenantId,
    "provider_accounts"
  );
  if (auth instanceof Response) return auth;
  const rows = await withTargetTenant(
    tenantId,
    (tx) =>
      tx`
      SELECT id, provider_key, provider_account_ref, display_name, status,
             endpoint_host, callback_host, webhook_tolerance_seconds, created_at
      FROM awcms_mini_payment_gateway_provider_accounts
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT 200
    `
  );
  return new Response(JSON.stringify(successBody({ providerAccounts: rows })), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

/** `POST /.../provider-accounts` — configure (create/update) a provider account binding (operator). */
export const POST: APIRoute = async ({ request, cookies, params }) => {
  const tenantId = params.tenantId ?? "";
  if (!isUuid(tenantId)) {
    return fail(400, "VALIDATION_ERROR", "tenantId must be a UUID.");
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
  const input = parseConfigureProviderAccountBody(raw);
  const errors = validateConfigureProviderAccount(input);
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
    "provider_accounts",
    "configure"
  );
  if (auth instanceof Response) return auth;

  const requestHash = computeRequestHash({
    tenantId,
    providerKey: input.providerKey,
    providerAccountRef: input.providerAccountRef,
    signingSecretRef: input.signingSecretRef,
    endpointHost: input.endpointHost,
    callbackHost: input.callbackHost,
    status: input.status,
    webhookToleranceSeconds: input.webhookToleranceSeconds,
    maxWebhookBodyBytes: input.maxWebhookBodyBytes
  });

  return runIdempotentPaymentMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const existing = await findProviderAccountByBinding(
        tx,
        tenantId,
        input.providerKey,
        input.providerAccountRef
      );
      const row = existing
        ? await updateProviderAccount(tx, {
            tenantId,
            accountId: existing.id,
            displayName: input.displayName,
            status: input.status,
            signingSecretRef: input.signingSecretRef,
            endpointHost: input.endpointHost,
            callbackHost: input.callbackHost,
            webhookToleranceSeconds: input.webhookToleranceSeconds,
            maxWebhookBodyBytes: input.maxWebhookBodyBytes,
            reason: input.reason,
            actor: auth.actorTenantUserId
          })
        : await insertProviderAccount(tx, {
            tenantId,
            providerKey: input.providerKey,
            providerAccountRef: input.providerAccountRef,
            displayName: input.displayName,
            status: input.status,
            signingSecretRef: input.signingSecretRef,
            endpointHost: input.endpointHost,
            callbackHost: input.callbackHost,
            webhookToleranceSeconds: input.webhookToleranceSeconds,
            maxWebhookBodyBytes: input.maxWebhookBodyBytes,
            reason: input.reason,
            actor: auth.actorTenantUserId
          });
      if (!row) {
        return {
          kind: "conflict",
          status: 409,
          body: errorBody(
            "PAYMENT_CONFLICT",
            "Provider account changed concurrently."
          )
        };
      }
      // NEVER return the signing secret ref value to the client beyond its opaque pointer shape.
      return {
        kind: "success",
        status: existing ? 200 : 201,
        body: successBody({
          providerAccount: {
            id: row.id,
            providerKey: row.provider_key,
            providerAccountRef: row.provider_account_ref,
            displayName: row.display_name,
            status: row.status,
            endpointHost: row.endpoint_host,
            callbackHost: row.callback_host,
            webhookToleranceSeconds: row.webhook_tolerance_seconds
          }
        })
      };
    }
  );
};
