/**
 * The `payment_gateway` outbox dispatch worker (Issue #877, ADR-0006). The
 * PROVIDER CALL happens strictly OUTSIDE any DB transaction: a row is claimed
 * (marked in_flight) in a SHORT transaction, the provider adapter is invoked with
 * NO transaction open, then the result is finalized in ANOTHER short transaction.
 * A provider outage NEVER holds/rolls back a source transaction — it yields
 * bounded retry/backoff, a circuit breaker, and finally the DLQ (`dead`).
 * Multi-worker safe (row-lock + SKIP LOCKED claim + per-tenant lease).
 */
import { withTenant } from "../../../lib/database/tenant-context";
import { fetchActiveTenants } from "../../../lib/jobs/batching";
import type { PaymentOutcomePort } from "../../_shared/ports/payment-outcome-port";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import { PAYMENT_GATEWAY_INTENT_PENDING_EVENT_TYPE } from "../../domain-event-runtime/domain/event-type-registry";
import { isUrlHostAllowed } from "../domain/endpoint-allowlist";
import {
  toProviderErrorClass,
  isRetryableErrorClass
} from "../domain/provider-errors";
import {
  applyHealthFailure,
  applyHealthSuccess,
  isCircuitOpen,
  isExhausted,
  nextAttemptAt,
  type HealthSnapshot
} from "../domain/retry-backoff";
import { maskProviderReference } from "../domain/masking";
import { getPaymentProviderAdapter } from "../infrastructure/adapter-registry";
import { claimLease, releaseLease } from "./payment-lease";
import {
  buildPaymentEventInput,
  PAYMENT_INTENT_AGGREGATE,
  type EventCtx
} from "./payment-events";
import { resolveRefundOutcome } from "./refund-engine";
import {
  advanceIntentStatus,
  claimNextOutbox,
  deferOutboxAttempt,
  finalizeOutbox,
  loadIntentForUpdate,
  loadProviderAccount,
  loadProviderHealth,
  upsertProviderHealth,
  type OutboxRow,
  type ProviderAccountRow
} from "./payment-directory";

export type OutboxDispatchOptions = {
  now?: Date;
  maxPassesPerTenant?: number;
  leaseHolder?: string;
};

export type OutboxDispatchResult = {
  tenantsChecked: number;
  dispatched: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  tenantsSkipped: number;
};

function snapshotFromRow(
  row: {
    state: string;
    consecutive_failures: number;
    consecutive_successes: number;
    circuit_open_until: string | null;
  } | null
): HealthSnapshot {
  if (!row) {
    return {
      state: "up",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      circuitOpenUntil: null
    };
  }
  return {
    state: row.state as HealthSnapshot["state"],
    consecutiveFailures: Number(row.consecutive_failures),
    consecutiveSuccesses: Number(row.consecutive_successes),
    circuitOpenUntil: row.circuit_open_until
      ? new Date(row.circuit_open_until)
      : null
  };
}

export async function runOutboxDispatch(
  sql: Bun.SQL,
  ctx: { dryRun: boolean; correlationId: string },
  options: OutboxDispatchOptions = {},
  billingFor?: (tx: Bun.SQL, tenantId: string) => PaymentOutcomePort
): Promise<OutboxDispatchResult> {
  const now = options.now ?? new Date();
  const maxPasses = options.maxPassesPerTenant ?? 50;
  const holder = options.leaseHolder ?? crypto.randomUUID();

  const tenantRows = await fetchActiveTenants(sql);
  const tenants = tenantRows.map((t) => t.id);
  const result: OutboxDispatchResult = {
    tenantsChecked: tenants.length,
    dispatched: 0,
    succeeded: 0,
    retried: 0,
    deadLettered: 0,
    tenantsSkipped: 0
  };
  if (ctx.dryRun) return result;

  for (const tenantId of tenants) {
    const granted = await withTenant(sql, tenantId, (tx) =>
      claimLease(tx, tenantId, "outbox_dispatch", holder, now)
    );
    if (!granted.granted) {
      result.tenantsSkipped += 1;
      continue;
    }
    try {
      for (let pass = 0; pass < maxPasses; pass += 1) {
        const claimed = await withTenant(sql, tenantId, (tx) =>
          claimNextOutbox(tx, tenantId, holder, now)
        );
        if (!claimed) break;
        result.dispatched += 1;
        const step = await dispatchOne(
          sql,
          tenantId,
          claimed,
          now,
          ctx.correlationId,
          billingFor
        );
        if (step === "succeeded") result.succeeded += 1;
        else if (step === "retried") result.retried += 1;
        else if (step === "dead") result.deadLettered += 1;
      }
    } finally {
      await withTenant(sql, tenantId, (tx) =>
        releaseLease(tx, tenantId, "outbox_dispatch", holder)
      );
    }
  }
  return result;
}

