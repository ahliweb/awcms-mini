/**
 * Fail-closed domain validation of `payment_gateway` command inputs (Issue
 * #877, epic pattern #6). VALUE validity (bounds, enums, EXACT positive
 * minor-unit money, secret-pointer shape) is decided HERE; the parser
 * (`application/request-parsing.ts`) only normalizes tri-state presence. A
 * present-but-wrong-type field surfaces as a 400 here, never a silent default.
 */
import { isSafePositiveMinor } from "./money";
import { isValidSecretRefShape } from "./secret-ref";

export type ValidationError = { field: string; message: string };

const PROVIDER_KEY_RE = /^[a-z][a-z0-9_]*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const HOST_RE = /^[a-z0-9.-]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ConfigureProviderAccountInput = {
  providerKey: string;
  providerAccountRef: string;
  displayName: string | null;
  signingSecretRef: string;
  endpointHost: string;
  callbackHost: string | null;
  webhookToleranceSeconds: number;
  maxWebhookBodyBytes: number;
  status: string;
  reason: string | null;
};

export function validateConfigureProviderAccount(
  input: ConfigureProviderAccountInput
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (
    typeof input.providerKey !== "string" ||
    !PROVIDER_KEY_RE.test(input.providerKey) ||
    input.providerKey.length > 60
  ) {
    errors.push({
      field: "providerKey",
      message: "must be snake_case, <= 60 chars."
    });
  }
  if (
    typeof input.providerAccountRef !== "string" ||
    input.providerAccountRef.length < 1 ||
    input.providerAccountRef.length > 200
  ) {
    errors.push({
      field: "providerAccountRef",
      message: "required, 1..200 chars."
    });
  }
  // A LITERAL secret can never be stored — only the `env:VAR_NAME` pointer shape.
  if (!isValidSecretRefShape(input.signingSecretRef)) {
    errors.push({
      field: "signingSecretRef",
      message: "must be an env:VAR_NAME pointer (never a literal secret)."
    });
  }
  if (
    typeof input.endpointHost !== "string" ||
    !HOST_RE.test(input.endpointHost) ||
    input.endpointHost.length > 255
  ) {
    errors.push({
      field: "endpointHost",
      message: "must be a bare lower-case hostname."
    });
  }
  if (
    input.callbackHost !== null &&
    (typeof input.callbackHost !== "string" ||
      !HOST_RE.test(input.callbackHost) ||
      input.callbackHost.length > 255)
  ) {
    errors.push({
      field: "callbackHost",
      message: "must be a bare lower-case hostname or null."
    });
  }
  if (
    !Number.isInteger(input.webhookToleranceSeconds) ||
    input.webhookToleranceSeconds < 1 ||
    input.webhookToleranceSeconds > 300
  ) {
    errors.push({
      field: "webhookToleranceSeconds",
      message: "must be an integer 1..300 (ADR-0022 §9 window <= 300s)."
    });
  }
  if (
    !Number.isInteger(input.maxWebhookBodyBytes) ||
    input.maxWebhookBodyBytes < 256 ||
    input.maxWebhookBodyBytes > 1048576
  ) {
    errors.push({
      field: "maxWebhookBodyBytes",
      message: "must be an integer 256..1048576."
    });
  }
  if (input.status !== "active" && input.status !== "disabled") {
    errors.push({ field: "status", message: "must be active|disabled." });
  }
  if (
    input.reason !== null &&
    (typeof input.reason !== "string" || input.reason.length > 2000)
  ) {
    errors.push({
      field: "reason",
      message: "must be a string <= 2000 chars or null."
    });
  }
  return errors;
}

export type InitiateCheckoutInput = {
  providerAccountId: string;
  invoiceId: string;
  subscriptionId: string | null;
  amountMinor: number;
  currency: string;
  expiresInMinutes: number | null;
  reason: string;
};

export function validateInitiateCheckout(
  input: InitiateCheckoutInput
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (
    typeof input.providerAccountId !== "string" ||
    !UUID_RE.test(input.providerAccountId)
  ) {
    errors.push({ field: "providerAccountId", message: "must be a UUID." });
  }
  if (typeof input.invoiceId !== "string" || !UUID_RE.test(input.invoiceId)) {
    errors.push({ field: "invoiceId", message: "must be a UUID." });
  }
  if (
    input.subscriptionId !== null &&
    (typeof input.subscriptionId !== "string" ||
      !UUID_RE.test(input.subscriptionId))
  ) {
    errors.push({
      field: "subscriptionId",
      message: "must be a UUID or null."
    });
  }
  if (!isSafePositiveMinor(input.amountMinor)) {
    errors.push({
      field: "amountMinor",
      message: "must be an exact positive minor-unit integer (never a float)."
    });
  }
  if (typeof input.currency !== "string" || !CURRENCY_RE.test(input.currency)) {
    errors.push({
      field: "currency",
      message: "must be a 3-letter ISO currency code."
    });
  }
  if (
    input.expiresInMinutes !== null &&
    (!Number.isInteger(input.expiresInMinutes) ||
      input.expiresInMinutes < 1 ||
      input.expiresInMinutes > 43200)
  ) {
    errors.push({
      field: "expiresInMinutes",
      message: "must be an integer 1..43200 or null."
    });
  }
  if (
    typeof input.reason !== "string" ||
    input.reason.length < 1 ||
    input.reason.length > 2000
  ) {
    errors.push({ field: "reason", message: "required, 1..2000 chars." });
  }
  return errors;
}

export type CancelSessionInput = {
  reason: string;
  expectedVersion: number | null;
};

export function validateCancelSession(
  input: CancelSessionInput
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (
    typeof input.reason !== "string" ||
    input.reason.length < 1 ||
    input.reason.length > 2000
  ) {
    errors.push({ field: "reason", message: "required, 1..2000 chars." });
  }
  if (
    input.expectedVersion !== null &&
    !Number.isInteger(input.expectedVersion)
  ) {
    errors.push({
      field: "expectedVersion",
      message: "must be an integer or null."
    });
  }
  return errors;
}

export type RequestRefundInput = {
  amountMinor: number;
  reason: string;
};

export function validateRequestRefund(
  input: RequestRefundInput
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isSafePositiveMinor(input.amountMinor)) {
    errors.push({
      field: "amountMinor",
      message: "must be an exact positive minor-unit integer (never a float)."
    });
  }
  // Refund reason is MANDATORY (ADR-0022 §8).
  if (
    typeof input.reason !== "string" ||
    input.reason.length < 1 ||
    input.reason.length > 2000
  ) {
    errors.push({
      field: "reason",
      message: "mandatory refund reason, 1..2000 chars."
    });
  }
  return errors;
}

export type SimpleReasonInput = { reason: string };

export function validateSimpleReason(
  input: SimpleReasonInput
): ValidationError[] {
  if (
    typeof input.reason !== "string" ||
    input.reason.length < 1 ||
    input.reason.length > 2000
  ) {
    return [{ field: "reason", message: "required, 1..2000 chars." }];
  }
  return [];
}
