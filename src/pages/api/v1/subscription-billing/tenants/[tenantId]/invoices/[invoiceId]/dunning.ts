import type { APIRoute } from "astro";

import { fail } from "../../../../../../../../modules/_shared/api-response";
import { computeRequestHash } from "../../../../../../../../modules/_shared/idempotency";
import { runDunningAttempt } from "../../../../../../../../modules/subscription-billing/application/dunning-engine";
import { listDunningAttempts } from "../../../../../../../../modules/subscription-billing/application/billing-directory";
import type { LifecycleState } from "../../../../../../../../modules/_shared/ports/tenant-lifecycle-port";
import {
  authorizeOperator,
  authorizeRead,
  billingFailureResponse,
  dunningDeps,
  errorBody,
  isUuid,
  runIdempotentBillingMutation,
  successBody,
  withTargetTenant
} from "../../../../_support";

const SCOPE = "subscription_billing_dunning";
const ALLOWED_STATES: LifecycleState[] = ["past_due", "grace", "suspended"];

/** `GET` — list dunning attempts for an invoice (platform op or self). */
export const GET: APIRoute = async ({ request, cookies, params }) => {
  const tenantId = params.tenantId ?? "";
  const invoiceId = params.invoiceId ?? "";
  if (!isUuid(tenantId) || !isUuid(invoiceId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and invoiceId must be UUIDs."
    );
  }
  const auth = await authorizeRead(request, cookies, tenantId, "invoices");
  if (auth instanceof Response) return auth;
  const rows = await withTargetTenant(tenantId, (tx) =>
    listDunningAttempts(tx, tenantId, invoiceId)
  );
  return new Response(JSON.stringify(successBody({ dunningAttempts: rows })), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

/**
 * `POST` — run a dunning attempt that REQUESTS a lifecycle transition through
 * the #873 contract (operator). Billing never mutates lifecycle state directly.
 */
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const tenantId = params.tenantId ?? "";
  const invoiceId = params.invoiceId ?? "";
  if (!isUuid(tenantId) || !isUuid(invoiceId)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "tenantId and invoiceId must be UUIDs."
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
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const requestedLifecycleState =
    "requestedLifecycleState" in record
      ? record.requestedLifecycleState
      : "past_due";
  const reason = typeof record.reason === "string" ? record.reason : "";
  if (!ALLOWED_STATES.includes(requestedLifecycleState as LifecycleState)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "requestedLifecycleState must be past_due/grace/suspended."
    );
  }
  if (reason.trim().length < 1 || reason.length > 2000) {
    return fail(400, "VALIDATION_ERROR", "reason is required (1..2000 chars).");
  }
  const auth = await authorizeOperator(request, cookies, "dunning", "update");
  if (auth instanceof Response) return auth;

  const correlationId = locals.correlationId;
  const requestHash = computeRequestHash({
    tenantId,
    invoiceId,
    requestedLifecycleState,
    reason
  });

  return runIdempotentBillingMutation(
    tenantId,
    SCOPE,
    idempotencyKey,
    requestHash,
    async (tx) => {
      const result = await runDunningAttempt(
        tx,
        tenantId,
        invoiceId,
        {
          requestedLifecycleState: requestedLifecycleState as LifecycleState,
          reason
        },
        dunningDeps(tx, tenantId),
        { actorTenantUserId: auth.actorTenantUserId, correlationId }
      );
      if (result.ok) {
        return {
          kind: "success",
          status: 200,
          body: successBody({
            attemptId: result.attemptId,
            attemptNo: result.attemptNo,
            requestedLifecycleState: result.requestedLifecycleState,
            lifecycleOutcome: result.lifecycleOutcome
          })
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
