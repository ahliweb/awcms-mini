/**
 * Import batch status state machine (Issue #752). Pure — no I/O. Mirrors
 * the shape `organization-unit-hierarchy.ts`'s pure graph validators use:
 * a plain function callers (`application/import-batch-directory.ts`,
 * `import-parse-validate-job.ts`, `import-commit-job.ts`) consult BEFORE
 * writing a status transition, inside the same transaction as the write —
 * this file never touches the database itself.
 *
 * ```
 * staged --(worker picks up)--> validating --(parse ok)--> previewed
 *                                    \--(structural parse failure)--> failed
 * previewed --(commit triggered)--> committing
 * committing --(all rows committed)--> committed
 * committing --(some rows failed, non-retryable)--> partially_committed
 * committing --(worker restart, still in progress)--> committing  [self, resume]
 * partially_committed --(retry)--> committing
 * failed --(retry, commit-phase failure only)--> committing
 * staged | validating | previewed | failed --(cancel)--> cancelled
 * ```
 *
 * `committed`/`cancelled` are terminal — no further transition is valid
 * once reached (a corrected import is a NEW batch, never a mutated old
 * one, matching this repo's append-only/no-overwrite convention for
 * completed work).
 */

export type ImportBatchStatus =
  | "staged"
  | "validating"
  | "previewed"
  | "committing"
  | "committed"
  | "partially_committed"
  | "failed"
  | "cancelled";

const TERMINAL_STATUSES: ReadonlySet<ImportBatchStatus> = new Set([
  "committed",
  "cancelled"
]);

const ALLOWED_TRANSITIONS: Readonly<
  Record<ImportBatchStatus, readonly ImportBatchStatus[]>
> = {
  staged: ["validating", "cancelled"],
  validating: ["previewed", "failed", "cancelled"],
  previewed: ["committing", "cancelled"],
  committing: ["committed", "partially_committed", "committing"],
  partially_committed: ["committing"],
  failed: ["committing", "cancelled"],
  committed: [],
  cancelled: []
};

export function isTerminalImportBatchStatus(
  status: ImportBatchStatus
): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransitionImportBatchStatus(
  from: ImportBatchStatus,
  to: ImportBatchStatus
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** `true` for exactly the statuses `application/import-batch-directory.ts`'s cancel action accepts as a starting point — before any real commit work has begun (matches this repo's "cancel means stop before mutation, not undo a mutation" convention, same reasoning `data_lifecycle`'s dry-run-only on-demand endpoint documents for its own zero-mutation guarantee). */
export function isImportBatchCancellable(status: ImportBatchStatus): boolean {
  return (
    status === "staged" ||
    status === "validating" ||
    status === "previewed" ||
    status === "failed"
  );
}

/** `true` for exactly the statuses the retry/resume action accepts — a commit-phase failure (`partially_committed`) or a batch marked `failed` DURING the commit phase (worker crash mid-commit, surfaced as `failed` by the job runner's own error path). A `failed` batch that never got past validation (structural parse failure) is also retryable here — the caller re-triggers the SAME parse/validate/commit pipeline from the top, which is safe because `validateRow`/parsing are pure and re-running them is not itself a mutation. */
export function isImportBatchRetryable(status: ImportBatchStatus): boolean {
  return status === "partially_committed" || status === "failed";
}
