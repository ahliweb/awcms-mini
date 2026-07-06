/**
 * Pure password-reset-token validity evaluation (Issue #496). Same
 * "pure decision, DB does the fetching" shape as `login-policy.ts`'s
 * `evaluateLoginAttempt` — testable without a database.
 */
export type PasswordResetTokenSnapshot = {
  expiresAt: Date;
  usedAt: Date | null;
};

export type PasswordResetDenyReason = "not_found" | "expired" | "already_used";

export type PasswordResetTokenEvaluation =
  | { outcome: "valid" }
  | { outcome: "invalid"; reason: PasswordResetDenyReason };

export function evaluatePasswordResetToken(
  row: PasswordResetTokenSnapshot | null,
  now: Date
): PasswordResetTokenEvaluation {
  if (!row) {
    return { outcome: "invalid", reason: "not_found" };
  }

  if (row.usedAt !== null) {
    return { outcome: "invalid", reason: "already_used" };
  }

  if (row.expiresAt.getTime() <= now.getTime()) {
    return { outcome: "invalid", reason: "expired" };
  }

  return { outcome: "valid" };
}
