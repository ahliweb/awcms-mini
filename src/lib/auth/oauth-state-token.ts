/**
 * OAuth `state` param generation/hashing (Issue #590) — same shape as
 * `session-token.ts`/`mfa-challenge-token.ts` (32 random bytes, base64url;
 * sha256 hex with a `sha256:` prefix). `state` IS a bearer credential (its
 * mere possession, embedded in the callback URL, is what the callback trusts
 * to correlate the redirect back to the request that started it), so it is
 * hashed at rest exactly like a session/reset/challenge token — unlike the
 * OIDC `nonce`, which is stored plaintext (see `sql/035...`'s comment on
 * `awcms_mini_oidc_auth_requests`).
 *
 * `hashOAuthState` uses a fast hash (sha256), deliberately — same reasoning
 * `password-reset-token.ts` documents for its own `hashResetToken`: `state`
 * is a 256-bit CSPRNG value (`generateOAuthState`), not a user-chosen
 * low-entropy secret, so a slow adaptive hash (bcrypt/argon2/scrypt) would
 * only cost every callback verification for no real benefit — offline
 * brute-forcing a 256-bit random value is infeasible regardless of hash
 * speed. CodeQL's `js/insufficient-password-hash` query has been observed
 * to flag this exact shape as a false positive (fast hash of a token whose
 * value later gets compared for equality, which structurally resembles
 * password verification) — this is the same known, accepted false-positive
 * class `password-reset-token.ts` already documents for `hashResetToken`.
 */
import { createHash, randomBytes } from "node:crypto";

export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOAuthState(state: string): string {
  return `sha256:${createHash("sha256").update(state).digest("hex")}`;
}

/** The OIDC `nonce` — plaintext (not a bearer credential; see file header). */
export function generateOidcNonce(): string {
  return randomBytes(24).toString("base64url");
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Google's redirect back to `callback.ts` is a plain top-level browser
 * navigation — there is no way to attach our usual
 * `X-AWCMS-Mini-Tenant-ID` header to it, so the tenant id must travel
 * inside the `state` query param itself. `buildOAuthStateParam`/
 * `parseOAuthStateParam` embed it as a `${tenantId}.${rawToken}` prefix —
 * safe because a tenant id is not a secret, and the token portion (the
 * actual CSRF/replay defense, always ≥32 random bytes) is unchanged and
 * still hashed at rest exactly as if it travelled alone.
 */
export function buildOAuthStateParam(
  tenantId: string,
  rawToken: string
): string {
  return `${tenantId}.${rawToken}`;
}

export function parseOAuthStateParam(
  stateParam: string
): { tenantId: string; token: string } | null {
  const separatorIndex = stateParam.indexOf(".");

  if (separatorIndex === -1) {
    return null;
  }

  const tenantId = stateParam.slice(0, separatorIndex);
  const token = stateParam.slice(separatorIndex + 1);

  if (!UUID_PATTERN.test(tenantId) || token.length === 0) {
    return null;
  }

  return { tenantId, token };
}
