/**
 * `subscription_billing` invoice engine (Issue #876, epic #868). The commercial
 * document lifecycle: IDEMPOTENT draft generation, issue, void, credit note,
 * and payment-allocation recording — all inside the CALLER's already
 * tenant-scoped `tx`, committing the document change + append-only history +
 * versioned event + audit atomically.
 *
 * Idempotent generation (AC "at most one invoice per period under concurrent
 * workers"): the subscription is row-locked (`FOR UPDATE`) so all generation for
 * a subscription serializes, the period is the STABLE anchor (found by start,
 * else created), and `insertDraftInvoice` uses the partial UNIQUE
 * (subscription_id, period_id) WHERE status<>'void' as a hard backstop — a
 * second worker collides and reads the existing winner.
 *
 * Money is EXACT minor units through `domain/money.ts` (BigInt, mutation-tested
 * against floats/overflow); an invoice is SINGLE-CURRENCY (the subscription
 * currency; a usage/catalog component in another currency is refused).
 * Correction is a credit note or a void — an ISSUED invoice is never edited.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  SUBSCRIPTION_BILLING_EVENT_VERSION,
  SUBSCRIPTION_BILLING_INVOICE_CREDITED_EVENT_TYPE,
  SUBSCRIPTION_BILLING_INVOICE_ISSUED_EVENT_TYPE,
  SUBSCRIPTION_BILLING_INVOICE_PAID_EVENT_TYPE,
  SUBSCRIPTION_BILLING_INVOICE_VOIDED_EVENT_TYPE,
  SUBSCRIPTION_BILLING_PAYMENT_RECORDED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import type { ServiceCatalogReadPort } from "../../_shared/ports/service-catalog-read-port";
import type { UsageAggregatePort } from "../../_shared/ports/usage-aggregate-port";
import {
  isLegalInvoiceTransition,
  type InvoiceStatus
} from "../domain/invoice-state";
import { assertSafeMinor, multiplyMinor, sumMinor } from "../domain/money";
import type { ActionContext } from "./subscription-engine";
import {
  addInvoiceAllocated,
  addInvoiceCredited,
  advanceInvoiceStatus,
  appendInvoiceStatusHistory,
  ensurePeriod,
  findPeriodByStart,
  getLiveInvoiceForPeriod,
  insertCreditNote,
  insertDraftInvoice,
  insertInvoiceLine,
  insertPaymentAllocation,
  latestPeriodSequence,
  loadInvoiceForUpdate,
  loadSubscriptionForUpdate,
  markPeriodInvoiced,
  setDraftInvoiceTotals,
  type InvoiceLineInput,
  type InvoiceRow,
  type SubscriptionRow
} from "./billing-directory";
import { isBillableSubscriptionState } from "../domain/subscription-state";
import { nextPeriodEnd, type BillingInterval } from "../domain/period";

const MODULE_KEY = "subscription_billing";
const AGGREGATE_TYPE = "subscription_billing_invoice";

export type InvoiceEngineDeps = {
  catalog: ServiceCatalogReadPort;
  /** Optional #875 usage port. Absent (LAN/offline) -> usage lines are skipped. */
  usage?: UsageAggregatePort;
};

export type InvoiceDto = {
  id: string;
  subscriptionId: string;
  periodId: string | null;
  offerVersion: number;
  invoiceNumber: string | null;
  status: InvoiceStatus;
  currency: string;
  roundingMode: string;
  subtotalMinor: number;
  totalMinor: number;
  creditedMinor: number;
  allocatedMinor: number;
  outstandingMinor: number;
  version: number;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
};

