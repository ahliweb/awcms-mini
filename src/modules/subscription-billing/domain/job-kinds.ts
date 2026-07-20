/**
 * The scheduled `subscription_billing` job kinds (Issue #876). Each is leased
 * per-(tenant, job_kind) so multiple workers cooperate idempotently
 * (`application/billing-lease.ts`). Mirrors the CHECK in `sql/091` — the full set
 * is declared here (and in the DB CHECK) so leases exist for future runners.
 *
 * RUNNER STATUS (as of #876):
 *   - `renewal`  -> LIVE  (`runBillingRenewal`, rolls periods + generates drafts).
 *   - `dunning`  -> LIVE  (`runBillingDunning`, requests lifecycle transitions).
 *   - `invoicing`           -> RESERVED / not-yet-scheduled (invoicing currently
 *       runs inside the `renewal` pass; a standalone invoicing runner is future).
 *   - `subscription_change` -> RESERVED / not-yet-scheduled (change APPLY is out
 *       of scope for #876; only SCHEDULING exists — see subscription-change-engine).
 * Reserved kinds are kept in the union/CHECK deliberately; do NOT drop them.
 */
export type JobKind =
  "renewal" | "invoicing" | "dunning" | "subscription_change";

export const JOB_KINDS: readonly JobKind[] = [
  "renewal",
  "invoicing",
  "dunning",
  "subscription_change"
];
