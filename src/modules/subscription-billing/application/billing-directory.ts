/**
 * `subscription_billing` data-access directory (Issue #876). All SQL lives
 * here; the engines/jobs call these functions inside the CALLER's already
 * tenant-scoped `tx` (`withTenant`). Money columns are bigint minor units and
 * are read back with `Number(...)` — safe because every amount is bounded to
 * Number.MAX_SAFE_INTEGER at the CHECK layer (`sql/091`) and the parser.
 * Concurrency: every write path row-locks (`SELECT ... FOR UPDATE`) then issues
 * a state/version-predicated UPDATE so a lost race is a deterministic conflict.
 */
import type {
  InvoiceStatus,
  InvoiceStatusSource
} from "../domain/invoice-state";
import type {
  SubscriptionSource,
  SubscriptionState
} from "../domain/subscription-state";
import type { RoundingMode } from "../domain/money";

export type SubscriptionRow = {
  id: string;
  tenant_id: string;
  offer_plan_key: string;
  offer_version: number;
  offer_hash: string;
  currency: string;
  state: SubscriptionState;
  previous_state: SubscriptionState | null;
  version: number;
  billing_interval: string;
  billing_anchor_day: number | null;
  proration_policy: string;
  rounding_mode: RoundingMode;
  collection_mode: string;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  started_at: string;
  canceled_at: string | null;
  ended_at: string | null;
  billing_contact_ref: string | null;
};

export type InvoiceRow = {
  id: string;
  tenant_id: string;
  subscription_id: string;
  period_id: string | null;
  offer_version: number;
  invoice_number: string | null;
  status: InvoiceStatus;
  currency: string;
  rounding_mode: RoundingMode;
  subtotal_minor: string;
  total_minor: string;
  credited_minor: string;
  allocated_minor: string;
  version: number;
  issued_at: string | null;
  issued_by: string | null;
  due_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  billing_contact_ref: string | null;
};

export type PeriodRow = {
  id: string;
  subscription_id: string;
  sequence: number;
  period_start: string;
  period_end: string;
  offer_version: number;
  status: string;
};

// -------------------------------------------------------------------------
// Subscriptions
// -------------------------------------------------------------------------

export async function createSubscription(
  tx: Bun.SQL,
  tenantId: string,
  input: {
    offerPlanKey: string;
    offerVersion: number;
    offerHash: string;
    currency: string;
    initialState: SubscriptionState;
    billingInterval: string;
    billingAnchorDay: number | null;
    prorationPolicy: string;
    roundingMode: RoundingMode;
    collectionMode: string;
    trialEndsAt: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    billingContactRef: string | null;
    reason: string;
    source: SubscriptionSource;
    actor: string | null;
  }
): Promise<SubscriptionRow | null> {
  const rows = (await tx`
    INSERT INTO awcms_mini_subscription_billing_subscriptions (
      tenant_id, offer_plan_key, offer_version, offer_hash, currency, state,
      billing_interval, billing_anchor_day, proration_policy, rounding_mode,
      collection_mode, trial_ends_at, current_period_start, current_period_end,
      billing_contact_ref, reason, source, actor, created_by, updated_by
    ) VALUES (
      ${tenantId}, ${input.offerPlanKey}, ${input.offerVersion}, ${input.offerHash},
      ${input.currency}, ${input.initialState}, ${input.billingInterval},
      ${input.billingAnchorDay}, ${input.prorationPolicy}, ${input.roundingMode},
      ${input.collectionMode}, ${input.trialEndsAt}, ${input.currentPeriodStart},
      ${input.currentPeriodEnd}, ${input.billingContactRef}, ${input.reason},
      ${input.source}, ${input.actor}, ${input.actor}, ${input.actor}
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `) as SubscriptionRow[];
  return rows[0] ?? null;
}

export async function loadSubscriptionForUpdate(
  tx: Bun.SQL,
  tenantId: string,
  subscriptionId: string
): Promise<SubscriptionRow | null> {
  const rows = (await tx`
    SELECT * FROM awcms_mini_subscription_billing_subscriptions
    WHERE tenant_id = ${tenantId} AND id = ${subscriptionId}
    FOR UPDATE
  `) as SubscriptionRow[];
  return rows[0] ?? null;
}

