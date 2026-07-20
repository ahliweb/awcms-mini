/**
 * `payment_gateway` intent engine (Issue #877). Initiate a hosted checkout
 * session and cancel/expire a session — all inside the CALLER's already
 * tenant-scoped `tx`. The PROVIDER CALL NEVER happens here: initiate commits the
 * local intent + an OUTBOX row FIRST (ADR-0006), and a worker dispatches the
 * provider call OUTSIDE any transaction. Payment status is never trusted from a
 * browser redirect — an intent leaves `initiated` only via the outbox dispatch
 * result (-> pending) or a verified webhook/reconciliation (-> settled/failed).
 */
import type { BillingDocumentStatePort } from "../../_shared/ports/billing-document-port";
import { assertSafePositiveMinor } from "../domain/money";
import {
  auditPayment,
  emitPaymentEvent,
  PAYMENT_INTENT_AGGREGATE,
  type EventCtx
} from "./payment-events";
import {
  PAYMENT_GATEWAY_INTENT_EXPIRED_EVENT_TYPE,
  PAYMENT_GATEWAY_INTENT_INITIATED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  advanceIntentStatus,
  insertIntent,
  insertOutbox,
  loadIntentForUpdate,
  loadProviderAccount,
  type IntentRow
} from "./payment-directory";

export type IntentDto = {
  id: string;
  providerAccountId: string;
  providerKey: string;
  invoiceId: string;
  subscriptionId: string | null;
  currency: string;
  amountMinor: number;
  status: string;
  version: number;
  providerSessionRef: string | null;
  checkoutUrl: string | null;
  expiresAt: string | null;
};

export function toIntentDto(row: IntentRow): IntentDto {
  return {
    id: row.id,
    providerAccountId: row.provider_account_id,
    providerKey: row.provider_key,
    invoiceId: row.invoice_id,
    subscriptionId: row.subscription_id,
    currency: row.currency,
    amountMinor: Number(row.amount_minor),
    status: row.status,
    version: Number(row.version),
    providerSessionRef: row.provider_session_ref,
    checkoutUrl: row.checkout_url,
    expiresAt: row.expires_at
  };
}

export type PaymentEngineDeps = {
  /** Optional #876 billing read port — validates the invoice is payable + amount/currency match. Absent (LAN/standalone) -> the caller-supplied amount is accepted. */
  billing?: BillingDocumentStatePort;
};

export type InitiateResult =
  | { ok: true; created: boolean; intent: IntentDto }
  | {
      ok: false;
      reason:
        | "account_not_found"
        | "account_disabled"
        | "conflict"
        | "invoice_not_found"
        | "invoice_not_payable"
        | "currency_mismatch"
        | "amount_mismatch";
      message: string;
    };