export function toInvoiceDto(row: InvoiceRow): InvoiceDto {
  const total = Number(row.total_minor);
  const credited = Number(row.credited_minor);
  const allocated = Number(row.allocated_minor);
  const outstanding = Math.max(0, total - credited - allocated);
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    periodId: row.period_id,
    offerVersion: Number(row.offer_version),
    invoiceNumber: row.invoice_number,
    status: row.status,
    currency: row.currency,
    roundingMode: row.rounding_mode,
    subtotalMinor: Number(row.subtotal_minor),
    totalMinor: total,
    creditedMinor: credited,
    allocatedMinor: allocated,
    outstandingMinor: outstanding,
    version: Number(row.version),
    issuedAt: row.issued_at,
    dueAt: row.due_at,
    paidAt: row.paid_at
  };
}

// -------------------------------------------------------------------------
// Draft generation (idempotent)
// -------------------------------------------------------------------------

export type GenerateResult =
  | { ok: true; created: boolean; invoice: InvoiceDto }
  | {
      ok: false;
      reason:
        "not_found" | "not_billable" | "offer_not_found" | "currency_mismatch";
      message: string;
    };

export async function generateInvoiceDraft(
  tx: Bun.SQL,
  tenantId: string,
  subscriptionId: string,
  command: { includeUsage: boolean; dueInDays: number | null; reason: string },
  deps: InvoiceEngineDeps,
  ctx: ActionContext,
  now: Date = new Date()
): Promise<GenerateResult> {
  const sub = await loadSubscriptionForUpdate(tx, tenantId, subscriptionId);
  if (!sub) {
    return {
      ok: false,
      reason: "not_found",
      message: "Subscription not found."
    };
  }
  if (!isBillableSubscriptionState(sub.state)) {
    return {
      ok: false,
      reason: "not_billable",
      message: `Subscription in state "${sub.state}" is not billable.`
    };
  }

  // Stable period anchor (idempotent): reuse the current period, else create it.
  const periodStart = sub.current_period_start ?? now.toISOString();
  const periodEnd =
    sub.current_period_end ??
    nextPeriodEnd(
      new Date(periodStart),
      sub.billing_interval as BillingInterval
    ).toISOString();

  let period = await findPeriodByStart(
    tx,
    tenantId,
    subscriptionId,
    periodStart
  );
  if (!period) {
    const sequence =
      (await latestPeriodSequence(tx, tenantId, subscriptionId)) + 1;
    period = await ensurePeriod(tx, {
      tenantId,
      subscriptionId,
      sequence,
      periodStart,
      periodEnd,
      offerVersion: Number(sub.offer_version),
      actor: ctx.actorTenantUserId
    });
  }

  // Idempotent insert: a concurrent worker collides on the partial unique index.
  const inserted = await insertDraftInvoice(tx, {
    tenantId,
    subscriptionId,
    periodId: period.id,
    offerVersion: Number(sub.offer_version),
    currency: sub.currency,
    roundingMode: sub.rounding_mode,
    billingContactRef: sub.billing_contact_ref,
    actor: ctx.actorTenantUserId
  });
  if (!inserted) {
    const existing = await getLiveInvoiceForPeriod(
      tx,
      tenantId,
      subscriptionId,
      period.id
    );
    if (existing) {
      return { ok: true, created: false, invoice: toInvoiceDto(existing) };
    }
    // Extremely unlikely (a void-only row): fall through and refuse rather than
    // create a duplicate.
    return {
      ok: false,
      reason: "not_billable",
      message: "Invoice generation raced and no live invoice is present."
    };
  }

  // Build lines from the immutable published offer + usage aggregates.
  const linesResult = await buildInvoiceLines(
    tx,
    tenantId,
    sub,
    period,
    command.includeUsage,
    deps
  );
  if (!linesResult.ok) {
    return linesResult;
  }
  for (const line of linesResult.lines) {
    await insertInvoiceLine(
      tx,
      tenantId,
      inserted.id,
      line,
      ctx.actorTenantUserId
    );
  }
  const subtotal = sumMinor(linesResult.lines.map((l) => l.amountMinor));
  await setDraftInvoiceTotals(tx, tenantId, inserted.id, subtotal, subtotal);

  const draft = (await loadInvoiceForUpdate(tx, tenantId, inserted.id))!;

  await appendInvoiceStatusHistory(tx, {
    tenantId,
    invoiceId: inserted.id,
    fromStatus: null,
    toStatus: "draft",
    version: Number(draft.version),
    reason: command.reason,
    source: "system",
    actor: ctx.actorTenantUserId,
    correlationId: ctx.correlationId ?? null
  });
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "subscription_billing_invoice",
    resourceId: inserted.id,
    severity: "info",
    message: `Invoice draft generated for period ${period.sequence}: ${command.reason}`,
    attributes: {
      subscriptionId,
      periodId: period.id,
      subtotalMinor: subtotal,
      currency: sub.currency,
      lineCount: linesResult.lines.length
    },
    correlationId: ctx.correlationId
  });

  return { ok: true, created: true, invoice: toInvoiceDto(draft) };
}

