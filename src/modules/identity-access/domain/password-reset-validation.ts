/**
 * Pure validation for the password reset endpoints (Issue #496). Same
 * shape/style as `user-management.ts` — no I/O here.
 */
import { MIN_PASSWORD_LENGTH } from "./user-management";

export type ValidationError = {
  field: string;
  message: string;
};

type Result<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

export type ForgotPasswordInput = {
  loginIdentifier: string;
};

export type ResetPasswordInput = {
  token: string;
  newPassword: string;
};

export function validateForgotPasswordInput(
  body: unknown
): Result<ForgotPasswordInput> {
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

export function validateResetPasswordInput(
  body: unknown
): Result<ResetPasswordInput> {
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
