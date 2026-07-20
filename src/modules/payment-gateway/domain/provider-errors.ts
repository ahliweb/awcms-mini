/**
 * Safe, neutral provider error classification for `payment_gateway` (Issue
 * #877, ADR-0022 §8: "logs/audit use masked provider references and SAFE error
 * classes"). PURE. A provider call never surfaces a raw provider message/stack
 * into a log/audit/response — it is mapped to one of these bounded classes. The
 * class also decides whether a failed dispatch is RETRYABLE (transient) or
 * TERMINAL (a decline is not retried; a timeout/outage is).
 */

export type ProviderErrorClass =
  | "timeout" // no response within the deadline — retryable
  | "unavailable" // provider outage / 5xx / network — retryable
  | "rate_limited" // provider throttled us — retryable (with backoff)
  | "declined" // provider rejected the charge/refund — TERMINAL (not retried)
  | "invalid_request" // our request was malformed / config error — TERMINAL
  | "unknown"; // anything unclassified — treated as retryable (fail-safe toward reconciliation)

export const PROVIDER_ERROR_CLASSES: readonly ProviderErrorClass[] = [
  "timeout",
  "unavailable",
  "rate_limited",
  "declined",
  "invalid_request",
  "unknown"
];

const TERMINAL_CLASSES: ReadonlySet<ProviderErrorClass> = new Set([
  "declined",
  "invalid_request"
]);

/** A retryable class may be re-dispatched (up to max attempts); a terminal class fails the outbox row immediately (no retry). */
export function isRetryableErrorClass(cls: ProviderErrorClass): boolean {
  return !TERMINAL_CLASSES.has(cls);
}

export function isProviderErrorClass(
  value: unknown
): value is ProviderErrorClass {
  return (
    typeof value === "string" &&
    (PROVIDER_ERROR_CLASSES as readonly string[]).includes(value)
  );
}

/** Coerce an arbitrary value to a known class, defaulting to `"unknown"` (never leaks a raw provider string). */
export function toProviderErrorClass(value: unknown): ProviderErrorClass {
  return isProviderErrorClass(value) ? value : "unknown";
}