async function dispatchOne(
  sql: Bun.SQL,
  tenantId: string,
  claimed: OutboxRow,
  now: Date,
  correlationId: string,
  billingFor?: (tx: Bun.SQL, tenantId: string) => PaymentOutcomePort
): Promise<"succeeded" | "retried" | "dead" | "skipped"> {
  const ctx: EventCtx = { actorTenantUserId: null, correlationId };

  // Load dispatch context + circuit state in a SHORT read tx (no provider call).
  const context = await withTenant(sql, tenantId, async (tx) => {
    const account = await loadProviderAccount(
      tx,
      tenantId,
      claimed.provider_account_id
    );
    const health = account
      ? await loadProviderHealth(tx, tenantId, account.id, "outbound")
      : null;
    const intent = claimed.intent_id
      ? await loadIntentForUpdate(tx, tenantId, claimed.intent_id)
      : null;
    return {
      account,
      health: snapshotFromRow(health),
      intentSessionRef: intent?.provider_session_ref ?? null,
      intentStatus: intent?.status ?? null
    };
  });
  const account = context.account;
  if (!account) {
    await withTenant(sql, tenantId, (tx) =>
      finalizeOutbox(tx, tenantId, claimed.id, "dead", null, "invalid_request")
    );
    return "dead";
  }

  // Circuit breaker OPEN -> defer this row without a provider call AND WITHOUT
  // consuming a retry attempt. The claim already incremented `attempts`; a
  // circuit-open deferral is not the row's own failure, so `deferOutboxAttempt`
  // hands the attempt back. Otherwise a run of circuit-open passes would both
  // dead-letter the row prematurely and eventually drive `attempts` past
  // `max_attempts` (a CHECK violation on the next claim).
  if (isCircuitOpen(context.health, now)) {
    const retryAt = context.health.circuitOpenUntil ?? now;
    await withTenant(sql, tenantId, (tx) =>
      deferOutboxAttempt(tx, tenantId, claimed.id, retryAt, "unavailable")
    );
    return "retried";
  }

  const adapter = getPaymentProviderAdapter(account.provider_key);
  if (!adapter) {
    await withTenant(sql, tenantId, (tx) =>
      finalizeOutbox(tx, tenantId, claimed.id, "dead", null, "invalid_request")
    );
    return "dead";
  }

  // ============ PROVIDER CALL — OUTSIDE ANY DB TRANSACTION (ADR-0006) ============
  if (claimed.kind === "create_checkout") {
    // SSRF host-equality on the allow-listed endpoint host (defence — the config
    // write path already validated it). A callback URL, when present, is
    // open-redirect-checked by host equality too.
    const hostCheck = isUrlHostAllowed(
      `https://${account.endpoint_host}/`,
      account.endpoint_host
    );
    if (!hostCheck.ok) {
      await withTenant(sql, tenantId, (tx) =>
        finalizeOutbox(
          tx,
          tenantId,
          claimed.id,
          "dead",
          null,
          "invalid_request"
        )
      );
      return "dead";
    }
    const providerResult = await adapter.createCheckoutSession({
      intentId: claimed.intent_id!,
      invoiceId: String(claimed.payload.invoiceId ?? ""),
      amountMinor: Number(claimed.payload.amountMinor ?? 0),
      currency: String(claimed.payload.currency ?? ""),
      endpointHost: account.endpoint_host,
      callbackUrl: account.callback_host
        ? `https://${account.callback_host}/return`
        : null,
      providerAccountRef: account.provider_account_ref
    });
    return finalizeCheckout(
      sql,
      tenantId,
      claimed,
      account,
      providerResult,
      now,
      ctx
    );
  }

  if (claimed.kind === "request_refund") {
    // SSRF host-equality re-check before the provider refund call (uniform with
    // create_checkout — defence in depth so a third-party adapter cannot drift to
    // a non-allow-listed host).
    const refundHostCheck = isUrlHostAllowed(
      `https://${account.endpoint_host}/`,
      account.endpoint_host
    );
    if (!refundHostCheck.ok) {
      await withTenant(sql, tenantId, (tx) =>
        finalizeOutbox(
          tx,
          tenantId,
          claimed.id,
          "dead",
          null,
          "invalid_request"
        )
      );
      return "dead";
    }
    // Refundability RE-CHECK before the provider call: a stale queued refund must
    // NOT fire once the intent has left the refundable (`settled`) state — e.g. a
    // concurrent full refund / reconciliation already moved it to `refunded`. Firing
    // it would double-refund (money loss). Dead-letter it WITHOUT a provider call.
    if (context.intentStatus !== "settled") {
      await withTenant(sql, tenantId, (tx) =>
        finalizeOutbox(tx, tenantId, claimed.id, "dead", null, "not_refundable")
      );
      return "dead";
    }
    const providerResult = await adapter.requestRefund({
      intentId: claimed.intent_id!,
      refundId: claimed.refund_id!,
      amountMinor: Number(claimed.payload.amountMinor ?? 0),
      currency: String(claimed.payload.currency ?? ""),
      providerSessionRef: context.intentSessionRef ?? "",
      endpointHost: account.endpoint_host,
      providerAccountRef: account.provider_account_ref
    });
    return finalizeRefundDispatch(
      sql,
      tenantId,
      claimed,
      account,
      providerResult,
      now,
      ctx,
      billingFor
    );
  }

  // Unknown/unsupported kind -> DLQ (should not happen; CHECK-constrained).
  await withTenant(sql, tenantId, (tx) =>
    finalizeOutbox(tx, tenantId, claimed.id, "dead", null, "invalid_request")
  );
  return "dead";
}

