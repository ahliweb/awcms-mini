/**
 * Billing period boundary math (Issue #876). Pure, deterministic, timezone-safe
 * (UTC). A period is [start, end): `nextPeriodEnd` advances `start` by the
 * billing interval. `daysInPeriod` / `elapsedDays` feed the EXACT proration in
 * `money.ts` (BigInt), never a float.
 */
export type BillingInterval = "day" | "week" | "month" | "quarter" | "year";

const MS_PER_DAY = 86_400_000;

export function nextPeriodEnd(start: Date, interval: BillingInterval): Date {
  const d = new Date(start.getTime());
  switch (interval) {
    case "day":
      d.setUTCDate(d.getUTCDate() + 1);
      return d;
    case "week":
      d.setUTCDate(d.getUTCDate() + 7);
      return d;
    case "month":
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
    case "quarter":
      d.setUTCMonth(d.getUTCMonth() + 3);
      return d;
    case "year":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      return d;
    default: {
      const _exhaustive: never = interval;
      return _exhaustive;
    }
  }
}

/** Whole-day span of a period, floored at 1 (a same-day period still prorates against >=1 day). */
export function daysInPeriod(start: Date, end: Date): number {
  const days = Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY);
  return days >= 1 ? days : 1;
}

/** Whole days elapsed from `start` to `at`, clamped to [0, daysInPeriod]. */
export function elapsedDays(start: Date, end: Date, at: Date): number {
  const total = daysInPeriod(start, end);
  const elapsed = Math.floor((at.getTime() - start.getTime()) / MS_PER_DAY);
  if (elapsed < 0) return 0;
  if (elapsed > total) return total;
  return elapsed;
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return (
    value === "day" ||
    value === "week" ||
    value === "month" ||
    value === "quarter" ||
    value === "year"
  );
}
