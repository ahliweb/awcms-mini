/**
 * Fail-closed defensive parsing of untrusted `subscription_billing` command
 * bodies (Issue #876, epic pattern #6). Same discipline as the sibling
 * control-plane parsers:
 *   - ABSENT scalar/enum field -> its neutral default;
 *   - PRESENT field -> kept VERBATIM so the domain validator rejects a wrong
 *     type/value (400) — NEVER coerced to a valid default (a present-but-wrong
 *     type must surface as a 400, never be silently normalized);
 *   - nullable field -> tri-state: absent -> null; present -> verbatim;
 *   - present-but-not-an-object body -> `{}` so required-field checks fail.
 * VALUE validity (bounds, enums, EXACT minor-unit money) is the domain layer.
 */
import type {
  CreateSubscriptionInput,
  CreditNoteInput,
  GenerateInvoiceInput,
  IssueInvoiceInput,
  PaymentAllocationInput,
  SubscriptionChangeInput,
  SubscriptionTransitionInput,
  VoidInvoiceInput
} from "../domain/request-validation";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Tri-state nullable string: absent -> null; present -> verbatim. */
function nullableString(
  record: Record<string, unknown>,
  key: string
): string | null {
  if (!(key in record)) return null;
  return record[key] as string | null;
}

/** Tri-state nullable number: absent -> null; present -> verbatim. */
function nullableNumber(
  record: Record<string, unknown>,
  key: string
): number | null {
  if (!(key in record)) return null;
  return record[key] as number | null;
}

/** Present -> verbatim number; absent -> NaN so the validator rejects it. */
function requiredNumber(record: Record<string, unknown>, key: string): number {
  return key in record ? (record[key] as number) : NaN;
}

export function parseCreateSubscriptionBody(
  body: unknown
): CreateSubscriptionInput {
  const record = asRecord(body);
  return {
    offerPlanKey: asString(record.offerPlanKey),
    offerVersion: requiredNumber(record, "offerVersion"),
    billingInterval:
      "billingInterval" in record ? asString(record.billingInterval) : "month",
    billingAnchorDay: nullableNumber(record, "billingAnchorDay"),
    prorationPolicy:
      "prorationPolicy" in record ? asString(record.prorationPolicy) : "daily",
    roundingMode:
      "roundingMode" in record ? asString(record.roundingMode) : "half_up",
    collectionMode:
      "collectionMode" in record ? asString(record.collectionMode) : "manual",
    trialEndsAt: nullableString(record, "trialEndsAt"),
    billingContactRef: nullableString(record, "billingContactRef"),
    reason: asString(record.reason),
    source: "source" in record ? asString(record.source) : "operator"
  };
}

export function parseSubscriptionTransitionBody(
  body: unknown
): SubscriptionTransitionInput {
  const record = asRecord(body);
  return {
    toState: asString(record.toState),
    reason: asString(record.reason),
    source: "source" in record ? asString(record.source) : "operator",
    expectedVersion: nullableNumber(record, "expectedVersion")
  };
}

export function parseGenerateInvoiceBody(body: unknown): GenerateInvoiceInput {
  const record = asRecord(body);
  return {
    // Present -> verbatim (a wrong type is rejected; absent -> true, usage is
    // reconciled by default so a usage-based plan is never silently under-billed).
    includeUsage:
      "includeUsage" in record ? (record.includeUsage as boolean) : true,
    dueInDays: nullableNumber(record, "dueInDays"),
    reason: asString(record.reason)
  };
}

export function parseIssueInvoiceBody(body: unknown): IssueInvoiceInput {
  const record = asRecord(body);
  return {
    invoiceNumber: nullableString(record, "invoiceNumber"),
    dueAt: nullableString(record, "dueAt"),
    reason: asString(record.reason),
    expectedVersion: nullableNumber(record, "expectedVersion")
  };
}

export function parseVoidInvoiceBody(body: unknown): VoidInvoiceInput {
  const record = asRecord(body);
  return {
    reason: asString(record.reason),
    expectedVersion: nullableNumber(record, "expectedVersion")
  };
}

export function parseCreditNoteBody(body: unknown): CreditNoteInput {
  const record = asRecord(body);
  return {
    invoiceLineId: nullableString(record, "invoiceLineId"),
    // Present -> verbatim (a float/string is rejected by the validator, never
    // coerced); absent -> NaN so the validator rejects the missing amount.
    amountMinor: requiredNumber(record, "amountMinor"),
    reason: asString(record.reason)
  };
}

export function parsePaymentAllocationBody(
  body: unknown
): PaymentAllocationInput {
  const record = asRecord(body);
  return {
    allocationSource:
      "allocationSource" in record
        ? asString(record.allocationSource)
        : "manual",
    providerKey: nullableString(record, "providerKey"),
    providerReference: nullableString(record, "providerReference"),
    amountMinor: requiredNumber(record, "amountMinor"),
    outcome: "outcome" in record ? asString(record.outcome) : "settled",
    markPaid: "markPaid" in record ? (record.markPaid as boolean) : false,
    reason: nullableString(record, "reason")
  };
}

export function parseSubscriptionChangeBody(
  body: unknown
): SubscriptionChangeInput {
  const record = asRecord(body);
  return {
    changeType: asString(record.changeType),
    toOfferPlanKey: nullableString(record, "toOfferPlanKey"),
    toOfferVersion: nullableNumber(record, "toOfferVersion"),
    prorationPolicy:
      "prorationPolicy" in record ? asString(record.prorationPolicy) : "daily",
    effectiveAt: asString(record.effectiveAt),
    reason: asString(record.reason)
  };
}
