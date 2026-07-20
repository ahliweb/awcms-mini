/**
 * The scheduled `payment_gateway` job kinds (Issue #877). Each is leased
 * per-(tenant, job_kind) so multiple workers cooperate idempotently
 * (`application/payment-lease.ts`). Mirrors the CHECK in `sql/093`.
 *
 * RUNNER STATUS (as of #877):
 *   - `outbox_dispatch` -> LIVE (`runOutboxDispatch`): dispatch pending provider
 *     work OUTSIDE any DB transaction (ADR-0006), with bounded retry/backoff,
 *     circuit breaker, and DLQ.
 *   - `reconcile`       -> LIVE (`runReconciliation`): compare provider vs local
 *     state and close drift with an audited correction (provider-outage-safe).
 *   - `expire_sweep`    -> LIVE (`runExpireSweep`): expire intents past their
 *     window that never received a settling webhook (deterministic safe state).
 */
export type PaymentJobKind = "outbox_dispatch" | "reconcile" | "expire_sweep";

export const PAYMENT_JOB_KINDS: readonly PaymentJobKind[] = [
  "outbox_dispatch",
  "reconcile",
  "expire_sweep"
];
