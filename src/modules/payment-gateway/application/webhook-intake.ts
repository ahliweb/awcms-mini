/**
 * The REAL inbound signed-webhook write path for `payment_gateway` (Issue #877,
 * ADR-0022 §9). Called by `POST /api/v1/payment-gateway/webhook/{providerAccountId}`
 * — the ONLY caller. Every step runs inside the SAME tenant-scoped transaction as
 * the eventual state change + normalized event, so a verified delivery and its
 * effect commit atomically (or neither does).
 *
 * FAIL-CLOSED, in order: (0) tenant/account active; (1) body size; (2) secret
 * resolvable; (3) adapter known; (4) signature + freshness + account BINDING +
 * event-id — the adapter's `verifyWebhook`. A VALID delivery updates payment
 * EXACTLY ONCE: the DURABLE (DB-persisted) anti-replay identity
 * `(tenant, account, provider_event_id)` makes a replay a clean no-op across
 * restarts/replicas (never an in-memory cache, ADR-0022 §9). An out-of-order or
 * terminal event never REGRESSES state — it records reconciliation evidence
 * instead (deterministic safe state). Payment status is NEVER trusted from a
 * browser redirect — only from a delivery that clears ALL gates here.
 */
import { createHash } from "node:crypto";
import type { PaymentOutcomePort } from "../../_shared/ports/payment-outcome-port";
import {
  PAYMENT_GATEWAY_INTENT_FAILED_EVENT_TYPE,
  PAYMENT_GATEWAY_INTENT_SETTLED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  intentStatusForNormalized,
  isLegalIntentTransition,
  type NormalizedPaymentStatus,
  type PaymentIntentStatus
} from "../domain/payment-state";
import { isBodyWithinLimit } from "../domain/webhook-security";
import { buildMaskedSnippet, maskProviderReference } from "../domain/masking";
import { resolveSecretRef } from "../domain/secret-ref";
import { getPaymentProviderAdapter } from "../infrastructure/adapter-registry";
import {
  auditPayment,
  emitPaymentEvent,
  PAYMENT_INTENT_AGGREGATE,
  type EventCtx
} from "./payment-events";
import {
  advanceIntentStatus,
  bumpIntentEventSequence,
  insertNormalizedEvent,
  insertProcessingAttempt,
  insertReconciliation,
  insertRejectedWebhookDelivery,
  insertWebhookDelivery,
  loadIntentBySession,
  markWebhookNormalized,
  type ProviderAccountLookupRow
} from "./payment-directory";

export type ProcessWebhookParams = {
  account: ProviderAccountLookupRow;
  rawBody: string;
  headers: Readonly<Record<string, string>>;
  contentType: string | null;
  now: Date;
  correlationId: string;
  /** Optional billing outcome notifier (wired at the composition root). Absent -> settlement is recorded in payment_gateway only (LAN/standalone). */
  billing?: PaymentOutcomePort;
};

export type ProcessWebhookResult =
  | { outcome: "accepted_new"; appliedStatus: string | null }
  | { outcome: "accepted_duplicate" }
  | { outcome: "rejected"; httpStatus: number; code: string; reason: string };

function randomEventId(): string {
  return crypto.randomUUID();
}

