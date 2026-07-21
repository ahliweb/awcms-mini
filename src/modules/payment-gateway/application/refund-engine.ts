/**
 * `payment_gateway` refund engine (Issue #877). Request a refund against a
 * SETTLED intent (mandatory reason + idempotency at the route) and apply the
 * provider RESULT write-once. The provider call is NEVER made here: `requestRefund`
 * commits the local refund row + an OUTBOX row FIRST (ADR-0006); the outbox
 * worker dispatches the provider refund OUTSIDE any transaction and calls
 * `resolveRefundOutcome` with the result. `amount_minor` is EXACT bigint minor
 * units. Idempotent by (intent, provider_refund_ref).
 */
import type { PaymentOutcomePort } from "../../_shared/ports/payment-outcome-port";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  PAYMENT_GATEWAY_REFUND_REQUESTED_EVENT_TYPE,
  PAYMENT_GATEWAY_REFUND_RESOLVED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import { assertSafePositiveMinor } from "../domain/money";
import { maskProviderReference } from "../domain/masking";
import {
  auditPayment,
  buildPaymentEventInput,
  PAYMENT_REFUND_AGGREGATE,
  type EventCtx
} from "./payment-events";
import {
  advanceIntentStatus,
  advanceRefundStatus,
  insertOutbox,
  insertRefund,
  loadIntentForUpdate,
  loadRefundForUpdate,
  sumCountedRefunds,
  type RefundRow
} from "./payment-directory";

export type RefundDto = {
  id: string;
  intentId: string;
  invoiceId: string | null;
  currency: string;
  amountMinor: number;
  status: string;
  version: number;
  providerRefundRef: string | null;
  approvedBy: string | null;
};

export function toRefundDto(row: RefundRow): RefundDto {
  return {
    id: row.id,
    intentId: row.intent_id,
    invoiceId: row.invoice_id,
    currency: row.currency,
    amountMinor: Number(row.amount_minor),
    status: row.status,
    version: Number(row.version),
    providerRefundRef: row.provider_refund_ref,
    approvedBy: row.approved_by
  };
}

export type RequestRefundResult =
  | { ok: true; refund: RefundDto }
  | {
      ok: false;
      reason:
        | "intent_not_found"
        | "not_refundable"
        | "over_refund"
        | "refund_in_progress";
      message: string;
    };

export async function requestRefund(
  tx: Bun.SQL,
  tenantId: string,
  intentId: string,
  command: { amountMinor: number; reason: string },
  ctx: EventCtx
): Promise<RequestRefundResult> {
  const intent = await loadIntentForUpdate(tx, tenantId, intentId);
  if (!intent) {
    return {
      ok: false,
      reason: "intent_not_found",
      message: "Payment intent not found."
    };
  }
  if (intent.status !== "settled") {
    return {
      ok: false,
      reason: "not_refundable",
      message: `Only a settled intent can be refunded (is "${intent.status}").`
    };
  }
  const amount = assertSafePositiveMinor(command.amountMinor, "amountMinor");

  // CUMULATIVE over-refund guard (money integrity). Under the intent's FOR UPDATE
  // lock, sum every refund that already counts against the captured amount (live
  // or succeeded) and reject if THIS refund would push the total past it. Exact
  // BigInt arithmetic — the running total of many bounded `bigint` rows can exceed
  // Number.MAX_SAFE_INTEGER, so a Number() compare could silently round. Partial
  // refunds remain legal (6000 then 4000 against 10000 is fine); an over-amount
  // (6000 then 6000 against 10000) is rejected here BEFORE any insert/dispatch.
  const priorCounted = BigInt(await sumCountedRefunds(tx, tenantId, intentId));
  const capturedMinor = BigInt(intent.amount_minor);
  if (priorCounted + BigInt(amount) > capturedMinor) {
    return {
      ok: false,
      reason: "over_refund",
      message: `Refund ${amount} plus prior refunds ${priorCounted.toString()} exceeds the captured amount ${intent.amount_minor}.`
    };
  }

  const refund = await insertRefund(tx, {
    tenantId,
    intentId,
    invoiceId: intent.invoice_id,
    currency: intent.currency,
    amountMinor: amount,
    reason: command.reason,
    correlationId: ctx.correlationId,
    actor: ctx.actorTenantUserId
  });
  if (!refund) {
    // The partial-unique `(tenant_id, intent_id) WHERE status IN
    // ('requested','approved','pending')` rejected a concurrent LIVE refund — at
    // most one live refund per intent. This is the second racer; it is a clean
    // 409 no-op (no outbox row, no provider call), so the provider is never
    // double-refunded.
    return {
      ok: false,
      reason: "refund_in_progress",
      message: "A refund for this intent is already in progress."
    };
  }

  // Issue #879 (ADR-0022 §5 CRITICAL-1) — MAKER step only. NO outbox dispatch is
  // enqueued here: the provider refund (money-out) is enqueued exclusively by
  // `approveRefund`, performed by a DIFFERENT, high-risk-authorized actor (SoD
  // `payment_gateway.refund_create_vs_approve`). Requesting a refund therefore
  // never moves money on its own.
  await appendDomainEvent(
    tx,
    tenantId,
    buildPaymentEventInput({
      eventType: PAYMENT_GATEWAY_REFUND_REQUESTED_EVENT_TYPE,
      aggregateType: PAYMENT_REFUND_AGGREGATE,
      aggregateId: refund.id,
      aggregateVersion: Number(refund.version),
      payload: {
        refundId: refund.id,
        intentId,
        currency: intent.currency,
        amountMinor: amount
      },
      ctx
    })
  );
  await auditPayment(tx, tenantId, {
    action: "create",
    resourceType: "payment_gateway_refund",
    resourceId: refund.id,
    severity: "warning",
    message: `Refund requested (awaiting a second-actor approval before any dispatch): ${command.reason}`,
    attributes: { intentId, amountMinor: amount, currency: intent.currency },
    ctx
  });

  return { ok: true, refund: toRefundDto(refund) };
}

