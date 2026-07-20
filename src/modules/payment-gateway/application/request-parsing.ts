/**
 * Fail-closed defensive parsing of untrusted `payment_gateway` command bodies
 * (Issue #877, epic pattern #6). Same discipline as the sibling control-plane
 * parsers: ABSENT scalar/enum -> neutral default; PRESENT field -> kept VERBATIM
 * so the domain validator rejects a wrong type/value (400) — never coerced;
 * nullable -> tri-state (absent -> null; present -> verbatim); present-but-not-
 * an-object body -> `{}` so required-field checks fail. VALUE validity is the
 * domain layer (`domain/request-validation.ts`).
 */
import type {
  CancelSessionInput,
  ConfigureProviderAccountInput,
  InitiateCheckoutInput,
  RequestRefundInput,
  SimpleReasonInput
} from "../domain/request-validation";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(
  record: Record<string, unknown>,
  key: string
): string | null {
  if (!(key in record)) return null;
  return record[key] as string | null;
}

function nullableNumber(
  record: Record<string, unknown>,
  key: string
): number | null {
  if (!(key in record)) return null;
  return record[key] as number | null;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  return key in record ? (record[key] as number) : NaN;
}

export function parseConfigureProviderAccountBody(
  body: unknown
): ConfigureProviderAccountInput {
  const record = asRecord(body);
  return {
    providerKey: asString(record.providerKey),
    providerAccountRef: asString(record.providerAccountRef),
    displayName: nullableString(record, "displayName"),
    signingSecretRef: asString(record.signingSecretRef),
    endpointHost: asString(record.endpointHost),
    callbackHost: nullableString(record, "callbackHost"),
    webhookToleranceSeconds:
      "webhookToleranceSeconds" in record
        ? requiredNumber(record, "webhookToleranceSeconds")
        : 300,
    maxWebhookBodyBytes:
      "maxWebhookBodyBytes" in record
        ? requiredNumber(record, "maxWebhookBodyBytes")
        : 65536,
    status: "status" in record ? asString(record.status) : "active",
    reason: nullableString(record, "reason")
  };
}

export function parseInitiateCheckoutBody(
  body: unknown
): InitiateCheckoutInput {
  const record = asRecord(body);
  return {
    providerAccountId: asString(record.providerAccountId),
    invoiceId: asString(record.invoiceId),
    subscriptionId: nullableString(record, "subscriptionId"),
    amountMinor: requiredNumber(record, "amountMinor"),
    currency: asString(record.currency),
    expiresInMinutes: nullableNumber(record, "expiresInMinutes"),
    reason: asString(record.reason)
  };
}

export function parseCancelSessionBody(body: unknown): CancelSessionInput {
  const record = asRecord(body);
  return {
    reason: asString(record.reason),
    expectedVersion: nullableNumber(record, "expectedVersion")
  };
}

export function parseRequestRefundBody(body: unknown): RequestRefundInput {
  const record = asRecord(body);
  return {
    amountMinor: requiredNumber(record, "amountMinor"),
    reason: asString(record.reason)
  };
}

export function parseSimpleReasonBody(body: unknown): SimpleReasonInput {
  const record = asRecord(body);
  return { reason: asString(record.reason) };
}

/**
 * The MATERIAL fields of an initiate-checkout request, in the exact shape hashed
 * for idempotency (doc 10). Exported so a unit test can PROVE the hash covers the
 * RESOURCE id (invoiceId + providerAccountId) + money + currency — a same-key
 * replay with a different amount/invoice must NOT silently return the first
 * outcome (lesson [[idempotency-hash-missing-resource-id-recurring]]).
 */
export function initiateCheckoutIdempotencyFields(
  tenantId: string,
  input: InitiateCheckoutInput
): Record<string, unknown> {
  return {
    tenantId,
    providerAccountId: input.providerAccountId,
    invoiceId: input.invoiceId,
    subscriptionId: input.subscriptionId,
    amountMinor: input.amountMinor,
    currency: input.currency
  };
}

/** Idempotency fields for a refund request — resource id (intentId) + money + reason. */
export function requestRefundIdempotencyFields(
  tenantId: string,
  intentId: string,
  input: RequestRefundInput
): Record<string, unknown> {
  return {
    tenantId,
    intentId,
    amountMinor: input.amountMinor,
    reason: input.reason
  };
}
