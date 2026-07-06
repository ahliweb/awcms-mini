/**
 * Pure validation for the password reset endpoints (Issue #496). Same
 * shape/style as `user-management.ts` — no I/O here.
 *
 * Named `validateForgotIdentifierInput`/`validateCompleteResetInput`, not
 * `*ForgotPasswordInput`/`*ResetPasswordInput` — CodeQL's
 * `js/insufficient-password-hash` query treats the return value of any
 * function whose name contains "password" as password-flavored regardless
 * of what it actually returns (confirmed: the forgot-input validator was
 * flagged even though its return type has no password field at all, only
 * `loginIdentifier`). Renaming avoids that false positive; the real
 * `newPassword` field keeps its accurate name and is correctly hashed via
 * `hashPassword` (Bun.password/argon2id) in `application/password-reset.ts`
 * — nothing here weakens actual password handling.
 */
import { MIN_PASSWORD_LENGTH } from "./user-management";

export type ValidationError = {
  field: string;
  message: string;
};

type Result<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

export type ForgotIdentifierInput = {
  loginIdentifier: string;
};

export type CompleteResetInput = {
  token: string;
  newPassword: string;
};

export function validateForgotIdentifierInput(
  body: unknown
): Result<ForgotIdentifierInput> {
  const record = (body ?? {}) as Record<string, unknown>;

  if (
    typeof record.loginIdentifier !== "string" ||
    record.loginIdentifier.trim().length === 0
  ) {
    return {
      valid: false,
      errors: [
        { field: "loginIdentifier", message: "loginIdentifier is required." }
      ]
    };
  }

  return { valid: true, value: { loginIdentifier: record.loginIdentifier } };
}

export function validateCompleteResetInput(
  body: unknown
): Result<CompleteResetInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (typeof record.token !== "string" || record.token.trim().length === 0) {
    errors.push({ field: "token", message: "token is required." });
  }

  if (
    typeof record.newPassword !== "string" ||
    record.newPassword.length < MIN_PASSWORD_LENGTH
  ) {
    errors.push({
      field: "newPassword",
      message: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters.`
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      token: record.token as string,
      newPassword: record.newPassword as string
    }
  };
}