export async function processInboundPaymentWebhook(
  tx: Bun.SQL,
  params: ProcessWebhookParams
): Promise<ProcessWebhookResult> {
  const { account, rawBody, headers, contentType, now, correlationId } = params;
  const tenantId = account.tenant_id;
  const accountId = account.provider_account_id;
  const rawBodySha256 = createHash("sha256").update(rawBody).digest("hex");
  const rawBodySize = Buffer.byteLength(rawBody, "utf8");
  const ctx: EventCtx = { actorTenantUserId: null, correlationId };

  const reject = async (
    reason: string,
    httpStatus: number,
    code: string
  ): Promise<ProcessWebhookResult> => {
    await insertRejectedWebhookDelivery(tx, {
      tenantId,
      providerAccountId: accountId,
      providerKey: account.provider_key,
      freshEventId: randomEventId(),
      reason,
      contentType,
      rawBodySha256,
      rawBodySize,
      correlationId
    });
    return { outcome: "rejected", httpStatus, code, reason };
  };

  // (0) tenant + account must be active (fail-closed).
  if (account.tenant_status !== "active") {
    return reject("tenant_inactive", 403, "ENDPOINT_NOT_ACCEPTING_TRAFFIC");
  }
  if (account.account_status !== "active") {
    return reject("account_disabled", 403, "ENDPOINT_NOT_ACCEPTING_TRAFFIC");
  }

  // (1) payload size guard.
  if (!isBodyWithinLimit(rawBodySize, account.max_webhook_body_bytes)) {
    return reject("body_too_large", 413, "PAYLOAD_TOO_LARGE");
  }

  // (2) resolve the signing secret POINTER against process.env — never persisted.
  const secret = resolveSecretRef(account.signing_secret_ref);
  if (!secret.ok) {
    return reject("secret_unresolvable", 500, "INTERNAL_ERROR");
  }

  // (3) known adapter for this provider.
  const adapter = getPaymentProviderAdapter(account.provider_key);
  if (!adapter) {
    return reject("unknown_adapter", 400, "UNKNOWN_ADAPTER");
  }

  // (4) signature + freshness + account BINDING + event-id — fail-closed.
  const verification = adapter.verifyWebhook({
    rawBody,
    headers,
    secret: secret.value,
    toleranceSeconds: account.webhook_tolerance_seconds,
    now,
    expectedAccountRef: account.provider_account_ref
  });
  if (!verification.valid) {
    return reject(verification.reason, 401, "SIGNATURE_VERIFICATION_FAILED");
  }

  // Persist the VERIFIED delivery — the DURABLE anti-replay identity. A replay
  // collides on the unique (tenant, account, provider_event_id) and is a clean
  // no-op (accepted_duplicate) — exactly-once.
  const delivery = await insertWebhookDelivery(tx, {
    tenantId,
    providerAccountId: accountId,
    providerKey: account.provider_key,
    providerEventId: verification.providerEventId,
    eventTimestampSeconds: Number(verification.timestampSeconds),
    contentType,
    rawBodySha256,
    rawBodySize,
    maskedSnippet: buildMaskedSnippet(rawBody),
    correlationId
  });
  if (!delivery) {
    return { outcome: "accepted_duplicate" };
  }

  // Resolve the target intent by the provider session reference (locked).
  const intent = verification.providerSessionRef
    ? await loadIntentBySession(
        tx,
        tenantId,
        accountId,
        verification.providerSessionRef
      )
    : null;

  const normalizedEvent = await insertNormalizedEvent(tx, {
    tenantId,
    webhookInboxId: delivery.id,
    intentId: intent?.id ?? null,
    providerKey: account.provider_key,
    providerSessionRef: verification.providerSessionRef,
    normalizedStatus: verification.normalizedStatus,
    providerStatusRaw: verification.providerStatusRaw,
    providerSequence: verification.providerSequence,
    currency: verification.currency,
    amountMinor: verification.amountMinor,
    correlationId
  });
  await markWebhookNormalized(tx, tenantId, delivery.id, normalizedEvent.id);

  const appliedStatus = await applyNormalizedEventToIntent(tx, tenantId, {
    normalizedEventId: normalizedEvent.id,
    intent,
    normalizedStatus: verification.normalizedStatus as NormalizedPaymentStatus,
    providerSequence: verification.providerSequence,
    ctx,
    billing: params.billing,
    account
  });

  return { outcome: "accepted_new", appliedStatus };
}

/**
 * Apply a normalized event to its intent EXACTLY ONCE, safely handling
 * out-of-order/duplicate/terminal deliveries (never a regression). Records a
 * processing attempt for every outcome — the deterministic-safe-state evidence
 * trail. On a legal advance to settled/failed, emits the versioned event + audit
 * and (settled + billing wired) back-propagates the outcome to the invoice.
 */
