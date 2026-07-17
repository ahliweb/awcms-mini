import { createHmac } from "node:crypto";

import { findConfigVarEntry } from "../config/registry";

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
 * pseudonymization key. Key separation would be sound in the abstract, but
 * there is nothing here to separate FROM: `AUTH_JWT_SECRET` signs nothing
 * (sessions are opaque random tokens; `src/lib/auth/jwt-verify.ts` verifies
 * provider ID tokens with RS256 against published JWKS), so no
 * cross-protocol reuse exists — and a brand-new required secret would break
 * every already-provisioned deployment for no security gain.
 *
 * Because this IS now that variable's only consumer, its `deprecated` +
 * `removalVersion: "1.0.0"` marking in `src/lib/config/registry.ts` was
 * lifted (PR #839 security review): a variable scheduled for removal must
 * never be load-bearing for a security control.
 *
 * Throws rather than falling back to an empty key. An empty key degrades
 * this HMAC to a bare `sha256(ip)` — and the IPv4 space is 2^32, so every
 * persisted `ipHash` would become trivially reversible, silently, with no
 * error anywhere. A hard failure inside the auth path is strictly preferable
 * to an auth trail that quietly becomes a log of plaintext addresses.
 *
 * The documented placeholder is rejected HERE, not only by
 * `scripts/validate-env.ts`'s `checkAuthJwtSecretNotDefault`. That validator
 * is correct and wired into `runEnvValidation`, but nothing forces it to run:
 * `bun run dev` and `bun run start` invoke the server directly, never
 * `config:validate`. A deployment copied from `.env.example` therefore boots
 * happily with `AUTH_JWT_SECRET` still set to a value published in a PUBLIC
 * repo — keying this HMAC with public knowledge and making every persisted
 * `ipHash` reversible, which is the one property the whole pseudonym exists
 * to provide. A check that only runs when an operator remembers to run it is
 * not a control; this one cannot be bypassed by any entry path.
 * (Review finding, PR #839.)
 *
 * The placeholder is read from the registry entry's own `default` rather than
 * re-typed here, exactly as `checkAuthJwtSecretNotDefault` does, so the two
 * cannot drift from each other or from `.env.example`.
 *
 * Read per call, not cached at module load, so a test (or a rotated secret)
 * that changes `process.env.AUTH_JWT_SECRET` takes effect immediately.
 */
function resolveIpHashKey(): string {
  const key = process.env.AUTH_JWT_SECRET;

  if (key === undefined || key.length === 0) {
    throw new Error(
      "AUTH_JWT_SECRET is required: it keys the audit `ipHash` HMAC (src/lib/security/client-fingerprint.ts). Refusing to fall back to an unkeyed digest, which would make every persisted ipHash reversible."
    );
  }

  const placeholder = findConfigVarEntry("AUTH_JWT_SECRET")?.default;
  if (placeholder !== undefined && key === placeholder) {
    throw new Error(
      "AUTH_JWT_SECRET is still the documented .env.example placeholder: it keys the audit `ipHash` HMAC (src/lib/security/client-fingerprint.ts), and that placeholder is published in a public repo. Refusing to key the pseudonym with public knowledge, which would make every persisted ipHash reversible. Set a high-entropy secret, then re-run `bun run config:validate`."
    );
  }

  return key;
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
