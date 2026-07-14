/**
 * Reconciliation comparison (Issue #752 acceptance criterion: "export
 * manifest ... reconciliation can detect a deliberate mismatch"). Pure —
 * no I/O — compares counts/checksums already read by the caller
 * (`application/reconciliation-service.ts`) and returns a structured
 * verdict; persistence and audit/event emission stay in the application
 * layer.
 */

export type ReconciliationInput = {
  sourceCount: number;
  processedCount: number;
  sourceChecksumSha256: string | null;
  processedChecksumSha256: string | null;
};

export type ReconciliationVerdict = {
  mismatch: boolean;
  countMismatch: boolean;
  checksumMismatch: boolean;
  details: string;
};

/**
 * `sourceChecksumSha256`/`processedChecksumSha256` are compared ONLY when
 * both are present — a `null` checksum means "not computed for this
 * subject" (e.g. an import batch whose commit adapter does not report a
 * per-row checksum), not "checksum matched by default". A count mismatch
 * alone is always enough to flag `mismatch: true` regardless of checksum
 * availability.
 */
export function evaluateReconciliation(
  input: ReconciliationInput
): ReconciliationVerdict {
  const countMismatch = input.sourceCount !== input.processedCount;

  const checksumMismatch =
    input.sourceChecksumSha256 !== null &&
    input.processedChecksumSha256 !== null &&
    input.sourceChecksumSha256 !== input.processedChecksumSha256;

  const mismatch = countMismatch || checksumMismatch;

  const detailParts: string[] = [
    `source count ${input.sourceCount} vs processed count ${input.processedCount}${countMismatch ? " (MISMATCH)" : ""}`
  ];

  if (
    input.sourceChecksumSha256 !== null &&
    input.processedChecksumSha256 !== null
  ) {
    detailParts.push(
      checksumMismatch ? "checksum MISMATCH" : "checksum matched"
    );
  } else {
    detailParts.push("checksum not compared (one or both sides missing)");
  }

  return {
    mismatch,
    countMismatch,
    checksumMismatch,
    details: detailParts.join("; ")
  };
}