/**
 * Derive the invoice lines from the published offer (recurring components) and,
 * when a usage port is wired, the #875 usage aggregates (metered lines). Every
 * amount goes through the EXACT money helpers; a component in a currency other
 * than the subscription currency is refused (single-currency invoice).
 */
/**
 * The meter key a price component bills usage for, or `null` if it is a flat
 * recurring component. Preferred: an explicit `metadata.meterKey` string;
 * legacy fallback: a `usage_<meter_with_underscores>` componentKey (underscores
 * map to dots). Keeping the meter key in metadata avoids a lossy componentKey
 * round-trip.
 */
function usageMeterKeyOf(price: {
  componentKey: string;
  metadata: Record<string, unknown>;
}): string | null {
  const fromMeta = price.metadata?.meterKey;
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  if (price.componentKey.startsWith("usage_")) {
    return price.componentKey.slice("usage_".length).replace(/_/g, ".");
  }
  return null;
}

async function buildInvoiceLines(
  tx: Bun.SQL,
  tenantId: string,
  sub: SubscriptionRow,
  period: { id: string; period_start: string; period_end: string },
  includeUsage: boolean,
  deps: InvoiceEngineDeps
): Promise<
  | { ok: true; lines: InvoiceLineInput[] }
  | {
      ok: false;
      reason: "offer_not_found" | "currency_mismatch";
      message: string;
    }
> {
  const offer = await deps.catalog.getPublishedOffer(
    sub.offer_plan_key,
    Number(sub.offer_version)
  );
  if (!offer) {
    return {
      ok: false,
      reason: "offer_not_found",
      message: `Bound offer ${sub.offer_plan_key}@v${sub.offer_version} is no longer readable.`
    };
  }

  const lines: InvoiceLineInput[] = [];
  let lineNo = 1;

  for (const price of offer.prices) {
    // Usage-priced components (a `metadata.meterKey` string, or the legacy
    // `usage_` componentKey prefix) are billed from the metered aggregate, not
    // as a flat recurring line.
    if (usageMeterKeyOf(price) !== null) continue;
    if (price.currency !== sub.currency) {
      return {
        ok: false,
        reason: "currency_mismatch",
        message: `Offer component ${price.componentKey} currency ${price.currency} != subscription currency ${sub.currency} (single-currency invoice).`
      };
    }
    const amount = assertSafeMinor(
      price.amountMinor,
      "offer price amountMinor"
    );
    lines.push({
      lineNo: lineNo++,
      lineType: "recurring",
      description: `${offer.planName} — ${price.componentKey} (${price.interval})`,
      componentKey: price.componentKey,
      quantity: 1,
      unitAmountMinor: amount,
      amountMinor: amount,
      usageMeterKey: null,
      usageWindowStart: null,
      usageWindowEnd: null,
      usageSourceVersion: null,
      usageSourceHash: null,
      metadata: { interval: price.interval }
    });
  }

  if (includeUsage && deps.usage) {
    for (const price of offer.prices) {
      const meterKey = usageMeterKeyOf(price);
      if (meterKey === null) continue;
      if (price.currency !== sub.currency) {
        return {
          ok: false,
          reason: "currency_mismatch",
          message: `Usage component ${price.componentKey} currency ${price.currency} != subscription currency ${sub.currency}.`
        };
      }
      const window = await deps.usage.getWindowTotal(
        meterKey,
        "month",
        new Date(period.period_start)
      );
      if (!window) continue;
      // Overage against the offer's included quota (if any); else bill all used.
      const quota = offer.quotas.find((q) => q.meterKey === meterKey);
      const included =
        quota && !quota.isUnlimited && quota.limitValue !== null
          ? quota.limitValue
          : 0;
      const used = assertSafeMinor(window.value, "usage window value");
      const billable = Math.max(0, used - included);
      if (billable <= 0) continue;
      const unit = assertSafeMinor(price.amountMinor, "usage unit amountMinor");
      const amount = multiplyMinor(unit, billable);
      lines.push({
        lineNo: lineNo++,
        lineType: "usage",
        description: `Usage ${meterKey}: ${billable} unit(s) over ${included} included`,
        componentKey: price.componentKey,
        quantity: billable,
        unitAmountMinor: unit,
        amountMinor: amount,
        usageMeterKey: meterKey,
        usageWindowStart: window.windowStart,
        usageWindowEnd: window.windowEnd,
        // The window's content hash IS its reconciliation identity (source
        // "version"); v1 = the reconciled snapshot recorded on this draft.
        usageSourceVersion: 1,
        usageSourceHash: window.contentHash,
        metadata: {
          included,
          used,
          freshness: window.freshness,
          windowType: window.windowType
        }
      });
    }
  }

  return { ok: true, lines };
}

