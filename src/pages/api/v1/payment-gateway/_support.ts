/**
 * Composition-root wiring for the `payment_gateway` routes (Issue #877). This
 * leading-underscore, NON-route module is the TRUE composition root the
 * module-boundary/declared-dependency gates deliberately do not scan. It is the
 * ONLY place cross-module concrete code is imported and injected into the payment
 * engines, so the module's own `application`/`domain` never imports another
 * module directly (ADR-0011 / ADR-0022 §4):
 *   - `billing_document_state` (#876) — validate an invoice is payable at
 *     checkout initiation (read-only).
 *   - `payment_outcome` (this module PROVIDES it) — a settled/refunded outcome
 *     is back-propagated to `subscription_billing.recordPaymentAllocation` (the
 *     module's OWN validated, audited, idempotent write path — never a provider
 *     call in a billing transaction). Both OPTIONAL -> a LAN/offline/standalone
 *     deployment that wires neither still records payment state fully.
 *
 * Authorization (ADR-0022 §5/§8): WRITE routes are PLATFORM-operator only,
 * allowed ONLY from the platform (setup singleton) tenant, operating on the
 * TARGET tenant via a per-tenant context (never BYPASSRLS). READ routes allow the
 * platform operator OR the target tenant's OWN user (self-read). The inbound
 * webhook receiver is NOT tenant-JWT authenticated — it is authenticated by the
 * opaque account id + the provider's signature (see the webhook route).
 */
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { fail, jsonResponse } from "../../../../modules/_shared/api-response";
import {
  findIdempotencyRecord,
  replayConcurrentIdempotentWinner,
  saveIdempotencyRecord
} from "../../../../modules/_shared/idempotency";
import {
  authorizeInTransaction,
  resolveAuthInputs
} from "../../../../modules/identity-access/application/access-guard";
import type { AccessAction } from "../../../../modules/identity-access/domain/access-control";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import type { PaymentOutcomePort } from "../../../../modules/_shared/ports/payment-outcome-port";
import type { PaymentEngineDeps } from "../../../../modules/payment-gateway/application/payment-engine";
import { createBillingDocumentStatePort } from "../../../../modules/subscription-billing/application/billing-document-port-adapter";
import { recordPaymentAllocation } from "../../../../modules/subscription-billing/application/invoice-engine";

const MODULE_KEY = "payment_gateway";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Payment engine deps — the OPTIONAL billing read port, bound to the caller's tenant tx. */
export function paymentDeps(tx: Bun.SQL, tenantId: string): PaymentEngineDeps {
  return { billing: createBillingDocumentStatePort(tx, tenantId) };
}

/**
 * The `payment_outcome` adapter this module PROVIDES: forwards a VALIDATED
 * settled/refunded outcome to `subscription_billing`'s own idempotent, audited
 * `recordPaymentAllocation` write path (never a provider call). Bound to the
 * caller's already tenant-scoped `tx`. Best-effort + idempotent: if the billing
 * module is not enabled / the invoice is absent, the allocation is a clean no-op
 * (a LAN/standalone deployment degrades safely).
 */
export function createPaymentOutcomePort(
  tx: Bun.SQL,
  tenantId: string,
  correlationId: string | null
): PaymentOutcomePort {
  return {
    async notifySettled(notice) {
      await recordPaymentAllocation(
        tx,
        tenantId,
        notice.invoiceId,
        {
          allocationSource: "provider",
          providerKey: notice.providerKey,
          providerReference: notice.providerReference,
          amountMinor: notice.amountMinor,
          outcome: "settled",
          markPaid: true,
          reason: "payment_gateway settlement"
        },
        { actorTenantUserId: null, correlationId: correlationId ?? undefined }
      );
    },
    async notifyRefunded(notice) {
      await recordPaymentAllocation(
        tx,
        tenantId,
        notice.invoiceId,
        {
          allocationSource: "provider",
          providerKey: notice.providerKey,
          providerReference: notice.providerReference,
          amountMinor: -notice.amountMinor,
          outcome: "reversed",
          markPaid: false,
          reason: "payment_gateway refund"
        },
        { actorTenantUserId: null, correlationId: correlationId ?? undefined }
      );
    }
  };
}

/**
 * A BINDER the JOB engines (outbox dispatch / reconciliation) call inside each
 * of their own internal transactions to obtain a tx-bound `payment_outcome`
 * adapter — the engines create many short transactions, so a pre-bound port
 * cannot be reused. Wired at the CLI composition root.
 */
export function paymentOutcomeBinder(
  correlationId: string | null
): (tx: Bun.SQL, tenantId: string) => PaymentOutcomePort {
  return (tx, tenantId) =>
    createPaymentOutcomePort(tx, tenantId, correlationId);
}

export type OperatorAuth = { actorTenantUserId: string };

async function readPlatformTenantId(tx: Bun.SQL): Promise<string | null> {
  const rows = (await tx`
    SELECT tenant_id FROM awcms_mini_setup_state WHERE id = true
  `) as { tenant_id: string | null }[];
  return rows[0]?.tenant_id ?? null;
}

