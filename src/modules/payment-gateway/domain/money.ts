/**
 * Exact minor-unit money arithmetic for `payment_gateway` (Issue #877, epic
 * #868, ADR-0022 epic pattern #5). Money is ALWAYS integer minor units
 * (cents/sen) — NEVER a float/double. Every value that crosses into a JS
 * `number` is bounds-checked to `[1, MAX_SAFE_MINOR]` (a payment/refund amount is
 * strictly positive) so a `Number(...)` round-trip is exact (mirrors the DB CHECK
 * constraints in `sql/093`). Self-contained (the module owns its own domain), the
 * same discipline `subscription_billing/domain/money.ts` established.
 *
 * The mutation tests (#877) assert that a float amount, or an out-of-range/
 * non-positive value, is REJECTED here — never dispatched to a provider or
 * settled onto an invoice.
 */

/** Number.MAX_SAFE_INTEGER — the symmetric bound the DB CHECKs also enforce. */
export const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER; // 9007199254740991 (mirrors sql/093 CHECKs)

/**
 * A payment/refund minor-unit amount is valid iff it is a SAFE POSITIVE INTEGER
 * within the bound. A float (e.g. `10.5`), NaN, Infinity, zero, or an
 * out-of-range integer is rejected — the single choke point the mutation test
 * exercises.
 */
export function isSafePositiveMinor(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_SAFE_MINOR
  );
}

/** A non-negative safe minor amount (a webhook-reported amount may legitimately be 0). */
export function isSafeNonNegativeMinor(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SAFE_MINOR
  );
}

/**
 * Assert a value is a safe POSITIVE minor integer, throwing with an explicit,
 * non-sensitive message otherwise. Callers that dispatch/settle an amount MUST
 * route it through here (defence beneath the DB CHECK).
 */
export function assertSafePositiveMinor(value: unknown, field: string): number {
  if (!isSafePositiveMinor(value)) {
    throw new RangeError(
      `payment_gateway: ${field} must be an exact positive minor-unit integer within [1, ${MAX_SAFE_MINOR}] (never a float or out-of-range value); got ${String(value)}.`
    );
  }
  return value;
}
