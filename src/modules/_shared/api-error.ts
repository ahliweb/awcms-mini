/**
 * ApiError + katalog error code standard (doc 05 & 10).
 * Error response tidak pernah membawa stack trace.
 */

export type ApiErrorDetail = { field?: string; message: string; code?: string };

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: ApiErrorDetail[];

  constructor(params: {
    status: number;
    code: string;
    message: string;
    details?: ApiErrorDetail[];
  }) {
    super(params.message);
    this.name = "ApiError";
    this.status = params.status;
    this.code = params.code;
    this.details = params.details;
  }
}

/** Error code standard → HTTP status (doc 05). */
export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  AUTH_REQUIRED: 401,
  TOKEN_EXPIRED: 401,
  ACCESS_DENIED: 403,
  TENANT_REQUIRED: 400,
  RESOURCE_NOT_FOUND: 404,
  IDEMPOTENCY_REQUIRED: 400,
  IDEMPOTENCY_CONFLICT: 409,
  WORKFLOW_APPROVAL_REQUIRED: 409,
  SYNC_CONFLICT: 409,
  DATABASE_BUSY: 503,
  PROVIDER_ERROR: 502,
  INTERNAL_ERROR: 500
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function apiError(code: ErrorCode, message: string, details?: ApiErrorDetail[]): ApiError {
  return new ApiError({ status: ERROR_CODES[code], code, message, details });
}