export async function authorizeOperator(
  request: Request,
  cookies: import("astro").AstroCookies,
  activityCode: string,
  action: AccessAction
): Promise<OperatorAuth | Response> {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const result = await withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      new Date(),
      {
        moduleKey: MODULE_KEY,
        activityCode,
        action
      }
    );
    if (!auth.allowed) return auth.denied;
    const platformTenantId = await readPlatformTenantId(tx);
    if (!platformTenantId || platformTenantId !== tenantId) {
      return fail(
        403,
        "ACCESS_DENIED",
        "Payment gateway mutations are restricted to the platform operator tenant."
      );
    }
    return { actorTenantUserId: auth.context.tenantUserId };
  });
  return result as OperatorAuth | Response;
}

export async function authorizeRead(
  request: Request,
  cookies: import("astro").AstroCookies,
  targetTenantId: string,
  activityCode: string
): Promise<OperatorAuth | Response> {
  const { tenantId, token } = resolveAuthInputs(request, cookies);
  if (!tenantId)
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  if (!token) return fail(401, "AUTH_REQUIRED", "Authentication required.");
  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const result = await withTenant(sql, tenantId, async (tx) => {
    const auth = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      new Date(),
      {
        moduleKey: MODULE_KEY,
        activityCode,
        action: "read"
      }
    );
    if (!auth.allowed) return auth.denied;
    const platformTenantId = await readPlatformTenantId(tx);
    const isPlatformOperator =
      platformTenantId !== null && platformTenantId === tenantId;
    const isSelf = tenantId === targetTenantId;
    if (!isPlatformOperator && !isSelf) {
      return fail(
        403,
        "ACCESS_DENIED",
        "You may only read your own tenant's payment records."
      );
    }
    return { actorTenantUserId: auth.context.tenantUserId };
  });
  return result as OperatorAuth | Response;
}

export type MutationOutcome =
  | { kind: "success"; status: number; body: unknown }
  | { kind: "conflict"; status: number; body: unknown };

export async function runIdempotentPaymentMutation(
  targetTenantId: string,
  scope: string,
  idempotencyKey: string,
  requestHash: string,
  execute: (tx: Bun.SQL) => Promise<MutationOutcome>
): Promise<Response> {
  const sql = getDatabaseClient();
  return withTenant(sql, targetTenantId, async (tx) => {
    const existing = await findIdempotencyRecord(
      tx,
      targetTenantId,
      scope,
      idempotencyKey
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existing.responseBody, {
        status: existing.responseStatus
      });
    }
    const outcome = await execute(tx);
    if (outcome.kind === "conflict") {
      const replay = await replayConcurrentIdempotentWinner(
        tx,
        targetTenantId,
        scope,
        idempotencyKey,
        requestHash
      );
      if (replay) {
        return jsonResponse(replay.responseBody, {
          status: replay.responseStatus
        });
      }
      return jsonResponse(outcome.body, { status: outcome.status });
    }
    await saveIdempotencyRecord(
      tx,
      targetTenantId,
      scope,
      idempotencyKey,
      requestHash,
      outcome.status,
      outcome.body
    );
    return jsonResponse(outcome.body, { status: outcome.status });
  });
}

export function withTargetTenant<T>(
  targetTenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  const sql = getDatabaseClient();
  return withTenant(sql, targetTenantId, fn);
}

export function successBody(data: unknown): {
  success: true;
  data: unknown;
  meta: Record<string, never>;
} {
  return { success: true, data, meta: {} };
}

export function errorBody(
  code: string,
  message: string
): {
  success: false;
  error: { code: string; message: string };
  meta: Record<string, never>;
} {
  return { success: false, error: { code, message }, meta: {} };
}

/** Map an engine failure reason to an HTTP status + code. */
export function paymentFailureResponse(reason: string): {
  status: number;
  code: string;
} {
  switch (reason) {
    case "account_not_found":
    case "not_found":
    case "intent_not_found":
      return { status: 404, code: "RESOURCE_NOT_FOUND" };
    case "invoice_not_found":
      return { status: 404, code: "INVOICE_NOT_FOUND" };
    case "account_disabled":
      return { status: 409, code: "PAYMENT_ACCOUNT_DISABLED" };
    case "conflict":
      return { status: 409, code: "PAYMENT_CONFLICT" };
    case "illegal_transition":
      return { status: 409, code: "PAYMENT_ILLEGAL_TRANSITION" };
    case "version_conflict":
      return { status: 409, code: "PAYMENT_VERSION_CONFLICT" };
    case "invoice_not_payable":
      return { status: 409, code: "PAYMENT_INVOICE_NOT_PAYABLE" };
    case "currency_mismatch":
      return { status: 409, code: "PAYMENT_CURRENCY_MISMATCH" };
    case "amount_mismatch":
      return { status: 409, code: "PAYMENT_AMOUNT_MISMATCH" };
    case "not_refundable":
      return { status: 409, code: "PAYMENT_NOT_REFUNDABLE" };
    case "over_refund":
      return { status: 409, code: "PAYMENT_OVER_REFUND" };
    default:
      return { status: 400, code: "VALIDATION_ERROR" };
  }
}
