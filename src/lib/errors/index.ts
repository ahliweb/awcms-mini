/**
 * Re-export error standard agar lib dan modul memakai satu sumber.
 * Definisi ada di modules/_shared (module contract layer).
 */
export { ApiError, apiError, ERROR_CODES, type ApiErrorDetail, type ErrorCode } from "../../modules/_shared/api-error";
export { toErrorResponse } from "../../modules/_shared/api-response";
