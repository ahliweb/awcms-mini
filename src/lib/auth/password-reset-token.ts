/**
 * Password reset token generation/hashing (Issue #496). Same shape as
 * `session-token.ts` (32 random bytes, base64url; sha256 hex with a
 * `sha256:` prefix) — a distinct pair of functions rather than reusing
 * `generateSessionToken`/`hashSessionToken` by name, so a reset token can
 * never be confused with a session token at a call site even though the
 * underlying construction is identical.
 */
import { createHash, randomBytes } from "node:crypto";

export function generatePasswordResetToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Not a credential hash: `token` is a 32-byte CSPRNG-generated value
 * (`generatePasswordResetToken`, ~256 bits of entropy), never a
 * user-chosen password. A slow adaptive hash (bcrypt/argon2/scrypt)
 * exists to defend low-entropy secrets against offline dictionary
 * guessing — irrelevant here, since brute-forcing a 256-bit random token
 * is infeasible regardless of the hash function's speed, and a slow hash
 * would only needlessly cost every token-verification request. The
 * actual user password is hashed separately via `lib/auth/password.ts`'s
 * `hashPassword` (Bun.password/argon2id) in `completePasswordReset`.
 */
export function hashPasswordResetToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`; // codeql[js/insufficient-password-hash]
}
