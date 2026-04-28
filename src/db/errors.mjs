export const DATABASE_ERROR_KIND = {
  AUTHENTICATION: "authentication",
  CONNECTION: "connection",
  CONSTRAINT: "constraint",
  MIGRATION: "migration",
  NOT_FOUND: "not_found",
  QUERY: "query",
  TRANSACTION: "transaction",
  UNKNOWN: "unknown",
};

export const DATABASE_ERROR_REASON = {
  CONNECTION_TIMEOUT: "connection_timeout",
  CREDENTIAL_FORMAT: "credential_format",
  DNS: "dns",
  REFUSED: "refused",
  TERMINATED: "terminated",
  TLS: "tls",
  UNKNOWN: "unknown",
};

const CONSTRAINT_CODES = new Set(["23502", "23503", "23505", "23514"]);
const CONNECTION_CODES = new Set(["57P01", "57P03"]);

export function extractDatabaseErrorMessage(error) {
  if (error instanceof Error) {
    if (typeof error.message === "string" && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error.stack === "string" && error.stack.trim().length > 0) {
      const firstLine = error.stack.split("\n").find((line) => line.trim().length > 0);
      if (firstLine) {
        return firstLine.replace(/^Error:\s*/, "");
      }
    }
  }

  return String(error ?? "");
}

function extractDatabaseErrorCode(error) {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  if (typeof error.code === "string" && error.code.trim().length > 0) {
    return error.code;
  }

  if (Array.isArray(error.errors)) {
    const nestedCode = error.errors.find((entry) => entry && typeof entry === "object" && typeof entry.code === "string")?.code;
    if (typeof nestedCode === "string" && nestedCode.trim().length > 0) {
      return nestedCode;
    }
  }

  return undefined;
}

export function classifyDatabaseError(error) {
  const message = extractDatabaseErrorMessage(error);
  const lowercaseMessage = message.toLowerCase();
  const code = extractDatabaseErrorCode(error);

  if (typeof code === "string") {
    if (code === "28P01") {
      return DATABASE_ERROR_KIND.AUTHENTICATION;
    }

    if (CONNECTION_CODES.has(code) || code.startsWith("08")) {
      return DATABASE_ERROR_KIND.CONNECTION;
    }

    if (CONSTRAINT_CODES.has(code)) {
      return DATABASE_ERROR_KIND.CONSTRAINT;
    }
  }

  if (lowercaseMessage.includes("client password must be a string") || lowercaseMessage.includes("sasl")) {
    return DATABASE_ERROR_KIND.AUTHENTICATION;
  }

  if (lowercaseMessage.includes("etimedout") || lowercaseMessage.includes("aggregateerror [etimedout]")) {
    return DATABASE_ERROR_KIND.CONNECTION;
  }

  if (message.includes('relation "') && message.includes('does not exist')) {
    return DATABASE_ERROR_KIND.NOT_FOUND;
  }

  if (message.toLowerCase().includes("migration")) {
    return DATABASE_ERROR_KIND.MIGRATION;
  }

  if (message.toLowerCase().includes("transaction")) {
    return DATABASE_ERROR_KIND.TRANSACTION;
  }

  if (message.toLowerCase().includes("connect") || message.toLowerCase().includes("connection")) {
    return DATABASE_ERROR_KIND.CONNECTION;
  }

  if (message.toLowerCase().includes("query")) {
    return DATABASE_ERROR_KIND.QUERY;
  }

  return DATABASE_ERROR_KIND.UNKNOWN;
}

export function describeDatabaseErrorReason(error) {
  const message = extractDatabaseErrorMessage(error);
  const lowercaseMessage = message.toLowerCase();

  if (lowercaseMessage.includes("timeout")) {
    return DATABASE_ERROR_REASON.CONNECTION_TIMEOUT;
  }

  if (lowercaseMessage.includes("etimedout") || lowercaseMessage.includes("aggregateerror [etimedout]")) {
    return DATABASE_ERROR_REASON.CONNECTION_TIMEOUT;
  }

  if (lowercaseMessage.includes("client password must be a string") || lowercaseMessage.includes("sasl")) {
    return DATABASE_ERROR_REASON.CREDENTIAL_FORMAT;
  }

  if (lowercaseMessage.includes("enotfound") || lowercaseMessage.includes("getaddrinfo")) {
    return DATABASE_ERROR_REASON.DNS;
  }

  if (lowercaseMessage.includes("econnrefused") || lowercaseMessage.includes("connection refused")) {
    return DATABASE_ERROR_REASON.REFUSED;
  }

  if (lowercaseMessage.includes("self-signed") || lowercaseMessage.includes("certificate") || lowercaseMessage.includes("tls")) {
    return DATABASE_ERROR_REASON.TLS;
  }

  if (lowercaseMessage.includes("terminated")) {
    return DATABASE_ERROR_REASON.TERMINATED;
  }

  return DATABASE_ERROR_REASON.UNKNOWN;
}

export function formatDatabaseErrorDiagnostic(error) {
  const kind = classifyDatabaseError(error);
  const reason = describeDatabaseErrorReason(error);
  const message = extractDatabaseErrorMessage(error);

  return {
    kind,
    reason,
    message,
  };
}

export function isDatabaseErrorKind(error, kind) {
  return classifyDatabaseError(error) === kind;
}