export async function initiateCheckout(
  tx: Bun.SQL,
  tenantId: string,
  command: {
    providerAccountId: string;
    invoiceId: string;
    subscriptionId: string | null;
    amountMinor: number;
    currency: string;
    expiresAt: string | null;
    reason: string;
  },
  deps: PaymentEngineDeps,
  ctx: EventCtx
): Promise<InitiateResult> {
  const account = await loadProviderAccount(
    tx,
    tenantId,
    command.providerAccountId
  );
  if (!account) {
    return {
      ok: false,
      reason: "account_not_found",
      message: "Provider account not found."
    };
  }
  if (account.status !== "active") {
    return {
      ok: false,
      reason: "account_disabled",
      message: "Provider account is disabled."
    };
  }

  const amount = assertSafePositiveMinor(command.amountMinor, "amountMinor");

  // Validate the invoice is payable through the read-only billing port (when
  // wired). A LAN/standalone deployment with no billing module accepts the
  // caller-supplied amount — but payment status is STILL never browser-trusted.
  if (deps.billing) {
    const invoice = await deps.billing.getInvoice(command.invoiceId);
    if (!invoice) {
      return {
        ok: false,
        reason: "invoice_not_found",
        message: "Invoice not found in the billing plane."
      };
    }
    if (invoice.status !== "issued" || invoice.outstandingMinor <= 0) {
      return {
        ok: false,
        reason: "invoice_not_payable",
        message: `Invoice is "${invoice.status}" with ${invoice.outstandingMinor} outstanding (not payable).`
      };
    }
    if (invoice.currency !== command.currency) {
      return {
        ok: false,
        reason: "currency_mismatch",
        message: `Invoice currency ${invoice.currency} != requested ${command.currency}.`
      };
    }
    if (amount > invoice.outstandingMinor) {
      return {
        ok: false,
        reason: "amount_mismatch",
        message: `Requested ${amount} exceeds outstanding ${invoice.outstandingMinor}.`
      };
    }
  }

  const intent = await insertIntent(tx, {
    tenantId,
    providerAccountId: account.id,
    providerKey: account.provider_key,
    invoiceId: command.invoiceId,
    subscriptionId: command.subscriptionId,
    currency: command.currency,
    amountMinor: amount,
    expiresAt: command.expiresAt,
    reason: command.reason,
    correlationId: ctx.correlationId,
    actor: ctx.actorTenantUserId
  });
  if (!intent) {
    // The live-invoice partial unique collided: a concurrent live charge exists.
    return {
      ok: false,
      reason: "conflict",
      message: "A live payment intent already exists for this invoice."
    };
  }

  // Commit the provider-work OUTBOX row FIRST (ADR-0006) — the provider call is
  // dispatched OUTSIDE any transaction by the outbox worker. No secret in payload.
  await insertOutbox(tx, {
    tenantId,
    providerAccountId: account.id,
    intentId: intent.id,
    refundId: null,
    kind: "create_checkout",
    payload: {
      intentId: intent.id,
      invoiceId: command.invoiceId,
      amountMinor: amount,
      currency: command.currency
    },
    correlationId: ctx.correlationId
  });

  await emitPaymentEvent(tx, tenantId, {
    eventType: PAYMENT_GATEWAY_INTENT_INITIATED_EVENT_TYPE,
    aggregateType: PAYMENT_INTENT_AGGREGATE,
    aggregateId: intent.id,
    aggregateVersion: Number(intent.version),
    payload: {
      intentId: intent.id,
      invoiceId: command.invoiceId,
      providerKey: account.provider_key,
      currency: command.currency,
      amountMinor: amount
    },
    ctx
  });
  await auditPayment(tx, tenantId, {
    action: "create",
    resourceType: "payment_gateway_intent",
    resourceId: intent.id,
    severity: "warning",
    message: `Payment intent initiated (outbox dispatch enqueued): ${command.reason}`,
    attributes: {
      invoiceId: command.invoiceId,
      providerKey: account.provider_key,
      amountMinor: amount,
      currency: command.currency
    },
    ctx
  });

  return { ok: true, created: true, intent: toIntentDto(intent) };
}

export type CancelResult =
  | { ok: true; intent: IntentDto }
  | {
      ok: false;
      reason: "not_found" | "illegal_transition" | "version_conflict";
      message: string;
      current?: IntentDto;
    };

/** Cancel/expire a session (where the provider supports it) — moves a live intent to `expired` deterministically. */
export async function cancelSession(
  tx: Bun.SQL,
  tenantId: string,
  intentId: string,
  command: { reason: string; expectedVersion: number | null },
  ctx: EventCtx
): Promise<CancelResult> {
  const row = await loadIntentForUpdate(tx, tenantId, intentId);
  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      message: "Payment intent not found."
    };
  }
  if (
    command.expectedVersion !== null &&
    command.expectedVersion !== Number(row.version)
  ) {
    return {
      ok: false,
      reason: "version_conflict",
      message: `Intent version is ${row.version}, expected ${command.expectedVersion}.`,
      current: toIntentDto(row)
    };
  }
  if (row.status !== "initiated" && row.status !== "pending") {
    return {
      ok: false,
      reason: "illegal_transition",
      message: `Only an initiated/pending intent can be canceled (is "${row.status}").`,
      current: toIntentDto(row)
    };
  }

  const updated = await advanceIntentStatus(tx, {
    tenantId,
    intentId,
    fromStatus: row.status,
    fromVersion: Number(row.version),
    toStatus: "expired",
    failureClass: "canceled",
    actor: ctx.actorTenantUserId
  });
  if (!updated) {
    return {
      ok: false,
      reason: "version_conflict",
      message: "Intent changed concurrently.",
      current: toIntentDto(row)
    };
  }

  await emitPaymentEvent(tx, tenantId, {
    eventType: PAYMENT_GATEWAY_INTENT_EXPIRED_EVENT_TYPE,
    aggregateType: PAYMENT_INTENT_AGGREGATE,
    aggregateId: intentId,
    aggregateVersion: Number(updated.version),
    payload: {
      intentId,
      providerKey: updated.provider_key,
      priorStatus: row.status,
      reason: "canceled"
    },
    ctx
  });
  await auditPayment(tx, tenantId, {
    action: "cancel",
    resourceType: "payment_gateway_intent",
    resourceId: intentId,
    severity: "warning",
    message: `Payment session canceled (${row.status} -> expired): ${command.reason}`,
    attributes: { priorStatus: row.status, providerKey: updated.provider_key },
    ctx
  });

  return { ok: true, intent: toIntentDto(updated) };
}
