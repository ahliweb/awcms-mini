import { createHmac } from "node:crypto";

/**
 * Issue #821 — audit attributes for authentication events need to answer
 * "which source is this?" (brute-force / credential-stuffing forensics)
 * without persisting a raw client IP.
 *
 * A raw IP cannot go into audit `attributes`: `src/modules/_shared/redaction.ts`
 * deliberately treats `ip`/`ipAddress`/`clientIp`/`remoteAddr`/`x-forwarded-for`
 * as sensitive (Issue #687) and would replace the value with `"[REDACTED]"`
 * anyway — an unusable, permanently blank column. Renaming the key to dodge
 * that redaction would be a security regression, not a fix.
 *
 * A *keyed* hash resolves both requirements at once: the stored value is
 * stable, so an operator can group audit rows by source ("40 `login_failed`
 * rows, same `ipHash`, 40 different accounts" — the exact signal the audit
 * exists for), while the address itself is not recoverable from the audit
 * trail.
 *
 * Keyed (HMAC) rather than a plain digest on purpose: the IPv4 space is only
 * 2^32, so an unsalted `sha256(ip)` is exhaustively reversible in seconds and
 * would be pseudonymization in name only.
 */
const IP_HASH_PREFIX = "hmac-sha256:";

/**
 * Reuses `AUTH_JWT_SECRET` (already a *required* env var — see
 * `scripts/validate-env.ts`'s required list) rather than introducing another
 * secret to provision, rotate, and validate for a purely internal
 * pseudonymization key.
 *
 * Falls back to an empty key when unset so that unit tests and local
 * throwaway runs still produce a stable, well-formed value instead of
 * throwing inside an auth path. That degrades the hash to an effectively
 * unsalted digest, which is acceptable *only* because `validate-env` refuses
 * to start any real deployment without `AUTH_JWT_SECRET` — never rely on this
 * fallback in production.
 *
 * Read per call, not cached at module load, so a test (or a rotated secret)
 * that changes `process.env.AUTH_JWT_SECRET` takes effect immediately.
 */
function resolveIpHashKey(): string {
  return process.env.AUTH_JWT_SECRET ?? "";
}

/**
 * Stable, non-reversible pseudonym for a client IP, safe to persist in audit
 * `attributes` under the key `ipHash` (which no redaction rule matches — it
 * normalizes to `iphash`, which is neither an entry of the exact-match IP
 * synonym allowlist nor a substring of any redaction key).
 */
export function hashClientIp(ip: string): string {
  return (
    IP_HASH_PREFIX +
    createHmac("sha256", resolveIpHashKey()).update(ip).digest("hex")
  );
}

/**
 * Upper bound on the persisted `User-Agent`. The header is fully
 * attacker-controlled and unbounded in practice, so it is truncated before it
 * ever reaches a `jsonb` column — an audit row must never become an
 * attacker-sized write amplifier on a public, unauthenticated endpoint.
 */
const MAX_USER_AGENT_LENGTH = 256;

/**
 * The request's `User-Agent`, truncated, or `undefined` when absent/blank so
 * the key is simply omitted from audit attributes rather than stored as an
 * empty string.
 */
export function summarizeUserAgent(request: Request): string | undefined {
  const userAgent = request.headers.get("user-agent")?.trim();

  if (!userAgent) {
    return undefined;
  }

  return userAgent.slice(0, MAX_USER_AGENT_LENGTH);
}
