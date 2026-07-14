/**
 * Pure adapter-health state machine (Issue #754 scope: "provider health —
 * track adapter up/down/degraded state"). Consecutive-failure/success
 * counting only, no I/O, no timers — same "pure function, `now`/state
 * passed in explicitly" shape as `src/lib/database/circuit-breaker.ts`.
 * This is DELIBERATELY simpler than the full 3-state circuit breaker
 * (`createCircuitBreaker`): that one exists to gate WHETHER a call is
 * attempted at all (fail-fast); this one only reports OBSERVED health for
 * admin visibility (`GET /api/v1/integration-hub/health`) — the outbound
 * dispatch job still attempts every due delivery regardless of this
 * state, and separately consults an in-memory `getProviderCircuitBreaker`
 * instance (keyed per subscription) to decide whether to skip a call this
 * pass, mirroring `email-dispatch.ts`'s own two-layer pattern (breaker
 * gates attempts; this table is the persisted, cross-restart-visible
 * observability signal).
 */
export type AdapterHealthState = "up" | "degraded" | "down";

export type AdapterHealthSnapshot = {
  state: AdapterHealthState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
};

/** 3 consecutive failures -> degraded (still attempting), 8 -> down (still attempting, but flagged for operator attention — the dispatch job itself never stops trying based on this table alone; only the in-memory circuit breaker fails fast). */
export const ADAPTER_HEALTH_DEGRADED_THRESHOLD = 3;
export const ADAPTER_HEALTH_DOWN_THRESHOLD = 8;

export function applyHealthSuccess(
  current: AdapterHealthSnapshot
): AdapterHealthSnapshot {
  return {
    state: "up",
    consecutiveFailures: 0,
    consecutiveSuccesses: current.consecutiveSuccesses + 1
  };
}

export function applyHealthFailure(
  current: AdapterHealthSnapshot
): AdapterHealthSnapshot {
  const consecutiveFailures = current.consecutiveFailures + 1;
  let state: AdapterHealthState = "up";

  if (consecutiveFailures >= ADAPTER_HEALTH_DOWN_THRESHOLD) {
    state = "down";
  } else if (consecutiveFailures >= ADAPTER_HEALTH_DEGRADED_THRESHOLD) {
    state = "degraded";
  }

  return {
    state,
    consecutiveFailures,
    consecutiveSuccesses: 0
  };
}
