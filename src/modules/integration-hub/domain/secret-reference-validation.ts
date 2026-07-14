/**
 * Write-time validation restricting which env var an `integration_hub`
 * `secret_reference` may point at (security-auditor finding, PR #784).
 *
 * `application/secret-resolver.ts`'s `resolveSecretReference` accepts ANY
 * `env:<VAR_NAME>` reference with no restriction on the var name — a
 * tenant holding only an ordinary `endpoints.create`/`.configure` or
 * `subscriptions.create` permission could reference an UNRELATED
 * process-wide secret (any other module's provider credential, a DB
 * password, etc.), then use repeated signed-webhook delivery attempts
 * (200 vs 401 = a boolean equality oracle) to probe whether a guessed
 * value matches that secret — a confused-deputy bypass of per-module
 * secret compartmentalization. Low practical exploitability against a
 * genuinely high-entropy secret (one guess per request), but worth
 * closing now that it is flagged.
 *
 * Fix: require every referenced env var name to carry this module's own
 * naming prefix, enforced ONLY at WRITE time (endpoint create/rotate-
 * secret, subscription create) — this keeps the reachable set to
 * variables an operator has already deliberately provisioned for
 * `integration_hub` webhook secrets specifically (doc 18 convention),
 * never an arbitrary process-wide name. Resolution itself
 * (`resolveSecretReference`) deliberately stays permissive/unchanged — it
 * only ever runs against a reference that ALREADY passed this check at
 * write time (or, for `secret_reference_previous`, was copied verbatim
 * from a row that passed it when it was still the primary reference).
 */
const REQUIRED_ENV_VAR_PREFIX = "INTEGRATION_HUB_";
const ENV_REFERENCE_PATTERN = /^env:([A-Za-z0-9_]+)$/i;

export type SecretReferenceValidationResult =
  { ok: true } | { ok: false; reason: string };

export function validateSecretReferenceNaming(
  secretReference: string
): SecretReferenceValidationResult {
  const trimmed = secretReference.trim();
  const match = trimmed.match(ENV_REFERENCE_PATTERN);

  if (!match) {
    return {
      ok: false,
      reason: 'secretReference must be an "env:VAR_NAME" reference.'
    };
  }

  const varName = match[1]!;

  if (!varName.toUpperCase().startsWith(REQUIRED_ENV_VAR_PREFIX)) {
    return {
      ok: false,
      reason: `secretReference's env var name must start with "${REQUIRED_ENV_VAR_PREFIX}" — referencing an unrelated process-wide environment variable is not allowed.`
    };
  }

  return { ok: true };
}

export class InvalidSecretReferenceError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid secretReference: ${reason}`);
    this.name = "InvalidSecretReferenceError";
    this.reason = reason;
  }
}

/** Throws `InvalidSecretReferenceError` when `secretReference` fails naming validation — the assert-style wrapper every write-path call site uses. */
export function assertValidSecretReferenceNaming(
  secretReference: string
): void {
  const result = validateSecretReferenceNaming(secretReference);

  if (!result.ok) {
    throw new InvalidSecretReferenceError(result.reason);
  }
}
