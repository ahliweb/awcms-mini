/**
 * Resolves a `secret_reference` pointer to an actual secret VALUE (Issue
 * #754). Same `env:VAR_NAME` indirection convention `social_publishing`'s
 * `resolveTelegramBotToken` already established for this repo (documented
 * residual: no real secret-manager integration exists here yet) — the
 * only resolvable reference kind is an environment variable. Never logs,
 * never persists, never returns the reference string itself alongside a
 * failure (only a safe, generic reason).
 */
const ENV_REFERENCE_PREFIX = /^env:(.+)$/i;

export type SecretResolution =
  { ok: true; value: string } | { ok: false; reason: string };

export function resolveSecretReference(
  secretReference: string,
  env: NodeJS.ProcessEnv = process.env
): SecretResolution {
  const trimmed = secretReference.trim();
  const match = trimmed.match(ENV_REFERENCE_PREFIX);

  if (!match) {
    return {
      ok: false,
      reason:
        "secret_reference is not an env: reference — no other secret-manager integration is available to resolve any other reference kind."
    };
  }

  const varName = match[1]!.trim();
  const value = varName ? env[varName] : undefined;

  if (!value) {
    return {
      ok: false,
      reason: `secret_reference points at env var "${varName}", which is not set.`
    };
  }

  return { ok: true, value };
}

/**
 * Key-rotation-with-overlap resolution (Issue #754 scope: "support key
 * rotation with overlap where the provider scheme permits"). Returns the
 * PREVIOUS secret's resolved value only when a rotation is genuinely in
 * progress (`secretReferencePrevious` set) AND `now` is still inside the
 * declared overlap window (`previousSecretExpiresAt`) — once that window
 * elapses, the previous secret is never resolved/tried again, even if
 * still present in the row (the endpoint-update path is responsible for
 * clearing it once expired; this function only decides whether to
 * currently OFFER it to a verifier, it never mutates anything).
 */
export function resolvePreviousSecretIfInOverlap(
  secretReferencePrevious: string | null,
  previousSecretExpiresAt: Date | null,
  now: Date,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!secretReferencePrevious || !previousSecretExpiresAt) {
    return null;
  }

  if (now.getTime() > previousSecretExpiresAt.getTime()) {
    return null;
  }

  const resolution = resolveSecretReference(secretReferencePrevious, env);

  return resolution.ok ? resolution.value : null;
}
