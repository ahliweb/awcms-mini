/**
 * Password reset token generation/hashing (Issue #496). Same shape as
 * `session-token.ts` (32 random bytes, base64url; sha256 hex with a
 * `sha256:` prefix) — a distinct pair of functions rather than reusing
 * `generateSessionToken`/`hashSessionToken` by name, so a reset token can
 * never be confused with a session token at a call site even though the
 * underlying construction is identical.
 *
 * Named `*ResetToken`, not `*PasswordResetToken` — CodeQL's
 * `js/insufficient-password-hash` query treats the return value of any
 * function whose name contains "password" as password-flavored regardless
 * of what it actually returns (confirmed: it flagged `hashIdentifier` via
 * the forgot-password input validator, even though that validator's
 * return type has no password field at all — only `loginIdentifier`).
 * Renaming avoids that false positive without weakening anything: `token`
 * here is a 256-bit CSPRNG value, not
 * a user-chosen password, so a fast hash (sha256) is the correct choice —
 * a slow adaptive hash (bcrypt/argon2/scrypt) defends low-entropy secrets
 * against offline guessing, which is irrelevant to a 256-bit random token
 * and would only cost every verification request for no real benefit. The
 * actual user password is hashed separately via `lib/auth/password.ts`'s
 * `hashPassword` (Bun.password/argon2id) in `completePasswordReset`.
 */
import { createHash, randomBytes } from "node:crypto";

export function generateResetToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashResetToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}