// -------------------------------------------------------------------------
// Issue / void (status advances) — issued invoices are immutable
// -------------------------------------------------------------------------

export type InvoiceMutationResult =
  | { ok: true; invoice: InvoiceDto }
  | {
      ok: false;
      reason:
        "not_found" | "illegal_transition" | "version_conflict" | "validation";
      message: string;
      current?: InvoiceDto;
    };

async function guardStatus(
  row: InvoiceRow,
  toStatus: InvoiceStatus,
  expectedVersion: number | null
): Promise<InvoiceMutationResult | null> {
  if (expectedVersion !== null && expectedVersion !== Number(row.version)) {
    return {
      ok: false,
      reason: "version_conflict",
      message: `Invoice version is ${row.version}, expected ${expectedVersion}.`,
      current: toInvoiceDto(row)
    };
  }
  if (!isLegalInvoiceTransition(row.status, toStatus)) {
    return {
      ok: false,
      reason: "illegal_transition",
      message: `Illegal invoice status transition "${row.status}" -> "${toStatus}".`,
      current: toInvoiceDto(row)
    };
  }
  return null;
}

/** Issue a draft invoice -> immutable issued document. Sets number/due; freezes amounts. */
export async function issueInvoice(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string,
  command: {
    invoiceNumber: string | null;
    dueAt: string | null;
    reason: string;
    expectedVersion: number | null;
  },
  ctx: ActionContext
): Promise<InvoiceMutationResult> {
  const row = await loadInvoiceForUpdate(tx, tenantId, invoiceId);
  if (!row)
    return { ok: false, reason: "not_found", message: "Invoice not found." };
  const guard = await guardStatus(row, "issued", command.expectedVersion);
  if (guard) return guard;

  const updated = await advanceInvoiceStatus(tx, {
    tenantId,
    invoiceId,
    fromStatus: "draft",
    fromVersion: Number(row.version),
    toStatus: "issued",
    actor: ctx.actorTenantUserId,
    invoiceNumber: command.invoiceNumber,
    dueAt: command.dueAt
  });
  if (!updated) {
    return {
      ok: false,
      reason: "version_conflict",
      message: "Invoice changed concurrently.",
      current: toInvoiceDto(row)
    };
  }
  if (row.period_id) {
    await markPeriodInvoiced(tx, tenantId, row.period_id);
  }
  await appendInvoiceStatusHistory(tx, {
    tenantId,
    invoiceId,
    fromStatus: "draft",
    toStatus: "issued",
    version: Number(updated.version),
    reason: command.reason,
    source: "operator",
    actor: ctx.actorTenantUserId,
    correlationId: ctx.correlationId ?? null
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: SUBSCRIPTION_BILLING_INVOICE_ISSUED_EVENT_TYPE,
    eventVersion: SUBSCRIPTION_BILLING_EVENT_VERSION,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: invoiceId,
    aggregateVersion: Number(updated.version),
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      invoiceId,
      subscriptionId: updated.subscription_id,
      periodId: updated.period_id,
      currency: updated.currency,
      subtotalMinor: Number(updated.subtotal_minor),
      totalMinor: Number(updated.total_minor),
      offerVersion: Number(updated.offer_version),
      dueAt: updated.due_at
    }
  });
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "issue",
    resourceType: "subscription_billing_invoice",
    resourceId: invoiceId,
    severity: "warning",
    message: `Invoice issued (immutable): ${command.reason}`,
    attributes: {
      totalMinor: Number(updated.total_minor),
      currency: updated.currency,
      invoiceNumber: updated.invoice_number
    },
    correlationId: ctx.correlationId
  });
  return { ok: true, invoice: toInvoiceDto(updated) };
}

