/**
 * `payment_gateway` reconciliation + expire workers (Issue #877, ADR-0022 §9:
 * "reconciliation as the final source of truth"). Reconciliation compares the
 * PROVIDER status (queried OUTSIDE any DB transaction) against LOCAL intent state
 * and closes drift with an audited correction — a webhook is never the ONLY
 * signal, so a provider outage is safe. The expire sweep moves a live intent past
 * its window to `expired` deterministically. Both are per-tenant leased,
 * idempotent, and bounded.
 */
import { withTenant } from "../../../lib/database/tenant-context";
import { fetchActiveTenants } from "../../../lib/jobs/batching";
import type { PaymentOutcomePort } from "../../_shared/ports/payment-outcome-port";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  PAYMENT_GATEWAY_INTENT_EXPIRED_EVENT_TYPE,
  PAYMENT_GATEWAY_INTENT_SETTLED_EVENT_TYPE,
  PAYMENT_GATEWAY_RECONCILIATION_RECORDED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  intentStatusForNormalized,
  isLegalIntentTransition,
  isNormalizedPaymentStatus,
  type PaymentIntentStatus
} from "../domain/payment-state";
import { getPaymentProviderAdapter } from "../infrastructure/adapter-registry";
import { claimLease, releaseLease } from "./payment-lease";
import {
  auditPayment,
  buildPaymentEventInput,
  PAYMENT_INTENT_AGGREGATE,
  type EventCtx
} from "./payment-events";
import {
  advanceIntentStatus,
  insertReconciliation,
  listExpirableIntents,
  listReconcilableIntents,
  loadIntentForUpdate,
  loadProviderAccount,
  type IntentRow
} from "./payment-directory";

export type JobResult = {
  tenantsChecked: number;
  processed: number;
  changed: number;
  tenantsSkipped: number;
};

// -------------------------------------------------------------------------
// Reconciliation
// -------------------------------------------------------------------------

export async function runReconciliation(
  sql: Bun.SQL,
  ctx: { dryRun: boolean; correlationId: string },
  options: { now?: Date; batchLimit?: number; leaseHolder?: string } = {},
  billingFor?: (tx: Bun.SQL, tenantId: string) => PaymentOutcomePort
): Promise<JobResult> {
  const now = options.now ?? new Date();
  const batchLimit = options.batchLimit ?? 50;
  const holder = options.leaseHolder ?? crypto.randomUUID();
  const tenantRows = await fetchActiveTenants(sql);
  const tenants = tenantRows.map((t) => t.id);
  const result: JobResult = {
    tenantsChecked: tenants.length,
    processed: 0,
    changed: 0,
    tenantsSkipped: 0
  };
  if (ctx.dryRun) return result;

  for (const tenantId of tenants) {
    const granted = await withTenant(sql, tenantId, (tx) =>
      claimLease(tx, tenantId, "reconcile", holder, now)
    );
    if (!granted.granted) {
      result.tenantsSkipped += 1;
      continue;
    }
    try {
      // Snapshot the candidate set in a short read tx (session refs + account).
      const candidates = await withTenant(sql, tenantId, (tx) =>
        listReconcilableIntents(tx, tenantId, batchLimit)
      );
      for (const intent of candidates) {
        result.processed += 1;
        const changed = await reconcileOne(
          sql,
          tenantId,
          intent,
          ctx.correlationId,
          billingFor
        );
        if (changed) result.changed += 1;
      }
    } finally {
      await withTenant(sql, tenantId, (tx) =>
        releaseLease(tx, tenantId, "reconcile", holder)
      );
    }
  }
  return result;
}

