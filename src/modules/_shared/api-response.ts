/**
 * Response helper standard (doc 10): envelope { success, data, meta } /
 * { success:false, error }. Semua API route wajib memakai helper ini.
 */
import { ApiError, type ApiErrorDetail } from "./api-error";

export type ApiMeta = {
  correlationId?: string;
  requestId?: string;
};

export type ApiSuccess<T> = {
  success: true;
  data: T;
  meta?: ApiMeta;
};

export type ApiErrorResponse = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetail[];
    correlationId?: string;
  };
};

export function ok<T>(data: T, meta?: ApiMeta): Response {
  return Response.json({ success: true, data, meta } satisfies ApiSuccess<T>);
}

export function created<T>(data: T, meta?: ApiMeta): Response {
  return Response.json({ success: true, data, meta } satisfies ApiSuccess<T>, { status: 201 });
}

export function fail(
  status: number,
  code: string,
  message: string,
  options?: { details?: ApiErrorDetail[]; correlationId?: string }
): Response {
  return Response.json(
    {
      success: false,
      error: {
        code,
        message,
        details: options?.details,
        correlationId: options?.correlationId
      }
    } satisfies ApiErrorResponse,
    { status }
  );
}

/**
 * Konversi error apa pun ke response standard tanpa stack trace.
 * Error non-ApiError dilaporkan sebagai INTERNAL_ERROR generik.
 */
export function toErrorResponse(error: unknown, correlationId?: string): Response {
  if (error instanceof ApiError) {
    return fail(error.status, error.code, error.message, {
      details: error.details,
      correlationId
    });
  }
  return fail(500, "INTERNAL_ERROR", "Terjadi kesalahan internal.", { correlationId });
}
