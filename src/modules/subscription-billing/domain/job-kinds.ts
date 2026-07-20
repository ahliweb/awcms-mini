/**
 * The scheduled `subscription_billing` job kinds (Issue #876). Each is leased
 * per-(tenant, job_kind) so multiple workers cooperate idempotently
 * (`application/billing-lease.ts`). Mirrors the CHECK in `sql/091`.
 */
export type JobKind =
  "renewal" | "invoicing" | "dunning" | "subscription_change";

export const JOB_KINDS: readonly JobKind[] = [
  "renewal",
  "invoicing",
  "dunning",
  "subscription_change"
];