export async function getSubscription(
  tx: Bun.SQL,
  tenantId: string,
  subscriptionId: string
): Promise<SubscriptionRow | null> {
  const rows = (await tx`
    SELECT * FROM awcms_mini_subscription_billing_subscriptions
    WHERE tenant_id = ${tenantId} AND id = ${subscriptionId}
  `) as SubscriptionRow[];
  return rows[0] ?? null;
}

export async function listSubscriptions(
  tx: Bun.SQL,
  tenantId: string,
  limit = 100
): Promise<SubscriptionRow[]> {
  return (await tx`
    SELECT * FROM awcms_mini_subscription_billing_subscriptions
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as SubscriptionRow[];
}

/** State+version-predicated transition. Returns the updated row, or null on a lost race. */
export async function applySubscriptionTransition(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    subscriptionId: string;
    fromState: SubscriptionState;
    fromVersion: number;
    toState: SubscriptionState;
    actor: string | null;
    canceledAt: string | null;
    endedAt: string | null;
  }
): Promise<SubscriptionRow | null> {
  const rows = (await tx`
    UPDATE awcms_mini_subscription_billing_subscriptions
    SET state = ${input.toState},
        previous_state = ${input.fromState},
        version = version + 1,
        canceled_at = COALESCE(${input.canceledAt}, canceled_at),
        ended_at = COALESCE(${input.endedAt}, ended_at),
        updated_at = now(),
        updated_by = ${input.actor}
    WHERE tenant_id = ${input.tenantId}
      AND id = ${input.subscriptionId}
      AND state = ${input.fromState}
      AND version = ${input.fromVersion}
    RETURNING *
  `) as SubscriptionRow[];
  return rows[0] ?? null;
}

/** Subscriptions whose current period has ended and are still billable (renewal due). Bounded. */
export async function listDueRenewalSubscriptions(
  tx: Bun.SQL,
  tenantId: string,
  now: string,
  limit: number
): Promise<SubscriptionRow[]> {
  return (await tx`
    SELECT * FROM awcms_mini_subscription_billing_subscriptions
    WHERE tenant_id = ${tenantId}
      AND state IN ('trialing', 'active', 'past_due')
      AND current_period_end IS NOT NULL
      AND current_period_end <= ${now}
    ORDER BY current_period_end ASC
    LIMIT ${limit}
  `) as SubscriptionRow[];
}

/** Issued, past-due (due_at passed), still outstanding invoices — dunning candidates. Bounded. */
export async function listDunningCandidates(
  tx: Bun.SQL,
  tenantId: string,
  now: string,
  limit: number
): Promise<InvoiceRow[]> {
  return (await tx`
    SELECT * FROM awcms_mini_subscription_billing_invoices
    WHERE tenant_id = ${tenantId}
      AND status = 'issued'
      AND due_at IS NOT NULL
      AND due_at <= ${now}
      AND (total_minor - credited_minor - allocated_minor) > 0
    ORDER BY due_at ASC
    LIMIT ${limit}
  `) as InvoiceRow[];
}

export async function updateSubscriptionPeriodAnchors(
  tx: Bun.SQL,
  tenantId: string,
  subscriptionId: string,
  periodStart: string,
  periodEnd: string
): Promise<void> {
  await tx`
    UPDATE awcms_mini_subscription_billing_subscriptions
    SET current_period_start = ${periodStart},
        current_period_end = ${periodEnd},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${subscriptionId}
  `;
}

// -------------------------------------------------------------------------
// Billing periods
// -------------------------------------------------------------------------

/** Insert a period idempotently (unique on subscription_id+sequence). Returns the row (new or existing). */
export async function ensurePeriod(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    subscriptionId: string;
    sequence: number;
    periodStart: string;
    periodEnd: string;
    offerVersion: number;
    actor: string | null;
  }
): Promise<PeriodRow> {
  await tx`
    INSERT INTO awcms_mini_subscription_billing_periods (
      tenant_id, subscription_id, sequence, period_start, period_end,
      offer_version, created_by
    ) VALUES (
      ${input.tenantId}, ${input.subscriptionId}, ${input.sequence},
      ${input.periodStart}, ${input.periodEnd}, ${input.offerVersion}, ${input.actor}
    )
    ON CONFLICT (subscription_id, sequence) DO NOTHING
  `;
  const rows = (await tx`
    SELECT * FROM awcms_mini_subscription_billing_periods
    WHERE tenant_id = ${input.tenantId}
      AND subscription_id = ${input.subscriptionId}
      AND sequence = ${input.sequence}
  `) as PeriodRow[];
  return rows[0]!;
}

/** Find the period whose start equals `periodStart` (the stable anchor for idempotent generation). */
export async function findPeriodByStart(
  tx: Bun.SQL,
  tenantId: string,
  subscriptionId: string,
  periodStart: string
): Promise<PeriodRow | null> {
  const rows = (await tx`
    SELECT * FROM awcms_mini_subscription_billing_periods
    WHERE tenant_id = ${tenantId} AND subscription_id = ${subscriptionId}
      AND period_start = ${periodStart}
  `) as PeriodRow[];
  return rows[0] ?? null;
}

export async function latestPeriodSequence(
  tx: Bun.SQL,
  tenantId: string,
  subscriptionId: string
): Promise<number> {
  const rows = (await tx`
    SELECT COALESCE(MAX(sequence), 0) AS seq
    FROM awcms_mini_subscription_billing_periods
    WHERE tenant_id = ${tenantId} AND subscription_id = ${subscriptionId}
  `) as { seq: number | string }[];
  return Number(rows[0]?.seq ?? 0);
}

export async function markPeriodInvoiced(
  tx: Bun.SQL,
  tenantId: string,
  periodId: string
): Promise<void> {
  await tx`
    UPDATE awcms_mini_subscription_billing_periods
    SET status = 'invoiced'
    WHERE tenant_id = ${tenantId} AND id = ${periodId} AND status = 'open'
  `;
}

export async function listPeriods(
  tx: Bun.SQL,
  tenantId: string,
  subscriptionId: string,
  limit = 100
): Promise<PeriodRow[]> {
  return (await tx`
    SELECT * FROM awcms_mini_subscription_billing_periods
    WHERE tenant_id = ${tenantId} AND subscription_id = ${subscriptionId}
    ORDER BY sequence DESC
    LIMIT ${limit}
  `) as PeriodRow[];
}

// -------------------------------------------------------------------------
// Invoices + lines
// -------------------------------------------------------------------------

/**
 * Insert a draft invoice idempotently: the partial UNIQUE (subscription_id,
 * period_id) WHERE status <> 'void' means a concurrent second worker collides
 * (ON CONFLICT DO NOTHING) and gets `null` — the caller then reads the winner.
 */
export async function insertDraftInvoice(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    subscriptionId: string;
    periodId: string;
    offerVersion: number;
    currency: string;
    roundingMode: RoundingMode;
    billingContactRef: string | null;
    actor: string | null;
  }
): Promise<InvoiceRow | null> {
  const rows = (await tx`
    INSERT INTO awcms_mini_subscription_billing_invoices (
      tenant_id, subscription_id, period_id, offer_version, currency,
      rounding_mode, billing_contact_ref, created_by, updated_by
    ) VALUES (
      ${input.tenantId}, ${input.subscriptionId}, ${input.periodId},
      ${input.offerVersion}, ${input.currency}, ${input.roundingMode},
      ${input.billingContactRef}, ${input.actor}, ${input.actor}
    )
    ON CONFLICT (subscription_id, period_id) WHERE status <> 'void' AND period_id IS NOT NULL
    DO NOTHING
    RETURNING *
  `) as InvoiceRow[];
  return rows[0] ?? null;
}

export async function getLiveInvoiceForPeriod(
  tx: Bun.SQL,
  tenantId: string,
  subscriptionId: string,
  periodId: string
): Promise<InvoiceRow | null> {
  const rows = (await tx`
    SELECT * FROM awcms_mini_subscription_billing_invoices
    WHERE tenant_id = ${tenantId}
      AND subscription_id = ${subscriptionId}
      AND period_id = ${periodId}
      AND status <> 'void'
  `) as InvoiceRow[];
  return rows[0] ?? null;
}

export async function loadInvoiceForUpdate(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string
): Promise<InvoiceRow | null> {
  const rows = (await tx`
    SELECT * FROM awcms_mini_subscription_billing_invoices
    WHERE tenant_id = ${tenantId} AND id = ${invoiceId}
    FOR UPDATE
  `) as InvoiceRow[];
  return rows[0] ?? null;
}

export async function getInvoice(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string
): Promise<InvoiceRow | null> {
  const rows = (await tx`
    SELECT * FROM awcms_mini_subscription_billing_invoices
    WHERE tenant_id = ${tenantId} AND id = ${invoiceId}
  `) as InvoiceRow[];
  return rows[0] ?? null;
}

export async function listInvoices(
  tx: Bun.SQL,
  tenantId: string,
  filter: { subscriptionId?: string; status?: InvoiceStatus; limit?: number }
): Promise<InvoiceRow[]> {
  const limit = filter.limit ?? 100;
  if (filter.subscriptionId && filter.status) {
    return (await tx`
      SELECT * FROM awcms_mini_subscription_billing_invoices
      WHERE tenant_id = ${tenantId} AND subscription_id = ${filter.subscriptionId}
        AND status = ${filter.status}
      ORDER BY created_at DESC LIMIT ${limit}
    `) as InvoiceRow[];
  }
  if (filter.subscriptionId) {
    return (await tx`
      SELECT * FROM awcms_mini_subscription_billing_invoices
      WHERE tenant_id = ${tenantId} AND subscription_id = ${filter.subscriptionId}
      ORDER BY created_at DESC LIMIT ${limit}
    `) as InvoiceRow[];
  }
  if (filter.status) {
    return (await tx`
      SELECT * FROM awcms_mini_subscription_billing_invoices
      WHERE tenant_id = ${tenantId} AND status = ${filter.status}
      ORDER BY created_at DESC LIMIT ${limit}
    `) as InvoiceRow[];
  }
  return (await tx`
    SELECT * FROM awcms_mini_subscription_billing_invoices
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC LIMIT ${limit}
  `) as InvoiceRow[];
}

export type InvoiceLineInput = {
  lineNo: number;
  lineType: "recurring" | "usage" | "credit" | "adjustment";
  description: string;
  componentKey: string | null;
  quantity: number;
  unitAmountMinor: number;
  amountMinor: number;
  usageMeterKey: string | null;
  usageWindowStart: string | null;
  usageWindowEnd: string | null;
  usageSourceVersion: number | null;
  usageSourceHash: string | null;
  metadata: Record<string, unknown>;
};

export async function insertInvoiceLine(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string,
  line: InvoiceLineInput,
  actor: string | null
): Promise<void> {
  await tx`
    INSERT INTO awcms_mini_subscription_billing_invoice_lines (
      tenant_id, invoice_id, line_no, line_type, description, component_key,
      quantity, unit_amount_minor, amount_minor, usage_meter_key,
      usage_window_start, usage_window_end, usage_source_version,
      usage_source_hash, metadata, created_by
    ) VALUES (
      ${tenantId}, ${invoiceId}, ${line.lineNo}, ${line.lineType},
      ${line.description}, ${line.componentKey}, ${line.quantity},
      ${line.unitAmountMinor}, ${line.amountMinor}, ${line.usageMeterKey},
      ${line.usageWindowStart}, ${line.usageWindowEnd}, ${line.usageSourceVersion},
      ${line.usageSourceHash}, ${line.metadata}, ${actor}
    )
  `;
}

export async function listInvoiceLines(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string
): Promise<
  {
    id: string;
    line_no: number;
    line_type: string;
    description: string;
    component_key: string | null;
    quantity: string;
    unit_amount_minor: string;
    amount_minor: string;
    usage_meter_key: string | null;
    usage_window_start: string | null;
    usage_window_end: string | null;
    usage_source_version: number | null;
    usage_source_hash: string | null;
  }[]
> {
  return (await tx`
    SELECT * FROM awcms_mini_subscription_billing_invoice_lines
    WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId}
    ORDER BY line_no ASC
  `) as never;
}

/** Set the draft invoice totals (only while status = 'draft'). */
export async function setDraftInvoiceTotals(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string,
  subtotalMinor: number,
  totalMinor: number
): Promise<void> {
  await tx`
    UPDATE awcms_mini_subscription_billing_invoices
    SET subtotal_minor = ${subtotalMinor}, total_minor = ${totalMinor},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${invoiceId} AND status = 'draft'
  `;
}

/**
 * Advance an invoice status with a status+version predicate. Returns the row or
 * null on a lost race / illegal predicate. Sets the appropriate provenance
 * column (issued_at/issued_by, paid_at, voided_at) atomically.
 */
export async function advanceInvoiceStatus(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    invoiceId: string;
    fromStatus: InvoiceStatus;
    fromVersion: number;
    toStatus: InvoiceStatus;
    actor: string | null;
    invoiceNumber?: string | null;
    dueAt?: string | null;
    voidReason?: string | null;
  }
): Promise<InvoiceRow | null> {
  const rows = (await tx`
    UPDATE awcms_mini_subscription_billing_invoices
    SET status = ${input.toStatus},
        version = version + 1,
        issued_at = CASE WHEN ${input.toStatus} = 'issued' THEN now() ELSE issued_at END,
        issued_by = CASE WHEN ${input.toStatus} = 'issued' THEN ${input.actor} ELSE issued_by END,
        invoice_number = CASE WHEN ${input.toStatus} = 'issued' THEN ${input.invoiceNumber ?? null} ELSE invoice_number END,
        due_at = CASE WHEN ${input.toStatus} = 'issued' THEN ${input.dueAt ?? null} ELSE due_at END,
        paid_at = CASE WHEN ${input.toStatus} = 'paid' THEN now() ELSE paid_at END,
        voided_at = CASE WHEN ${input.toStatus} = 'void' THEN now() ELSE voided_at END,
        void_reason = CASE WHEN ${input.toStatus} = 'void' THEN ${input.voidReason ?? null} ELSE void_reason END,
        updated_at = now(),
        updated_by = ${input.actor}
    WHERE tenant_id = ${input.tenantId}
      AND id = ${input.invoiceId}
      AND status = ${input.fromStatus}
      AND version = ${input.fromVersion}
    RETURNING *
  `) as InvoiceRow[];
  return rows[0] ?? null;
}

export async function appendInvoiceStatusHistory(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    invoiceId: string;
    fromStatus: InvoiceStatus | null;
    toStatus: InvoiceStatus;
    version: number;
    reason: string | null;
    source: InvoiceStatusSource;
    actor: string | null;
    correlationId: string | null;
  }
): Promise<void> {
  await tx`
    INSERT INTO awcms_mini_subscription_billing_invoice_status_history (
      tenant_id, invoice_id, from_status, to_status, version, reason, source,
      actor, correlation_id, created_by
    ) VALUES (
      ${input.tenantId}, ${input.invoiceId}, ${input.fromStatus}, ${input.toStatus},
      ${input.version}, ${input.reason}, ${input.source}, ${input.actor},
      ${input.correlationId}, ${input.actor}
    )
  `;
}

export async function listInvoiceStatusHistory(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string
): Promise<
  {
    from_status: string | null;
    to_status: string;
    version: number;
    source: string;
    created_at: string;
  }[]
> {
  return (await tx`
    SELECT from_status, to_status, version, source, created_at
    FROM awcms_mini_subscription_billing_invoice_status_history
    WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId}
    ORDER BY created_at ASC
  `) as never;
}

// -------------------------------------------------------------------------
// Credit notes
// -------------------------------------------------------------------------

export async function insertCreditNote(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    invoiceId: string;
    invoiceLineId: string | null;
    reason: string;
    currency: string;
    amountMinor: number;
    correlationId: string | null;
    actor: string | null;
  }
): Promise<{ id: string }> {
  // Issue #879 — credit note is created in `pending_approval` (schema default);
  // the invoice balance is NOT touched until a distinct actor approves.
  const rows = (await tx`
    INSERT INTO awcms_mini_subscription_billing_credit_notes (
      tenant_id, invoice_id, invoice_line_id, reason, currency, amount_minor,
      correlation_id, issued_by, created_by
    ) VALUES (
      ${input.tenantId}, ${input.invoiceId}, ${input.invoiceLineId}, ${input.reason},
      ${input.currency}, ${input.amountMinor}, ${input.correlationId}, ${input.actor},
      ${input.actor}
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0]!;
}