/** Void an invoice (draft or issued) — correction, never edit/delete. */
export async function voidInvoice(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string,
  command: { reason: string; expectedVersion: number | null },
  ctx: ActionContext
): Promise<InvoiceMutationResult> {
  const row = await loadInvoiceForUpdate(tx, tenantId, invoiceId);
  if (!row)
    return { ok: false, reason: "not_found", message: "Invoice not found." };
  const guard = await guardStatus(row, "void", command.expectedVersion);
  if (guard) return guard;

  const updated = await advanceInvoiceStatus(tx, {
    tenantId,
    invoiceId,
    fromStatus: row.status,
    fromVersion: Number(row.version),
    toStatus: "void",
    actor: ctx.actorTenantUserId,
    voidReason: command.reason
  });
  if (!updated) {
    return {
      ok: false,
      reason: "version_conflict",
      message: "Invoice changed concurrently.",
      current: toInvoiceDto(row)
    };
  }
  await appendInvoiceStatusHistory(tx, {
    tenantId,
    invoiceId,
    fromStatus: row.status,
    toStatus: "void",
    version: Number(updated.version),
    reason: command.reason,
    source: "operator",
    actor: ctx.actorTenantUserId,
    correlationId: ctx.correlationId ?? null
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: SUBSCRIPTION_BILLING_INVOICE_VOIDED_EVENT_TYPE,
    eventVersion: SUBSCRIPTION_BILLING_EVENT_VERSION,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: invoiceId,
    aggregateVersion: Number(updated.version),
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      invoiceId,
      priorStatus: row.status,
      currency: updated.currency,
      totalMinor: Number(updated.total_minor)
    }
  });
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "void",
    resourceType: "subscription_billing_invoice",
    resourceId: invoiceId,
    severity: "warning",
    message: `Invoice voided (${row.status} -> void): ${command.reason}`,
    attributes: {
      priorStatus: row.status,
      totalMinor: Number(updated.total_minor)
    },
    correlationId: ctx.correlationId
  });
  return { ok: true, invoice: toInvoiceDto(updated) };
}

// -------------------------------------------------------------------------
// Credit note (correction of an issued invoice)
// -------------------------------------------------------------------------

export type CreditResult =
  | { ok: true; creditNoteId: string; invoice: InvoiceDto }
  | {
      ok: false;
      reason:
        "not_found" | "invalid_state" | "currency_mismatch" | "over_credit";
      message: string;
    };

