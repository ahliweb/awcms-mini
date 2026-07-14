/**
 * Export job status state machine (Issue #752). Pure — no I/O. Same shape
 * as `import-batch-state.ts`, simpler (export has no partial-failure
 * concept — it is a read-only snapshot of already-committed data, so a
 * failure is always all-or-nothing for the export artifact itself).
 *
 * ```
 * queued --(worker picks up)--> running --(manifest/checksum written)--> completed
 *                                   \--(error)--> failed
 * queued | running --(cancel)--> cancelled
 * ```
 */

export type ExportJobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

const ALLOWED_TRANSITIONS: Readonly<
  Record<ExportJobStatus, readonly ExportJobStatus[]>
> = {
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["running"],
  cancelled: []
};

export function canTransitionExportJobStatus(
  from: ExportJobStatus,
  to: ExportJobStatus
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isExportJobCancellable(status: ExportJobStatus): boolean {
  return status === "queued" || status === "running";
}

export function isExportJobRetryable(status: ExportJobStatus): boolean {
  return status === "failed";
}