async function finalizeCheckout(
  sql: Bun.SQL,
  tenantId: string,
  claimed: OutboxRow,
  account: ProviderAccountRow,
  providerResult: Awaited<
    ReturnType<
      import("../domain/provider-adapter").PaymentProviderAdapter["createCheckoutSession"]
    >
  >,
  now: Date,
  ctx: EventCtx
): Promise<"succeeded" | "retried" | "dead"> {
  return withTenant(sql, tenantId, async (tx) => {
    if (providerResult.ok) {
      const intent = claimed.intent_id
        ? await loadIntentForUpdate(tx, tenantId, claimed.intent_id)
        : null;
      if (intent && intent.status === "initiated") {
        const updated = await advanceIntentStatus(tx, {
          tenantId,
          intentId: intent.id,
          fromStatus: "initiated",
          fromVersion: Number(intent.version),
          toStatus: "pending",
          providerSessionRef: providerResult.providerSessionRef,
          checkoutUrl: providerResult.checkoutUrl,
          actor: null
        });
        if (updated) {
          await appendDomainEvent(
            tx,
            tenantId,
            buildPaymentEventInput({
              eventType: PAYMENT_GATEWAY_INTENT_PENDING_EVENT_TYPE,
              aggregateType: PAYMENT_INTENT_AGGREGATE,
              aggregateId: intent.id,
              aggregateVersion: Number(updated.version),
              payload: {
                intentId: intent.id,
                providerKey: updated.provider_key,
                providerSessionRef: maskProviderReference(
                  updated.provider_session_ref
                )
              },
              ctx
            })
          );
        }
      }
      await applyHealthAndFinalizeSuccess(tx, tenantId, account.id, claimed.id);
      return "succeeded";
    }
    return applyFailure(
      tx,
      tenantId,
      account.id,
      claimed,
      now,
      providerResult.errorClass
    );
  });
}

