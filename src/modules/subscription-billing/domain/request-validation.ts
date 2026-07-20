/**
 * `subscription_billing` command input types + VALUE validation (Issue #876).
 * Shape/type coercion is the parser's job (`application/request-parsing.ts`,
 * fail-closed tri-state); this file validates VALUE VALIDITY (known enums,
 * bounds, mandatory reason, EXACT minor-unit money) and runs after parsing.
 * Pure — no I/O. Every high-risk mutation carries a MANDATORY reason (audit).
 */
import {
  isSubscriptionSource,
  isSubscriptionState,
  type SubscriptionSource,
  type SubscriptionState
} from "./subscription-state";
import { isRoundingMode, isSafeMinor, isSafeNonNegativeMinor } from "./money";

export type BillingValidationError = { field: string; message: string };

const PLAN_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
// Defense-in-depth PII minimisation (doc 04): a billing contact reference must be
// OPAQUE (an id/token that resolves to a contact elsewhere), never a raw email or
// phone number embedded in a money-domain row. These reject the obvious raw forms.
const EMAIL_LIKE_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_LIKE_RE = /^[+(]?[\d][\d\s()+.-]{5,}$/;

/** True if the value obviously carries a raw email or phone number (not opaque). */
function looksLikeRawContactPii(value: string): boolean {
  const trimmed = value.trim();
  if (EMAIL_LIKE_RE.test(trimmed)) return true;
  const digitCount = (trimmed.match(/\d/g) ?? []).length;
  // Phone-shaped: the WHOLE value is phone punctuation/digits and carries enough
  // digits to be a real number (avoids flagging prefixed/tokenised opaque ids,
  // which contain letters and thus fail PHONE_LIKE_RE).
  return digitCount >= 7 && PHONE_LIKE_RE.test(trimmed);
}
const BILLING_INTERVALS = ["day", "week", "month", "quarter", "year"] as const;
const PRORATION_POLICIES = ["none", "daily", "full_period"] as const;
const COLLECTION_MODES = ["manual", "automatic"] as const;

export type CreateSubscriptionInput = {
  offerPlanKey: string;
  offerVersion: number;
  billingInterval: string;
  billingAnchorDay: number | null;
  prorationPolicy: string;
  roundingMode: string;
  collectionMode: string;
  trialEndsAt: string | null;
  billingContactRef: string | null;
  reason: string;
  source: SubscriptionSource | string;
};

export type SubscriptionTransitionInput = {
  toState: SubscriptionState | string;
  reason: string;
  source: SubscriptionSource | string;
  expectedVersion: number | null;
};

export type GenerateInvoiceInput = {
  includeUsage: boolean;
  dueInDays: number | null;
  reason: string;
};

export type IssueInvoiceInput = {
  invoiceNumber: string | null;
  dueAt: string | null;
  reason: string;
  expectedVersion: number | null;
};

export type VoidInvoiceInput = {
  reason: string;
  expectedVersion: number | null;
};

export type CreditNoteInput = {
  invoiceLineId: string | null;
  amountMinor: number;
  reason: string;
};

export type PaymentAllocationInput = {
  allocationSource: string;
  providerKey: string | null;
  providerReference: string | null;
  amountMinor: number;
  outcome: string;
  markPaid: boolean;
  reason: string | null;
};

export type SubscriptionChangeInput = {
  changeType: string;
  toOfferPlanKey: string | null;
  toOfferVersion: number | null;
  prorationPolicy: string;
  effectiveAt: string;
  reason: string;
};

function validateReason(
  reason: unknown,
  errors: BillingValidationError[],
  required = true
): void {
  if (reason === null && !required) return;
  if (
    typeof reason !== "string" ||
    (required && reason.trim().length < 1) ||
    (typeof reason === "string" && reason.length > 2000)
  ) {
    errors.push({
      field: "reason",
      message: required
        ? "reason is required (1..2000 chars) for every high-risk billing action"
        : "reason must be a string up to 2000 chars"
    });
  }
}

function validateExpectedVersion(
  expectedVersion: unknown,
  errors: BillingValidationError[]
): void {
  if (
    expectedVersion !== null &&
    (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1)
  ) {
    errors.push({
      field: "expectedVersion",
      message: "must be a positive integer when provided"
    });
  }
}

export function validateCreateSubscription(
  input: CreateSubscriptionInput
): BillingValidationError[] {
  const errors: BillingValidationError[] = [];
  if (
    !PLAN_KEY_RE.test(input.offerPlanKey) ||
    input.offerPlanKey.length > 120
  ) {
    errors.push({
      field: "offerPlanKey",
      message: "must be a lower_snake plan key"
    });
  }
  if (!Number.isInteger(input.offerVersion) || input.offerVersion < 1) {
    errors.push({
      field: "offerVersion",
      message: "must be a positive integer"
    });
  }
  if (
    !(BILLING_INTERVALS as readonly string[]).includes(input.billingInterval)
  ) {
    errors.push({
      field: "billingInterval",
      message: "unknown billing interval"
    });
  }
  if (
    input.billingAnchorDay !== null &&
    (!Number.isInteger(input.billingAnchorDay) ||
      input.billingAnchorDay < 1 ||
      input.billingAnchorDay > 31)
  ) {
    errors.push({
      field: "billingAnchorDay",
      message: "must be 1..31 or null"
    });
  }
  if (
    !(PRORATION_POLICIES as readonly string[]).includes(input.prorationPolicy)
  ) {
    errors.push({
      field: "prorationPolicy",
      message: "unknown proration policy"
    });
  }
  if (!isRoundingMode(input.roundingMode)) {
    errors.push({ field: "roundingMode", message: "unknown rounding mode" });
  }
  if (!(COLLECTION_MODES as readonly string[]).includes(input.collectionMode)) {
    errors.push({
      field: "collectionMode",
      message: "unknown collection mode"
    });
  }
  if (
    input.trialEndsAt !== null &&
    Number.isNaN(Date.parse(input.trialEndsAt))
  ) {
    errors.push({
      field: "trialEndsAt",
      message: "must be an ISO-8601 timestamp or null"
    });
  }
  if (input.billingContactRef !== null) {
    if (
      typeof input.billingContactRef !== "string" ||
      input.billingContactRef.length > 200
    ) {
      errors.push({
        field: "billingContactRef",
        message: "must be a string up to 200 chars or null"
      });
    } else if (looksLikeRawContactPii(input.billingContactRef)) {
      errors.push({
        field: "billingContactRef",
        message:
          "must be an OPAQUE reference (an id/token), not a raw email or phone number (doc 04 PII minimisation)"
      });
    }
  }
  if (!isSubscriptionSource(input.source)) {
    errors.push({ field: "source", message: "unknown source" });
  }
  validateReason(input.reason, errors);
  return errors;
}

export function validateSubscriptionTransition(
  input: SubscriptionTransitionInput
): BillingValidationError[] {
  const errors: BillingValidationError[] = [];
  if (!isSubscriptionState(input.toState)) {
    errors.push({ field: "toState", message: "unknown subscription state" });
  }
  if (!isSubscriptionSource(input.source)) {
    errors.push({ field: "source", message: "unknown source" });
  }
  validateReason(input.reason, errors);
  validateExpectedVersion(input.expectedVersion, errors);
  return errors;
}

export function validateGenerateInvoice(
  input: GenerateInvoiceInput
): BillingValidationError[] {
  const errors: BillingValidationError[] = [];
  if (typeof input.includeUsage !== "boolean") {
    errors.push({ field: "includeUsage", message: "must be a boolean" });
  }
  if (
    input.dueInDays !== null &&
    (!Number.isInteger(input.dueInDays) ||
      input.dueInDays < 0 ||
      input.dueInDays > 3650)
  ) {
    errors.push({ field: "dueInDays", message: "must be 0..3650 or null" });
  }
  validateReason(input.reason, errors);
  return errors;
}

export function validateIssueInvoice(
  input: IssueInvoiceInput
): BillingValidationError[] {
  const errors: BillingValidationError[] = [];
  if (
    input.invoiceNumber !== null &&
    (typeof input.invoiceNumber !== "string" ||
      input.invoiceNumber.length < 1 ||
      input.invoiceNumber.length > 100)
  ) {
    errors.push({
      field: "invoiceNumber",
      message: "must be 1..100 chars or null"
    });
  }
  if (input.dueAt !== null && Number.isNaN(Date.parse(input.dueAt))) {
    errors.push({
      field: "dueAt",
      message: "must be an ISO-8601 timestamp or null"
    });
  }
  validateReason(input.reason, errors);
  validateExpectedVersion(input.expectedVersion, errors);
  return errors;
}

export function validateVoidInvoice(
  input: VoidInvoiceInput
): BillingValidationError[] {
  const errors: BillingValidationError[] = [];
  validateReason(input.reason, errors);
  validateExpectedVersion(input.expectedVersion, errors);
  return errors;
}

export function validateCreditNote(
  input: CreditNoteInput
): BillingValidationError[] {
  const errors: BillingValidationError[] = [];
  // EXACT minor-unit money: a float or out-of-range amount is rejected (mutation
  // test target).
  if (!isSafeNonNegativeMinor(input.amountMinor) || input.amountMinor < 1) {
    errors.push({
      field: "amountMinor",
      message: "must be a positive exact minor-unit integer (never a float)"
    });
  }
  if (input.invoiceLineId !== null && typeof input.invoiceLineId !== "string") {
    errors.push({
      field: "invoiceLineId",
      message: "must be a UUID string or null"
    });
  }
  validateReason(input.reason, errors);
  return errors;
}

export function validatePaymentAllocation(
  input: PaymentAllocationInput
): BillingValidationError[] {
  const errors: BillingValidationError[] = [];
  if (
    input.allocationSource !== "manual" &&
    input.allocationSource !== "provider"
  ) {
    errors.push({
      field: "allocationSource",
      message: "must be manual or provider"
    });
  }
  // EXACT minor-unit money (signed for a reversal); a float is rejected.
  if (!isSafeMinor(input.amountMinor)) {
    errors.push({
      field: "amountMinor",
      message: "must be an exact minor-unit integer (never a float)"
    });
  }
  if (!["settled", "partial", "reversed"].includes(input.outcome)) {
    errors.push({
      field: "outcome",
      message: "must be settled/partial/reversed"
    });
  }
  if (
    input.providerReference !== null &&
    (typeof input.providerReference !== "string" ||
      input.providerReference.length > 200)
  ) {
    errors.push({
      field: "providerReference",
      message: "must be a string up to 200 chars or null"
    });
  }
  if (typeof input.markPaid !== "boolean") {
    errors.push({ field: "markPaid", message: "must be a boolean" });
  }
  validateReason(input.reason, errors, false);
  return errors;
}

export function validateSubscriptionChange(
  input: SubscriptionChangeInput
): BillingValidationError[] {
  const errors: BillingValidationError[] = [];
  if (!["upgrade", "downgrade", "cancel"].includes(input.changeType)) {
    errors.push({
      field: "changeType",
      message: "must be upgrade/downgrade/cancel"
    });
  }
  const needsTarget =
    input.changeType === "upgrade" || input.changeType === "downgrade";
  if (needsTarget) {
    if (
      input.toOfferPlanKey === null ||
      !PLAN_KEY_RE.test(input.toOfferPlanKey) ||
      input.toOfferPlanKey.length > 120
    ) {
      errors.push({
        field: "toOfferPlanKey",
        message: "required lower_snake key for upgrade/downgrade"
      });
    }
    if (
      input.toOfferVersion === null ||
      !Number.isInteger(input.toOfferVersion) ||
      input.toOfferVersion < 1
    ) {
      errors.push({
        field: "toOfferVersion",
        message: "required positive integer for upgrade/downgrade"
      });
    }
  } else {
    if (input.toOfferPlanKey !== null || input.toOfferVersion !== null) {
      errors.push({
        field: "toOfferPlanKey",
        message: "cancel must not target an offer"
      });
    }
  }
  if (
    !(PRORATION_POLICIES as readonly string[]).includes(input.prorationPolicy)
  ) {
    errors.push({
      field: "prorationPolicy",
      message: "unknown proration policy"
    });
  }
  if (
    typeof input.effectiveAt !== "string" ||
    Number.isNaN(Date.parse(input.effectiveAt))
  ) {
    errors.push({
      field: "effectiveAt",
      message: "must be an ISO-8601 timestamp"
    });
  }
  validateReason(input.reason, errors);
  return errors;
}

/** Shared helper so the create path can also validate currency read from the offer. */
export function isValidCurrency(currency: unknown): currency is string {
  return typeof currency === "string" && CURRENCY_RE.test(currency);
}