export async function creditInvoice(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string,
  command: {
    invoiceLineId: string | null;
    amountMinor: number;
    reason: string;
  },
  ctx: ActionContext
): Promise<CreditResult> {
  const row = await loadInvoiceForUpdate(tx, tenantId, invoiceId);
  if (!row)
    return { ok: false, reason: "not_found", message: "Invoice not found." };
  if (row.status !== "issued" && row.status !== "paid") {
    return {
      ok: false,
      reason: "invalid_state",
      message: `Only an issued/paid invoice can be credited (is "${row.status}").`
    };
  }
  const amount = assertSafeMinor(command.amountMinor, "credit amountMinor");
  const alreadyCredited = Number(row.credited_minor);
  const total = Number(row.total_minor);
  const newCredited = sumMinor([alreadyCredited, amount]);
  if (newCredited > total) {
    return {
      ok: false,
      reason: "over_credit",
      message: `Credit ${amount} would exceed the invoice total ${total} (already credited ${alreadyCredited}).`
    };
  }

  const credit = await insertCreditNote(tx, {
    tenantId,
    invoiceId,
    invoiceLineId: command.invoiceLineId,
    reason: command.reason,
    currency: row.currency,
    amountMinor: amount,
    correlationId: ctx.correlationId ?? null,
    actor: ctx.actorTenantUserId
  });
  await addInvoiceCredited(tx, tenantId, invoiceId, newCredited);

  await appendDomainEvent(tx, tenantId, {
    eventType: SUBSCRIPTION_BILLING_INVOICE_CREDITED_EVENT_TYPE,
    eventVersion: SUBSCRIPTION_BILLING_EVENT_VERSION,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: invoiceId,
    aggregateVersion: Number(row.version),
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      creditNoteId: credit.id,
      invoiceId,
      invoiceLineId: command.invoiceLineId,
      currency: row.currency,
      amountMinor: amount
    }
  });
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "subscription_billing_credit_note",
    resourceId: credit.id,
    severity: "warning",
    message: `Credit note issued against invoice ${invoiceId}: ${command.reason}`,
    attributes: { invoiceId, amountMinor: amount, currency: row.currency },
    correlationId: ctx.correlationId
  });

  const refreshed = (await getInvoiceForDto(tx, tenantId, invoiceId))!;
  return { ok: true, creditNoteId: credit.id, invoice: refreshed };
}

async function getInvoiceForDto(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string
): Promise<InvoiceDto | null> {
  const row = await loadInvoiceForUpdate(tx, tenantId, invoiceId);
  return row ? toInvoiceDto(row) : null;
}

// -------------------------------------------------------------------------
// Payment allocation (reference only — updated ONLY from validated outcome)
// -------------------------------------------------------------------------

export type PaymentResult =
  | {
      ok: true;
      allocationId: string | null;
      invoice: InvoiceDto;
      replayed: boolean;
    }
  | {
      ok: false;
      reason: "not_found" | "invalid_state" | "currency_mismatch";
      message: string;
    };

/**
 * Record a validated payment allocation REFERENCE (manual/offline or a #877
 * provider/reconciliation OUTCOME) against an issued invoice, and optionally
 * advance it to paid. This is the ONLY path that updates payment state — never
 * a provider call in this transaction (ADR-0006). Idempotent by
 * (invoice, provider_reference): a replayed outcome is recorded once.
 */
