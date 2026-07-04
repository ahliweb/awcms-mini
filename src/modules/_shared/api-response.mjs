export function createApiMeta(meta = {}) {
  const result = {};

  if (meta.requestId) result.requestId = meta.requestId;
  if (meta.correlationId) result.correlationId = meta.correlationId;

  return Object.keys(result).length > 0 ? result : undefined;
}

export function successEnvelope(data, meta = {}) {
  const envelope = {
    success: true,
    data,
  };

  const apiMeta = createApiMeta(meta);
  if (apiMeta) envelope.meta = apiMeta;

  return envelope;
}

export function errorEnvelope(code, message, options = {}) {
  if (typeof code !== "string" || code.length === 0) {
    throw new TypeError("error code must be a non-empty string");
  }
  if (typeof message !== "string" || message.length === 0) {
    throw new TypeError("error message must be a non-empty string");
  }

  const error = { code, message };
  if (Array.isArray(options.details) && options.details.length > 0) {
    error.details = options.details;
  }
  if (options.correlationId) {
    error.correlationId = options.correlationId;
  }

  return {
    success: false,
    error,
  };
}

export function jsonSuccess(c, data, options = {}) {
  return c.json(successEnvelope(data, options.meta), options.status ?? 200);
}

export function jsonError(c, status, code, message, options = {}) {
  return c.json(errorEnvelope(code, message, options), status);
}

export class ApiError extends Error {
  constructor({ status, code, message, details } = {}) {
    super(message ?? "Request failed");
    this.name = "ApiError";
    this.status = status ?? 500;
    this.code = code ?? "INTERNAL_ERROR";
    this.details = details;
  }
}
