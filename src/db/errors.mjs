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

const CONSTRAINT_CODES = new Set(["23502", "23503", "23505", "23514"]);
const CONNECTION_CODES = new Set(["57P01", "57P03"]);

export function classifyDatabaseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;

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

export function isDatabaseErrorKind(error, kind) {
  return classifyDatabaseError(error) === kind;
}
