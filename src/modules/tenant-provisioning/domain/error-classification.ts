/**
 * Provisioning error classification (Issue #872, epic #868, ADR-0022 §9). A
 * step failure is classified so the engine can decide RETRYABILITY
 * deterministically: transient/provider_unavailable/timeout errors are retried
 * (up to the step's bounded `maxAttempts`); permanent/validation/conflict/
 * dependency_missing errors are NOT auto-retried (they need operator action or
 * a fixed input). Pure — no I/O.
 */

export type ProvisioningErrorClass =
  | "transient"
  | "permanent"
  | "provider_unavailable"
  | "validation"
  | "conflict"
  | "dependency_missing"
  | "timeout";

export const PROVISIONING_ERROR_CLASSES: readonly ProvisioningErrorClass[] = [
  "transient",
  "permanent",
  "provider_unavailable",
  "validation",
  "conflict",
  "dependency_missing",
  "timeout"
];

/** The error classes that are safe to auto-retry within a step's bounded attempt budget. */
const RETRYABLE: ReadonlySet<ProvisioningErrorClass> = new Set([
  "transient",
  "provider_unavailable",
  "timeout"
]);

export function isRetryableErrorClass(
  errorClass: ProvisioningErrorClass
): boolean {
  return RETRYABLE.has(errorClass);
}

export function isProvisioningErrorClass(
  value: unknown
): value is ProvisioningErrorClass {
  return (
    typeof value === "string" &&
    (PROVISIONING_ERROR_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * Decide whether a failed step should be retried NOW, given its classified
 * error and attempt budget. A retryable class with attempts remaining ->
 * retry; anything else -> stop (the step stays failed; the run blocks or
 * compensates). Bounded by `maxAttempts` (never infinite).
 */
export function shouldRetry(
  errorClass: ProvisioningErrorClass,
  attemptCount: number,
  maxAttempts: number
): boolean {
  return isRetryableErrorClass(errorClass) && attemptCount < maxAttempts;
}

/**
 * Map an unexpected thrown error to a SAFE classification + redacted message.
 * Defensive: an unknown thrown error is `transient` (safe to retry within the
 * bounded budget) rather than silently permanent — but the message is never a
 * raw stack/secret, only the error name.
 */
export function classifyThrownError(error: unknown): {
  errorClass: ProvisioningErrorClass;
  message: string;
} {
  const name = error instanceof Error ? error.name : "UnknownError";
  return { errorClass: "transient", message: `step_error:${name}` };
}