async function finalizeRefundDispatch(
  sql: Bun.SQL,
  tenantId: string,
  claimed: OutboxRow,
  account: ProviderAccountRow,
  providerResult: Awaited<
    ReturnType<
      import("../domain/provider-adapter").PaymentProviderAdapter["requestRefund"]
    >
  >,
  now: Date,
  ctx: EventCtx,
  billingFor?: (tx: Bun.SQL, tenantId: string) => PaymentOutcomePort
): Promise<"succeeded" | "retried" | "dead"> {
  return withTenant(sql, tenantId, async (tx) => {
    const billing = billingFor ? billingFor(tx, tenantId) : undefined;
    if (providerResult.ok) {
      if (claimed.refund_id) {
        await resolveRefundOutcome(
          tx,
          tenantId,
          claimed.refund_id,
          {
            success: true,
            providerRefundRef: providerResult.providerRefundRef
          },
          ctx,
          billing
        );
      }
      await applyHealthAndFinalizeSuccess(tx, tenantId, account.id, claimed.id);
      return "succeeded";
    }
    // A terminal DECLINE resolves the refund as failed (write-once); a transient
    // failure is retried/backed off without resolving the refund.
    const cls = toProviderErrorClass(providerResult.errorClass);
    if (!isRetryableErrorClass(cls) && claimed.refund_id) {
      await resolveRefundOutcome(
        tx,
        tenantId,
        claimed.refund_id,
        { success: false, resultClass: cls },
        ctx,
        billing
      );
    }
    return applyFailure(tx, tenantId, account.id, claimed, now, cls);
  });
}

async function applyHealthAndFinalizeSuccess(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  outboxId: string
): Promise<void> {
  const current = snapshotFromRow(
    await loadProviderHealth(tx, tenantId, accountId, "outbound")
  );
  const next = applyHealthSuccess(current);
  await upsertProviderHealth(tx, {
    tenantId,
    accountId,
    direction: "outbound",
    state: next.state,
    consecutiveFailures: next.consecutiveFailures,
    consecutiveSuccesses: next.consecutiveSuccesses,
    circuitOpenUntil: next.circuitOpenUntil
      ? next.circuitOpenUntil.toISOString()
      : null,
    success: true
  });
  await finalizeOutbox(tx, tenantId, outboxId, "succeeded", null, null);
}

async function applyFailure(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  claimed: OutboxRow,
  now: Date,
  errorClass: string
): Promise<"retried" | "dead"> {
  const cls = toProviderErrorClass(errorClass);
  const current = snapshotFromRow(
    await loadProviderHealth(tx, tenantId, accountId, "outbound")
  );
  const next = applyHealthFailure(current, now);
  await upsertProviderHealth(tx, {
    tenantId,
    accountId,
    direction: "outbound",
    state: next.state,
    consecutiveFailures: next.consecutiveFailures,
    consecutiveSuccesses: next.consecutiveSuccesses,
    circuitOpenUntil: next.circuitOpenUntil
      ? next.circuitOpenUntil.toISOString()
      : null,
    success: false
  });

  const exhausted = isExhausted(
    Number(claimed.attempts),
    Number(claimed.max_attempts)
  );
  if (!isRetryableErrorClass(cls) || exhausted) {
    await finalizeOutbox(tx, tenantId, claimed.id, "dead", null, cls);
    return "dead";
  }
  await finalizeOutbox(
    tx,
    tenantId,
    claimed.id,
    "failed",
    nextAttemptAt(now, Number(claimed.attempts)),
    cls
  );
  return "retried";
}