async function reconcileOne(
  sql: Bun.SQL,
  tenantId: string,
  intent: IntentRow,
  correlationId: string,
  billingFor?: (tx: Bun.SQL, tenantId: string) => PaymentOutcomePort
): Promise<boolean> {
  const ctx: EventCtx = { actorTenantUserId: null, correlationId };
  const account = await withTenant(sql, tenantId, (tx) =>
    loadProviderAccount(tx, tenantId, intent.provider_account_id)
  );
  if (!account || !intent.provider_session_ref) return false;
  const adapter = getPaymentProviderAdapter(account.provider_key);
  if (!adapter) return false;

  // PROVIDER STATUS QUERY — OUTSIDE ANY DB TRANSACTION.
  const providerResult = await adapter.queryStatus({
    intentId: intent.id,
    providerSessionRef: intent.provider_session_ref,
    endpointHost: account.endpoint_host,
    providerAccountRef: account.provider_account_ref
  });

  return withTenant(sql, tenantId, async (tx) => {
    const billing = billingFor ? billingFor(tx, tenantId) : undefined;
    const fresh = await loadIntentForUpdate(tx, tenantId, intent.id);
    if (!fresh) return false;
    const localStatus = fresh.status as PaymentIntentStatus;

    if (!providerResult.ok) {
      await insertReconciliation(tx, {
        tenantId,
        intentId: fresh.id,
        providerStatus: null,
        localStatus,
        outcome: "provider_unavailable",
        detail: `Provider query failed (${providerResult.errorClass})`,
        correlationId,
        actor: null
      });
      return false;
    }

    const providerStatus = providerResult.normalizedStatus;
    const target = isNormalizedPaymentStatus(providerStatus)
      ? intentStatusForNormalized(providerStatus)
      : null;

    // Match (provider agrees, or gives no actionable state).
    if (target === null || target === localStatus) {
      await insertReconciliation(tx, {
        tenantId,
        intentId: fresh.id,
        providerStatus,
        localStatus,
        outcome: "match",
        detail: null,
        correlationId,
        actor: null
      });
      return false;
    }

    // Drift the reconciler can legally CLOSE (e.g. provider settled a locally
    // pending intent whose webhook was lost) — resolve it with an audited change.
    if (isLegalIntentTransition(localStatus, target)) {
      const settledAt = target === "settled" ? new Date().toISOString() : null;
      const updated = await advanceIntentStatus(tx, {
        tenantId,
        intentId: fresh.id,
        fromStatus: localStatus,
        fromVersion: Number(fresh.version),
        toStatus: target,
        settledAt,
        actor: null
      });
      if (!updated) return false;
      await insertReconciliation(tx, {
        tenantId,
        intentId: fresh.id,
        providerStatus,
        localStatus,
        outcome: "mismatch_resolved",
        detail: `${localStatus} -> ${target} from provider`,
        correlationId,
        actor: null
      });
      await appendDomainEvent(
        tx,
        tenantId,
        buildPaymentEventInput({
          eventType:
            target === "settled"
              ? PAYMENT_GATEWAY_INTENT_SETTLED_EVENT_TYPE
              : PAYMENT_GATEWAY_RECONCILIATION_RECORDED_EVENT_TYPE,
          aggregateType: PAYMENT_INTENT_AGGREGATE,
          aggregateId: fresh.id,
          aggregateVersion: Number(updated.version),
          payload: {
            intentId: fresh.id,
            invoiceId: updated.invoice_id,
            providerKey: updated.provider_key,
            currency: updated.currency,
            amountMinor: Number(updated.amount_minor),
            status: target
          },
          ctx
        })
      );
      await auditPayment(tx, tenantId, {
        action: "update",
        resourceType: "payment_gateway_intent",
        resourceId: fresh.id,
        severity: "warning",
        message: `Reconciliation resolved drift ${localStatus} -> ${target}`,
        attributes: { providerStatus, localStatus },
        ctx
      });
      if (target === "settled" && billing) {
        await billing.notifySettled({
          invoiceId: updated.invoice_id,
          providerKey: updated.provider_key,
          providerReference: updated.provider_session_ref ?? fresh.id,
          amountMinor: Number(updated.amount_minor),
          currency: updated.currency
        });
      }
      return true;
    }

    // Drift the reconciler cannot safely close (a regression) -> FLAG for a human.
    await insertReconciliation(tx, {
      tenantId,
      intentId: fresh.id,
      providerStatus,
      localStatus,
      outcome: "mismatch_flagged",
      detail: `Cannot auto-resolve ${localStatus} vs provider ${providerStatus}`,
      correlationId,
      actor: null
    });
    return false;
  });
}

// -------------------------------------------------------------------------
// Expire sweep
// -------------------------------------------------------------------------

export async function runExpireSweep(
  sql: Bun.SQL,
  ctx: { dryRun: boolean; correlationId: string },
  options: { now?: Date; batchLimit?: number; leaseHolder?: string } = {}
): Promise<JobResult> {
  const now = options.now ?? new Date();
  const batchLimit = options.batchLimit ?? 100;
  const holder = options.leaseHolder ?? crypto.randomUUID();
  const tenantRows = await fetchActiveTenants(sql);
  const tenants = tenantRows.map((t) => t.id);
  const result: JobResult = {
    tenantsChecked: tenants.length,
    processed: 0,
    changed: 0,
    tenantsSkipped: 0
  };
  if (ctx.dryRun) return result;

  for (const tenantId of tenants) {
    const granted = await withTenant(sql, tenantId, (tx) =>
      claimLease(tx, tenantId, "expire_sweep", holder, now)
    );
    if (!granted.granted) {
      result.tenantsSkipped += 1;
      continue;
    }
    try {
      await withTenant(sql, tenantId, async (tx) => {
        const expirable = await listExpirableIntents(
          tx,
          tenantId,
          now,
          batchLimit
        );
        for (const intent of expirable) {
          result.processed += 1;
          const updated = await advanceIntentStatus(tx, {
            tenantId,
            intentId: intent.id,
            fromStatus: intent.status,
            fromVersion: Number(intent.version),
            toStatus: "expired",
            failureClass: "window_elapsed",
            actor: null
          });
          if (!updated) continue;
          result.changed += 1;
          await insertReconciliation(tx, {
            tenantId,
            intentId: intent.id,
            providerStatus: null,
            localStatus: "expired",
            outcome: "match",
            detail: "Expired: window elapsed without a settling outcome",
            correlationId: ctx.correlationId,
            actor: null
          });
          await appendDomainEvent(
            tx,
            tenantId,
            buildPaymentEventInput({
              eventType: PAYMENT_GATEWAY_INTENT_EXPIRED_EVENT_TYPE,
              aggregateType: PAYMENT_INTENT_AGGREGATE,
              aggregateId: intent.id,
              aggregateVersion: Number(updated.version),
              payload: {
                intentId: intent.id,
                providerKey: updated.provider_key,
                reason: "window_elapsed"
              },
              ctx: { actorTenantUserId: null, correlationId: ctx.correlationId }
            })
          );
        }
      });
    } finally {
      await withTenant(sql, tenantId, (tx) =>
        releaseLease(tx, tenantId, "expire_sweep", holder)
      );
    }
  }
  return result;
}
