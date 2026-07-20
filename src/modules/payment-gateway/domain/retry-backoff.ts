/**
 * Bounded retry/backoff + circuit-breaker math for `payment_gateway` (Issue
 * #877, ADR-0022 §9). PURE — no I/O, no clock (the caller passes `now`). A
 * failed outbound dispatch is retried with EXPONENTIAL backoff up to
 * `maxAttempts`; the row then moves to the DLQ (`dead`). A circuit breaker opens
 * after a run of consecutive failures so a provider outage stops hammering the
 * provider — reconciliation (not the webhook) becomes the source of truth.
 */

/** Base backoff (ms) — attempt N waits `base * 2^(N-1)`, capped at `MAX_BACKOFF_MS`. */
export const BASE_BACKOFF_MS = 30_000; // 30s
export const MAX_BACKOFF_MS = 3_600_000; // 1h

export function nextBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  const raw = BASE_BACKOFF_MS * 2 ** (n - 1);
  return Math.min(raw, MAX_BACKOFF_MS);
}

export function nextAttemptAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + nextBackoffMs(attempts));
}

/** `true` once `attempts` has reached `maxAttempts` — the row is dead-lettered rather than retried again. */
export function isExhausted(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

// -------------------------------------------------------------------------
// Circuit breaker
// -------------------------------------------------------------------------

export const CIRCUIT_OPEN_THRESHOLD = 5; // consecutive failures before opening
export const CIRCUIT_OPEN_MS = 300_000; // 5 min cool-down

export type HealthState = "up" | "degraded" | "down";

export type HealthSnapshot = {
  state: HealthState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  circuitOpenUntil: Date | null;
};

export function applyHealthSuccess(current: HealthSnapshot): HealthSnapshot {
  return {
    state: "up",
    consecutiveFailures: 0,
    consecutiveSuccesses: current.consecutiveSuccesses + 1,
    circuitOpenUntil: null
  };
}

export function applyHealthFailure(
  current: HealthSnapshot,
  now: Date
): HealthSnapshot {
  const failures = current.consecutiveFailures + 1;
  if (failures >= CIRCUIT_OPEN_THRESHOLD) {
    return {
      state: "down",
      consecutiveFailures: failures,
      consecutiveSuccesses: 0,
      circuitOpenUntil: new Date(now.getTime() + CIRCUIT_OPEN_MS)
    };
  }
  return {
    state: "degraded",
    consecutiveFailures: failures,
    consecutiveSuccesses: 0,
    circuitOpenUntil: null
  };
}

/** `true` when the breaker is open (dispatch should be skipped until `circuitOpenUntil`). */
export function isCircuitOpen(snapshot: HealthSnapshot, now: Date): boolean {
  return (
    snapshot.circuitOpenUntil !== null &&
    snapshot.circuitOpenUntil.getTime() > now.getTime()
  );
}