export type ApproveRefundResult =
  | { ok: true; refund: RefundDto }
  | {
      ok: false;
      reason: "not_found" | "not_approvable";
      message: string;
    };

/**
 * Issue #879 (ADR-0022 §5 CRITICAL-1) — CHECKER step. A DIFFERENT actor than the
 * requester (enforced by the SoD chokepoint at the `approve` high-risk action)
 * transitions a `requested` refund to `approved` and — ONLY THEN — enqueues the
 * provider dispatch (money-out). Idempotent: an already-approved/in-flight refund
 * returns its current state without re-enqueuing.
 */
export async function approveRefund(
  tx: Bun.SQL,
  tenantId: string,
  refundId: string,
  ctx: EventCtx
): Promise<ApproveRefundResult> {
  const refund = await loadRefundForUpdate(tx, tenantId, refundId);
  if (!refund) {
    return { ok: false, reason: "not_found", message: "Refund not found." };
  }
  if (refund.status !== "requested") {
    // Already approved / dispatched / terminal — not re-approvable. An already
    // `approved`+ refund is treated as a clean idempotent no-op success by the
    // route via the idempotency record; here we surface a deterministic 409 for
    // a genuinely non-requested state.
    return {
      ok: false,
      reason: "not_approvable",
      message: `Only a requested refund can be approved (is "${refund.status}").`
    };
  }

  const intent = await loadIntentForUpdate(tx, tenantId, refund.intent_id);
  if (!intent) {
    return {
      ok: false,
      reason: "not_found",
      message: "Payment intent for this refund not found."
    };
  }

  const approved = await advanceRefundStatus(tx, {
    tenantId,
    refundId,
    fromStatus: "requested",
    fromVersion: Number(refund.version),
    toStatus: "approved",
    approvedBy: ctx.actorTenantUserId,
    approvedAt: new Date().toISOString(),
    actor: ctx.actorTenantUserId
  });
  if (!approved) {
    return {
      ok: false,
      reason: "not_approvable",
      message: "This refund was concurrently transitioned out of requested."
    };
  }

  // ONLY NOW is the money-out enqueued (outside any provider call, ADR-0006).
  await insertOutbox(tx, {
    tenantId,
    providerAccountId: intent.provider_account_id,
    intentId: refund.intent_id,
    refundId: refund.id,
    kind: "request_refund",
    payload: {
      refundId: refund.id,
      intentId: refund.intent_id,
      amountMinor: Number(refund.amount_minor),
      currency: refund.currency
    },
    correlationId: ctx.correlationId
  });

  await auditPayment(tx, tenantId, {
    action: "approve",
    resourceType: "payment_gateway_refund",
    resourceId: refund.id,
    severity: "warning",
    message: "Refund approved by a second actor; provider dispatch enqueued.",
    attributes: {
      intentId: refund.intent_id,
      amountMinor: Number(refund.amount_minor),
      currency: refund.currency,
      approvedBy: ctx.actorTenantUserId
    },
    ctx
  });

  return { ok: true, refund: toRefundDto(approved) };
}

