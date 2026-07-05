/**
 * Standard 3-state circuit breaker (Issue 10.2, doc 16 §Connection pooling
 * dan backpressure). Pure logic, no timers/`Date.now()` calls of its own —
 * every method takes `now: Date` explicitly so tests can drive it
 * deterministically without real waits.
 *
 * States:
 * - `closed` — normal operation. `failureThreshold` consecutive failures
 *   (no intervening success) transitions to `open`.
 * - `open` — fails fast (`canAttempt` returns false) until `openDurationMs`
 *   has elapsed since the breaker opened, at which point exactly one trial
 *   call is allowed through (`half_open`).
 * - `half_open` — a single trial call is in flight. Success closes the
 *   breaker and resets the failure count; failure reopens it and resets the
 *   "open since" timestamp (a fresh `openDurationMs` window starts).
 */
export type CircuitState = "closed" | "open" | "half_open";

export type CircuitBreaker = {
  recordSuccess(now: Date): void;
  recordFailure(now: Date): void;
  canAttempt(now: Date): boolean;
  getState(now: Date): CircuitState;
};

export type CircuitBreakerOptions = {
  /** Consecutive failures (while closed) before the breaker opens. */
  failureThreshold: number;
  /** How long the breaker stays open before allowing one trial call. */
  openDurationMs: number;
};

type InternalState =
  | { kind: "closed"; consecutiveFailures: number }
  | { kind: "open"; openedAt: number }
  | { kind: "half_open" };

export function createCircuitBreaker(
  options: CircuitBreakerOptions
): CircuitBreaker {
  let state: InternalState = { kind: "closed", consecutiveFailures: 0 };

  function transitionIfOpenElapsed(now: Date): void {
    if (
      state.kind === "open" &&
      now.getTime() - state.openedAt >= options.openDurationMs
    ) {
      state = { kind: "half_open" };
    }
  }

  return {
    canAttempt(now: Date): boolean {
      transitionIfOpenElapsed(now);

      return state.kind !== "open";
    },

    recordSuccess(now: Date): void {
      transitionIfOpenElapsed(now);
      state = { kind: "closed", consecutiveFailures: 0 };
    },

    recordFailure(now: Date): void {
      transitionIfOpenElapsed(now);

      if (state.kind === "half_open") {
        state = { kind: "open", openedAt: now.getTime() };
        return;
      }

      if (state.kind === "open") {
        // Already open; a failure here just keeps it open (shouldn't
        // normally happen since canAttempt() would have returned false).
        return;
      }

      const consecutiveFailures = state.consecutiveFailures + 1;

      if (consecutiveFailures >= options.failureThreshold) {
        state = { kind: "open", openedAt: now.getTime() };
        return;
      }

      state = { kind: "closed", consecutiveFailures };
    },

    getState(now: Date): CircuitState {
      transitionIfOpenElapsed(now);

      return state.kind;
    }
  };
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_OPEN_DURATION_MS = 30_000;

let sharedDatabaseCircuitBreaker: CircuitBreaker | undefined;

/**
 * Module-level singleton shared across the whole app (not per-request), so
 * that consecutive failures across different requests/tenants accumulate
 * against the same breaker. Used by `withTenant` (tenant-context.ts) and by
 * the `/database/pool/health` endpoint.
 */
export function getDatabaseCircuitBreaker(): CircuitBreaker {
  if (!sharedDatabaseCircuitBreaker) {
    sharedDatabaseCircuitBreaker = createCircuitBreaker({
      failureThreshold: DEFAULT_FAILURE_THRESHOLD,
      openDurationMs: DEFAULT_OPEN_DURATION_MS
    });
  }

  return sharedDatabaseCircuitBreaker;
}

/** Test-only reset so breaker state doesn't leak between test cases. */
export function resetDatabaseCircuitBreakerForTests(): void {
  sharedDatabaseCircuitBreaker = undefined;
}
