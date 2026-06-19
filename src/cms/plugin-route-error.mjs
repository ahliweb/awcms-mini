/**
 * Error rute plugin native (decoupling EmDash, ADR-020 Fase 3).
 *
 * Pengganti `PluginRouteError` dari paket `emdash`. Error subclass yang membawa
 * `code` + `status` (HTTP) + `details` sehingga `server/middleware/error-handler.mjs`
 * dapat memetakannya ke respons HTTP (duck-typed: membaca `.status`/`.code`).
 *
 * Tidak ada dependency `emdash`; implementasi milik AWCMS-Mini sendiri.
 */

export class PluginRouteError extends Error {
  /**
   * @param {string} code kode error mesin-baca (mis. "BAD_REQUEST")
   * @param {string} message pesan manusia-baca
   * @param {number} [status=400] status HTTP
   * @param {unknown} [details] detail tambahan (opsional)
   */
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.name = "PluginRouteError";
  }

  /** 400 Bad Request */
  static badRequest(message, details) {
    return new PluginRouteError("BAD_REQUEST", message, 400, details);
  }

  /** 401 Unauthorized */
  static unauthorized(message = "Unauthorized") {
    return new PluginRouteError("UNAUTHORIZED", message, 401);
  }

  /** 403 Forbidden */
  static forbidden(message = "Forbidden") {
    return new PluginRouteError("FORBIDDEN", message, 403);
  }

  /** 404 Not Found */
  static notFound(message = "Not found") {
    return new PluginRouteError("NOT_FOUND", message, 404);
  }

  /** 409 Conflict */
  static conflict(message, details) {
    return new PluginRouteError("CONFLICT", message, 409, details);
  }

  /** 500 Internal Error */
  static internal(message = "Internal error") {
    return new PluginRouteError("INTERNAL_ERROR", message, 500);
  }
}