/**
 * Apply a provider refund RESULT (from the outbox worker) write-once. Idempotent:
 * a terminal refund (succeeded/failed) is left unchanged. On success it also
 * advances the intent settled -> refunded and (billing wired) back-propagates a
 * reversing reference to the invoice.
 */
export async function resolveRefundOutcome(
  tx: Bun.SQL,
  tenantId: string,
  refundId: string,
  result:
    | { success: true; providerRefundRef: string }
    | { success: false; resultClass: string },
  ctx: EventCtx,
  billing?: PaymentOutcomePort
): Promise<RefundDto | null> {
  const refund = await loadRefundForUpdate(tx, tenantId, refundId);
  if (!refund) return null;
  if (refund.status === "succeeded" || refund.status === "failed") {
    // Idempotent — already resolved.
    return toRefundDto(refund);
  }

  // Ensure we are at `pending` before the terminal step. The outbox dispatch is
  // enqueued only after approval (Issue #879), so the worker sees the refund in
  // `approved`; advance approved -> pending here.
  let current = refund;
  if (current.status === "approved") {
    const pending = await advanceRefundStatus(tx, {
      tenantId,
      refundId,
      fromStatus: "approved",
      fromVersion: Number(current.version),
      toStatus: "pending",
      actor: ctx.actorTenantUserId
    });
    if (!pending) return toRefundDto(current);
    current = pending;
  }

  const terminal = result.success ? "succeeded" : "failed";
  const resolved = await advanceRefundStatus(tx, {
    tenantId,
    refundId,
    fromStatus: "pending",
    fromVersion: Number(current.version),
    toStatus: terminal,
    providerRefundRef: result.success ? result.providerRefundRef : null,
    resultClass: result.success ? "refunded" : result.resultClass,
    resolvedAt: new Date().toISOString(),
    actor: ctx.actorTenantUserId
  });
  if (!resolved) return toRefundDto(current);

  await appendDomainEvent(
    tx,
    tenantId,
    buildPaymentEventInput({
      eventType: PAYMENT_GATEWAY_REFUND_RESOLVED_EVENT_TYPE,
      aggregateType: PAYMENT_REFUND_AGGREGATE,
      aggregateId: refundId,
      aggregateVersion: Number(resolved.version),
      payload: {
        refundId,
        intentId: resolved.intent_id,
        status: terminal,
        providerRefundRef: maskProviderReference(resolved.provider_refund_ref)
      },
      ctx
    })
  );
  await auditPayment(tx, tenantId, {
    action: "update",
    resourceType: "payment_gateway_refund",
    resourceId: refundId,
    severity: "warning",
    message: `Refund resolved: ${terminal}`,
    attributes: {
      intentId: resolved.intent_id,
      status: terminal,
      providerRefundRef: maskProviderReference(resolved.provider_refund_ref)
    },
    ctx
  });

  if (result.success) {
    const intent = await loadIntentForUpdate(tx, tenantId, resolved.intent_id);
    if (intent && intent.status === "settled") {
      await advanceIntentStatus(tx, {
        tenantId,
        intentId: intent.id,
        fromStatus: "settled",
        fromVersion: Number(intent.version),
        toStatus: "refunded",
        actor: ctx.actorTenantUserId
      });
      if (billing) {
        await billing.notifyRefunded({
          invoiceId: intent.invoice_id,
          providerKey: intent.provider_key,
          providerReference: resolved.provider_refund_ref ?? refundId,
          amountMinor: Number(resolved.amount_minor),
          currency: resolved.currency
        });
      }
    }
  }

  return toRefundDto(resolved);
}
