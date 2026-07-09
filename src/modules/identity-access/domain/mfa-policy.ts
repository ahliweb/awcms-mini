/**
 * Pure MFA challenge validity evaluation (Issue #589). Same "pure decision,
 * DB does the fetching" shape as `login-policy.ts`'s `evaluateLoginAttempt`
 * and `password-reset-policy.ts`'s `evaluatePasswordResetToken` — testable
 * without a database.
 */
export type MfaChallengeSnapshot = {
  expiresAt: Date;
  consumedAt: Date | null;
  failedAttempts: number;
};

export type MfaChallengeDenyReason =
  "not_found" | "already_used" | "too_many_attempts" | "expired";

export type MfaChallengeEvaluation =
  { outcome: "valid" } | { outcome: "invalid"; reason: MfaChallengeDenyReason };

export function evaluateMfaChallenge(
  row: MfaChallengeSnapshot | null,
  now: Date,
  maxAttempts: number
): MfaChallengeEvaluation {
  if (!row) {
    return { outcome: "invalid", reason: "not_found" };
  }

  if (row.consumedAt !== null) {
    return { outcome: "invalid", reason: "already_used" };
  }

  if (row.failedAttempts >= maxAttempts) {
    return { outcome: "invalid", reason: "too_many_attempts" };
  }

  if (row.expiresAt.getTime() <= now.getTime()) {
    return { outcome: "invalid", reason: "expired" };
  }

  return { outcome: "valid" };
}