export type CreditNoteRow = {
  id: string;
  tenant_id: string;
  invoice_id: string;
  invoice_line_id: string | null;
  currency: string;
  amount_minor: string;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
};

export async function loadCreditNoteForUpdate(
  tx: Bun.SQL,
  tenantId: string,
  creditNoteId: string
): Promise<CreditNoteRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, invoice_id, invoice_line_id, currency, amount_minor,
           status, approved_by, approved_at
    FROM awcms_mini_subscription_billing_credit_notes
    WHERE tenant_id = ${tenantId} AND id = ${creditNoteId}
    FOR UPDATE
  `) as CreditNoteRow[];
  return rows[0] ?? null;
}

/**
 * Sum of credit-note amounts that COUNT against the invoice total — pending
 * (not yet applied) OR already applied. Used by the maker step's over-credit
 * guard so the sum of concurrent pending credits can never exceed the total.
 * EXACT decimal string (BigInt-compared by the caller).
 */
export async function sumOpenCreditNotes(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string
): Promise<string> {
  const rows = (await tx`
    SELECT COALESCE(SUM(amount_minor), 0)::text AS total
    FROM awcms_mini_subscription_billing_credit_notes
    WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId}
      AND status IN ('pending_approval', 'applied')
  `) as { total: string }[];
  return rows[0]?.total ?? "0";
}

/**
 * Approve (CHECKER) a pending credit note: transition pending_approval ->
 * applied and record the approver (write-once). Returns null on a concurrent
 * transition (no longer pending). The caller applies the invoice balance in the
 * same transaction.
 */
export async function applyCreditNote(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    creditNoteId: string;
    approvedBy: string | null;
  }
): Promise<CreditNoteRow | null> {
  const rows = (await tx`
    UPDATE awcms_mini_subscription_billing_credit_notes
    SET status = 'applied', approved_by = ${input.approvedBy}, approved_at = now()
    WHERE tenant_id = ${input.tenantId} AND id = ${input.creditNoteId}
      AND status = 'pending_approval'
    RETURNING id, tenant_id, invoice_id, invoice_line_id, currency, amount_minor,
              status, approved_by, approved_at
  `) as CreditNoteRow[];
  return rows[0] ?? null;
}

/** Bump the invoice's credited counter (allowed on issued/paid invoices — not a frozen field). */
export async function addInvoiceCredited(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string,
  creditedMinor: number
): Promise<void> {
  await tx`
    UPDATE awcms_mini_subscription_billing_invoices
    SET credited_minor = ${creditedMinor}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${invoiceId}
  `;
}

export async function listCreditNotes(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string
): Promise<
  { id: string; amount_minor: string; currency: string; created_at: string }[]
> {
  return (await tx`
    SELECT id, amount_minor, currency, created_at
    FROM awcms_mini_subscription_billing_credit_notes
    WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId}
    ORDER BY created_at DESC
  `) as never;
}

// -------------------------------------------------------------------------
// Payment allocations (reference only — NOT an accounting ledger)
// -------------------------------------------------------------------------

export async function insertPaymentAllocation(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    invoiceId: string;
    allocationSource: "manual" | "provider";
    providerKey: string | null;
    providerReference: string | null;
    currency: string;
    amountMinor: number;
    outcome: string;
    reason: string | null;
    correlationId: string | null;
    actor: string | null;
  }
): Promise<{ id: string } | null> {
  const rows = (await tx`
    INSERT INTO awcms_mini_subscription_billing_payment_allocations (
      tenant_id, invoice_id, allocation_source, provider_key, provider_reference,
      currency, amount_minor, outcome, reason, correlation_id, created_by
    ) VALUES (
      ${input.tenantId}, ${input.invoiceId}, ${input.allocationSource},
      ${input.providerKey}, ${input.providerReference}, ${input.currency},
      ${input.amountMinor}, ${input.outcome}, ${input.reason}, ${input.correlationId},
      ${input.actor}
    )
    ON CONFLICT (invoice_id, provider_reference) WHERE provider_reference IS NOT NULL
    DO NOTHING
    RETURNING id
  `) as { id: string }[];
  return rows[0] ?? null;
}

export async function addInvoiceAllocated(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string,
  allocatedMinor: number
): Promise<void> {
  await tx`
    UPDATE awcms_mini_subscription_billing_invoices
    SET allocated_minor = ${allocatedMinor}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${invoiceId}
  `;
}

export async function listPaymentAllocations(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string
): Promise<
  {
    id: string;
    amount_minor: string;
    allocation_source: string;
    outcome: string;
    allocated_at: string;
  }[]
> {
  return (await tx`
    SELECT id, amount_minor, allocation_source, outcome, allocated_at
    FROM awcms_mini_subscription_billing_payment_allocations
    WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId}
    ORDER BY allocated_at DESC
  `) as never;
}

// -------------------------------------------------------------------------
// Subscription changes (upgrade/downgrade/cancel)
// -------------------------------------------------------------------------

export async function supersedeScheduledChanges(
  tx: Bun.SQL,
  tenantId: string,
  subscriptionId: string
): Promise<void> {
  await tx`
    UPDATE awcms_mini_subscription_billing_subscription_changes
    SET status = 'superseded', updated_at = now()
    WHERE tenant_id = ${tenantId} AND subscription_id = ${subscriptionId}
      AND status = 'scheduled'
  `;
}

export async function insertSubscriptionChange(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    subscriptionId: string;
    changeType: "upgrade" | "downgrade" | "cancel";
    fromOfferPlanKey: string;
    fromOfferVersion: number;
    toOfferPlanKey: string | null;
    toOfferVersion: number | null;
    prorationPolicy: string;
    effectiveAt: string;
    reason: string;
    correlationId: string | null;
    actor: string | null;
  }
): Promise<{ id: string }> {
  const rows = (await tx`
    INSERT INTO awcms_mini_subscription_billing_subscription_changes (
      tenant_id, subscription_id, change_type, from_offer_plan_key,
      from_offer_version, to_offer_plan_key, to_offer_version, proration_policy,
      effective_at, reason, correlation_id, created_by, updated_by
    ) VALUES (
      ${input.tenantId}, ${input.subscriptionId}, ${input.changeType},
      ${input.fromOfferPlanKey}, ${input.fromOfferVersion}, ${input.toOfferPlanKey},
      ${input.toOfferVersion}, ${input.prorationPolicy}, ${input.effectiveAt},
      ${input.reason}, ${input.correlationId}, ${input.actor}, ${input.actor}
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0]!;
}

