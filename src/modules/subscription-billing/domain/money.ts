/**
 * Exact minor-unit money arithmetic for `subscription_billing` (Issue #876,
 * epic #868, ADR-0022 epic pattern #5). Money is ALWAYS integer minor units
 * (cents/sen) — NEVER a float/double. All arithmetic runs through `bigint` so
 * intermediate products never lose precision, and every value that crosses back
 * into a JS `number` is bounds-checked to `[-MAX_SAFE_MINOR, MAX_SAFE_MINOR]`
 * so a `Number(...)` round-trip is exact (mirrors the DB CHECK constraints in
 * `sql/091`). The rounding policy is EXPLICIT (`RoundingMode`) so proration and
 * every derived amount is reproducible.
 *
 * The mutation tests (#876) assert that a float amount, or an arithmetic path
 * that could silently overflow the safe range, is REJECTED here — never
 * persisted.
 */

/** Number.MAX_SAFE_INTEGER — the symmetric bound the DB CHECKs also enforce. */
export const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER; // 9007199254740991 (mirrors sql/091 CHECKs)
const MAX_SAFE_MINOR_BIG = BigInt(MAX_SAFE_MINOR);

export type RoundingMode = "half_up" | "half_even" | "floor" | "ceil";

export const ROUNDING_MODES: readonly RoundingMode[] = [
  "half_up",
  "half_even",
  "floor",
  "ceil"
];

export function isRoundingMode(value: unknown): value is RoundingMode {
  return (
    typeof value === "string" &&
    (ROUNDING_MODES as readonly string[]).includes(value)
  );
}

/**
 * A minor-unit amount is valid iff it is a SAFE INTEGER within the symmetric
 * bound. A float (e.g. `10.5`), NaN, Infinity, or an out-of-range integer is
 * rejected — the single choke point the mutation test exercises.
 */
export function isSafeMinor(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -MAX_SAFE_MINOR &&
    value <= MAX_SAFE_MINOR
  );
}

/** A non-negative safe minor amount (prices, quantities, credit magnitudes). */
export function isSafeNonNegativeMinor(value: unknown): value is number {
  return isSafeMinor(value) && value >= 0;
}

/**
 * Assert a value is a safe minor integer, throwing with an explicit,
 * non-sensitive message otherwise. Callers that persist an amount MUST route it
 * through here (defence beneath the DB CHECK).
 */
export function assertSafeMinor(value: unknown, field: string): number {
  if (!isSafeMinor(value)) {
    throw new RangeError(
      `subscription_billing: ${field} must be an exact minor-unit integer within +/-${MAX_SAFE_MINOR} (never a float or out-of-range value); got ${String(value)}.`
    );
  }
  return value;
}

/** Sum minor amounts with a hard overflow guard (BigInt intermediate). */
export function sumMinor(values: readonly number[]): number {
  let acc = 0n;
  for (const value of values) {
    assertSafeMinor(value, "line amount");
    acc += BigInt(value);
  }
  return fromBig(acc, "sum");
}

/** Multiply an amount by an integer quantity, overflow-guarded. */
export function multiplyMinor(amount: number, quantity: number): number {
  assertSafeMinor(amount, "unit amount");
  if (
    !Number.isInteger(quantity) ||
    quantity < 0 ||
    quantity > MAX_SAFE_MINOR
  ) {
    throw new RangeError(
      `subscription_billing: quantity must be a non-negative safe integer; got ${String(quantity)}.`
    );
  }
  return fromBig(BigInt(amount) * BigInt(quantity), "product");
}

/**
 * Prorate `amount` by the exact rational `numerator/denominator` (e.g. days
 * used / days in period) using the given rounding mode. All math is BigInt; the
 * fractional decision is made on the exact remainder, never on a float.
 */
export function prorateMinor(
  amount: number,
  numerator: number,
  denominator: number,
  mode: RoundingMode
): number {
  assertSafeMinor(amount, "prorate amount");
  if (
    !Number.isInteger(numerator) ||
    !Number.isInteger(denominator) ||
    denominator <= 0 ||
    numerator < 0 ||
    numerator > denominator
  ) {
    throw new RangeError(
      `subscription_billing: proration ratio ${String(numerator)}/${String(denominator)} must satisfy 0 <= numerator <= denominator and denominator > 0.`
    );
  }
  const product = BigInt(amount) * BigInt(numerator);
  const denom = BigInt(denominator);
  return fromBig(divideRounded(product, denom, mode), "prorate");
}

/**
 * Integer division of `numerator/denominator` with the given rounding mode,
 * exact on the remainder. Works for non-negative numerator/positive denominator
 * (the only shape proration produces).
 */
export function divideRounded(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode
): bigint {
  if (denominator <= 0n) {
    throw new RangeError("subscription_billing: denominator must be positive.");
  }
  const q = numerator / denominator; // truncates toward zero; numerator >= 0 here
  const r = numerator % denominator;
  if (r === 0n) return q;
  const twiceR = r * 2n;
  switch (mode) {
    case "floor":
      return q;
    case "ceil":
      return q + 1n;
    case "half_up":
      return twiceR >= denominator ? q + 1n : q;
    case "half_even": {
      if (twiceR > denominator) return q + 1n;
      if (twiceR < denominator) return q;
      // Exactly half -> round to even.
      return q % 2n === 0n ? q : q + 1n;
    }
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function fromBig(value: bigint, field: string): number {
  if (value > MAX_SAFE_MINOR_BIG || value < -MAX_SAFE_MINOR_BIG) {
    throw new RangeError(
      `subscription_billing: ${field} overflowed the safe minor-unit range +/-${MAX_SAFE_MINOR}.`
    );
  }
  return Number(value);
}
