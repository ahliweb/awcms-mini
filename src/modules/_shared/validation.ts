/**
 * Validation standard (doc 10): semua input divalidasi — UUID, enum,
 * panjang string, numeric finite/range, unknown field.
 * Melempar ApiError VALIDATION_ERROR agar response konsisten.
 */
import { ApiError } from "./api-error";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validationError(message: string, field?: string): ApiError {
  return new ApiError({
    status: 400,
    code: "VALIDATION_ERROR",
    message: "Data tidak valid.",
    details: [{ field, message }]
  });
}

export function assertUuid(value: unknown, field = "id"): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw validationError(`${field} harus UUID valid`, field);
  }
  return value.toLowerCase();
}

export function requireString(
  value: unknown,
  field: string,
  options: { minLength?: number; maxLength?: number } = {}
): string {
  const { minLength = 1, maxLength = 255 } = options;
  if (typeof value !== "string") throw validationError(`${field} harus string`, field);
  const trimmed = value.trim();
  if (trimmed.length < minLength) {
    throw validationError(`${field} minimal ${minLength} karakter`, field);
  }
  if (trimmed.length > maxLength) {
    throw validationError(`${field} maksimal ${maxLength} karakter`, field);
  }
  return trimmed;
}

export function requireEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw validationError(`${field} harus salah satu dari: ${allowed.join(", ")}`, field);
  }
  return value as T;
}

export function requireFiniteNumber(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {}
): number {
  const num = typeof value === "string" && value !== "" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) {
    throw validationError(`${field} harus angka valid`, field);
  }
  if (options.min !== undefined && num < options.min) {
    throw validationError(`${field} minimal ${options.min}`, field);
  }
  if (options.max !== undefined && num > options.max) {
    throw validationError(`${field} maksimal ${options.max}`, field);
  }
  return num;
}

/** Menolak field yang tidak dikenal pada body request. */
export function rejectUnknownFields(
  body: Record<string, unknown>,
  allowedFields: readonly string[]
): void {
  const unknown = Object.keys(body).filter((key) => !allowedFields.includes(key));
  if (unknown.length > 0) {
    throw new ApiError({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Data tidak valid.",
      details: unknown.map((field) => ({ field, message: `${field} tidak dikenal` }))
    });
  }
}

/** Parse body JSON dengan error standard (bukan stack trace). */
export async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw validationError("body harus objek JSON");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw validationError("body harus JSON valid");
  }
}