export async function listSubscriptionChanges(
  tx: Bun.SQL,
  tenantId: string,
  subscriptionId: string
): Promise<
  {
    id: string;
    change_type: string;
    status: string;
    effective_at: string;
    to_offer_plan_key: string | null;
    to_offer_version: number | null;
  }[]
> {
  return (await tx`
    SELECT id, change_type, status, effective_at, to_offer_plan_key, to_offer_version
    FROM awcms_mini_subscription_billing_subscription_changes
    WHERE tenant_id = ${tenantId} AND subscription_id = ${subscriptionId}
    ORDER BY created_at DESC
  `) as never;
}

// -------------------------------------------------------------------------
// Dunning attempts
// -------------------------------------------------------------------------

export async function nextDunningAttemptNo(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string
): Promise<number> {
  const rows = (await tx`
    SELECT COALESCE(MAX(attempt_no), 0) AS n
    FROM awcms_mini_subscription_billing_dunning_attempts
    WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId}
  `) as { n: number | string }[];
  return Number(rows[0]?.n ?? 0) + 1;
}

export async function insertDunningAttempt(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    invoiceId: string;
    subscriptionId: string;
    attemptNo: number;
    scheduledAt: string;
    state: string;
    requestedLifecycleState: string | null;
    lifecycleOutcome: string | null;
    reason: string | null;
    correlationId: string | null;
    executedAt: string | null;
    actor: string | null;
  }
): Promise<{ id: string } | null> {
  const rows = (await tx`
    INSERT INTO awcms_mini_subscription_billing_dunning_attempts (
      tenant_id, invoice_id, subscription_id, attempt_no, scheduled_at, state,
      requested_lifecycle_state, lifecycle_outcome, reason, correlation_id,
      executed_at, created_by, updated_by
    ) VALUES (
      ${input.tenantId}, ${input.invoiceId}, ${input.subscriptionId},
      ${input.attemptNo}, ${input.scheduledAt}, ${input.state},
      ${input.requestedLifecycleState}, ${input.lifecycleOutcome}, ${input.reason},
      ${input.correlationId}, ${input.executedAt}, ${input.actor}, ${input.actor}
    )
    ON CONFLICT (invoice_id, attempt_no) DO NOTHING
    RETURNING id
  `) as { id: string }[];
  return rows[0] ?? null;
}

export async function listDunningAttempts(
  tx: Bun.SQL,
  tenantId: string,
  invoiceId: string
): Promise<
  {
    id: string;
    attempt_no: number;
    state: string;
    requested_lifecycle_state: string | null;
    lifecycle_outcome: string | null;
    scheduled_at: string;
  }[]
> {
  return (await tx`
    SELECT id, attempt_no, state, requested_lifecycle_state, lifecycle_outcome, scheduled_at
    FROM awcms_mini_subscription_billing_dunning_attempts
    WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId}
    ORDER BY attempt_no ASC
  `) as never;
}
