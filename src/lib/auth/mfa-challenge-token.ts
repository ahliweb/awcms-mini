/**
 * MFA challenge token generation/hashing (Issue #589) — same shape as
 * `session-token.ts`/`password-reset-token.ts` (32 random bytes, base64url;
 * sha256 hex with a `sha256:` prefix), a distinct pair of functions so a
 * challenge token can never be confused with a session or reset token at a
 * call site even though the construction is identical.
 */
import { createHash, randomBytes } from "node:crypto";

export function generateChallengeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashChallengeToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}