export async function recordPaymentAllocation(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string,
  command: {
    allocationSource: "manual" | "provider";
    providerKey: string | null;
    providerReference: string | null;
    amountMinor: number;
    outcome: string;
    markPaid: boolean;
    reason: string | null;
  },
  ctx: ActionContext
): Promise<PaymentResult> {
  const row = await loadInvoiceForUpdate(tx, tenantId, invoiceId);
  if (!row)
    return { ok: false, reason: "not_found", message: "Invoice not found." };
  if (row.status !== "issued" && row.status !== "paid") {
    return {
      ok: false,
      reason: "invalid_state",
      message: `Only an issued/paid invoice accepts a payment allocation (is "${row.status}").`
    };
  }
  const amount = assertSafeMinor(command.amountMinor, "allocation amountMinor");

  const allocation = await insertPaymentAllocation(tx, {
    tenantId,
    invoiceId,
    allocationSource: command.allocationSource,
    providerKey: command.providerKey,
    providerReference: command.providerReference,
    currency: row.currency,
    amountMinor: amount,
    outcome: command.outcome,
    reason: command.reason,
    correlationId: ctx.correlationId ?? null,
    actor: ctx.actorTenantUserId
  });
  // Idempotent replay: a provider outcome with the same reference was already
  // recorded -> return the current invoice unchanged (recorded once).
  if (!allocation && command.providerReference) {
    const current = (await getInvoiceForDto(tx, tenantId, invoiceId))!;
    return { ok: true, allocationId: null, invoice: current, replayed: true };
  }

  const newAllocated = sumMinor([Number(row.allocated_minor), amount]);
  await addInvoiceAllocated(tx, tenantId, invoiceId, newAllocated);

  await appendDomainEvent(tx, tenantId, {
    eventType: SUBSCRIPTION_BILLING_PAYMENT_RECORDED_EVENT_TYPE,
    eventVersion: SUBSCRIPTION_BILLING_EVENT_VERSION,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: invoiceId,
    aggregateVersion: Number(row.version),
    producerModule: MODULE_KEY,
    correlationId: ctx.correlationId,
    actorTenantUserId: ctx.actorTenantUserId,
    payload: {
      allocationId: allocation?.id ?? null,
      invoiceId,
      allocationSource: command.allocationSource,
      currency: row.currency,
      amountMinor: amount,
      outcome: command.outcome
    }
  });
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: ctx.actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "subscription_billing_payment_allocation",
    resourceId: allocation?.id ?? invoiceId,
    severity: "warning",
    message: `Payment allocation recorded (${command.allocationSource}, ${command.outcome})`,
    attributes: {
      invoiceId,
      amountMinor: amount,
      currency: row.currency,
      allocationSource: command.allocationSource
    },
    correlationId: ctx.correlationId
  });

  // Advance to paid only if the caller marks it and the invoice is fully covered.
  let invoiceRow = (await loadInvoiceForUpdate(tx, tenantId, invoiceId))!;
  const outstanding =
    Number(invoiceRow.total_minor) -
    Number(invoiceRow.credited_minor) -
    Number(invoiceRow.allocated_minor);
  if (command.markPaid && invoiceRow.status === "issued" && outstanding <= 0) {
    const paid = await advanceInvoiceStatus(tx, {
      tenantId,
      invoiceId,
      fromStatus: "issued",
      fromVersion: Number(invoiceRow.version),
      toStatus: "paid",
      actor: ctx.actorTenantUserId
    });
    if (paid) {
      invoiceRow = paid;
      await appendInvoiceStatusHistory(tx, {
        tenantId,
        invoiceId,
        fromStatus: "issued",
        toStatus: "paid",
        version: Number(paid.version),
        reason: command.reason,
        source:
          command.allocationSource === "provider" ? "payment" : "operator",
        actor: ctx.actorTenantUserId,
        correlationId: ctx.correlationId ?? null
      });
      await appendDomainEvent(tx, tenantId, {
        eventType: SUBSCRIPTION_BILLING_INVOICE_PAID_EVENT_TYPE,
        eventVersion: SUBSCRIPTION_BILLING_EVENT_VERSION,
        aggregateType: AGGREGATE_TYPE,
        aggregateId: invoiceId,
        aggregateVersion: Number(paid.version),
        producerModule: MODULE_KEY,
        correlationId: ctx.correlationId,
        actorTenantUserId: ctx.actorTenantUserId,
        payload: {
          invoiceId,
          currency: paid.currency,
          allocatedMinor: Number(paid.allocated_minor),
          source: command.allocationSource
        }
      });
    }
  }

  return {
    ok: true,
    allocationId: allocation?.id ?? null,
    invoice: toInvoiceDto(invoiceRow),
    replayed: false
  };
}