async function applyNormalizedEventToIntent(
  tx: Bun.SQL,
  tenantId: string,
  input: {
    normalizedEventId: string;
    intent: Awaited<ReturnType<typeof loadIntentBySession>>;
    normalizedStatus: NormalizedPaymentStatus;
    providerSequence: number;
    ctx: EventCtx;
    billing?: PaymentOutcomePort;
    account: ProviderAccountLookupRow;
  }
): Promise<string | null> {
  const { intent, normalizedStatus, providerSequence, ctx } = input;

  if (!intent) {
    await insertProcessingAttempt(tx, {
      tenantId,
      normalizedEventId: input.normalizedEventId,
      intentId: null,
      outcome: "ignored_unknown_intent",
      fromStatus: null,
      toStatus: null,
      detail: `No intent for session; status=${normalizedStatus}`,
      correlationId: ctx.correlationId
    });
    return null;
  }

  const currentStatus = intent.status as PaymentIntentStatus;
  const targetStatus = intentStatusForNormalized(normalizedStatus);

  // A pending/unknown event carries no state change — record + bump sequence.
  if (targetStatus === null) {
    await bumpIntentEventSequence(tx, tenantId, intent.id, providerSequence);
    await insertProcessingAttempt(tx, {
      tenantId,
      normalizedEventId: input.normalizedEventId,
      intentId: intent.id,
      outcome: "ignored_duplicate",
      fromStatus: currentStatus,
      toStatus: null,
      detail: `No-op status ${normalizedStatus}`,
      correlationId: ctx.correlationId
    });
    return null;
  }

  // Out-of-order guard: an event with a stale sequence relative to the last
  // applied one is not applied (deterministic safe state).
  if (
    providerSequence > 0 &&
    providerSequence < Number(intent.last_event_sequence)
  ) {
    await insertReconciliation(tx, {
      tenantId,
      intentId: intent.id,
      providerStatus: normalizedStatus,
      localStatus: currentStatus,
      outcome: "mismatch_flagged",
      detail: `Out-of-order event seq ${providerSequence} < applied ${intent.last_event_sequence}`,
      correlationId: ctx.correlationId,
      actor: null
    });
    await insertProcessingAttempt(tx, {
      tenantId,
      normalizedEventId: input.normalizedEventId,
      intentId: intent.id,
      outcome: "ignored_out_of_order",
      fromStatus: currentStatus,
      toStatus: null,
      detail: `seq ${providerSequence} < ${intent.last_event_sequence}`,
      correlationId: ctx.correlationId
    });
    return null;
  }

  // A regression / terminal-state event is never applied; it becomes evidence.
  if (!isLegalIntentTransition(currentStatus, targetStatus)) {
    const matched = currentStatus === targetStatus;
    await insertReconciliation(tx, {
      tenantId,
      intentId: intent.id,
      providerStatus: normalizedStatus,
      localStatus: currentStatus,
      outcome: matched ? "match" : "mismatch_flagged",
      detail: matched
        ? `Provider re-confirmed ${currentStatus}`
        : `Illegal/late transition ${currentStatus} -> ${targetStatus}`,
      correlationId: ctx.correlationId,
      actor: null
    });
    await insertProcessingAttempt(tx, {
      tenantId,
      normalizedEventId: input.normalizedEventId,
      intentId: intent.id,
      outcome: "ignored_terminal",
      fromStatus: currentStatus,
      toStatus: null,
      detail: `${currentStatus} -> ${targetStatus} not legal`,
      correlationId: ctx.correlationId
    });
    return null;
  }

  // Legal advance — apply EXACTLY ONCE.
  const settledAt =
    targetStatus === "settled" ? new Date().toISOString() : null;
  const updated = await advanceIntentStatus(tx, {
    tenantId,
    intentId: intent.id,
    fromStatus: currentStatus,
    fromVersion: Number(intent.version),
    toStatus: targetStatus,
    failureClass: targetStatus === "failed" ? "provider_failed" : null,
    eventSequence: providerSequence,
    settledAt,
    actor: null
  });
  if (!updated) {
    // A concurrent processor already advanced it — safe no-op (exactly-once).
    await insertProcessingAttempt(tx, {
      tenantId,
      normalizedEventId: input.normalizedEventId,
      intentId: intent.id,
      outcome: "ignored_duplicate",
      fromStatus: currentStatus,
      toStatus: null,
      detail: "Concurrent advance",
      correlationId: ctx.correlationId
    });
    return null;
  }

  await insertProcessingAttempt(tx, {
    tenantId,
    normalizedEventId: input.normalizedEventId,
    intentId: intent.id,
    outcome: "applied",
    fromStatus: currentStatus,
    toStatus: targetStatus,
    detail: null,
    correlationId: ctx.correlationId
  });

  await emitPaymentEvent(tx, tenantId, {
    eventType:
      targetStatus === "settled"
        ? PAYMENT_GATEWAY_INTENT_SETTLED_EVENT_TYPE
        : PAYMENT_GATEWAY_INTENT_FAILED_EVENT_TYPE,
    aggregateType: PAYMENT_INTENT_AGGREGATE,
    aggregateId: intent.id,
    aggregateVersion: Number(updated.version),
    payload: {
      intentId: intent.id,
      invoiceId: updated.invoice_id,
      providerKey: updated.provider_key,
      currency: updated.currency,
      amountMinor: Number(updated.amount_minor),
      status: targetStatus
    },
    ctx
  });
  await auditPayment(tx, tenantId, {
    action: "update",
    resourceType: "payment_gateway_intent",
    resourceId: intent.id,
    severity: "warning",
    message: `Payment intent ${currentStatus} -> ${targetStatus} from a verified signed webhook`,
    attributes: {
      invoiceId: updated.invoice_id,
      providerKey: updated.provider_key,
      providerSessionRef: maskProviderReference(updated.provider_session_ref),
      amountMinor: Number(updated.amount_minor),
      currency: updated.currency
    },
    ctx
  });

  // Back-propagate a settlement to the billing invoice (validated outcome only).
  if (targetStatus === "settled" && input.billing) {
    await input.billing.notifySettled({
      invoiceId: updated.invoice_id,
      providerKey: updated.provider_key,
      providerReference: updated.provider_session_ref ?? intent.id,
      amountMinor: Number(updated.amount_minor),
      currency: updated.currency
    });
  }

  return targetStatus;
}
