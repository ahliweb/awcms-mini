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

export function hashPasswordResetToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}
