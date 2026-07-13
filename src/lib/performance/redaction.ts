/**
 * Report redaction helpers (Issue #744, epic #738 platform-evolution) —
 * pure, no I/O. Every performance report artifact (`report.ts`) MUST pass
 * through these before being written to disk/CI artifact storage: the
 * issue's own non-negotiable requirement is "Result artifacts redact
 * DSNs, host credentials, and high-cardinality tenant/user identifiers" —
 * a machine-readable JSON report is exactly the kind of file that gets
 * attached to a CI run and potentially shared far more widely than the
 * terminal output that produced it.
 */

/**
 * Strips username/password (and, defensively, any other userinfo-shaped
 * prefix) from a PostgreSQL connection string, keeping only
 * `scheme://<redacted>@host:port/database` — enough to identify WHICH
 * database a report ran against for environment-comparability purposes,
 * without ever leaking a credential. Never throws: an unparsable value is
 * replaced wholesale rather than partially leaked.
 */
export function redactDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    return "(not set)";
  }

  try {
    const url = new URL(databaseUrl);
    const host = url.hostname;
    const port = url.port ? `:${url.port}` : "";
    const database = url.pathname || "";

    return `${url.protocol}//<redacted>@${host}${port}${database}`;
  } catch {
    return "(unparsable DSN — redacted wholesale)";
  }
}

/**
 * Deterministic-per-run pseudonymizer for high-cardinality identifiers
 * (tenant ids, user ids, correlation ids) — assigns `${prefix}#1`,
 * `${prefix}#2`, ... in first-seen order and remembers the mapping so the
 * SAME real id always maps to the SAME pseudonym within one report (lets a
 * reader still see "tenant#5 accounts for most of the load" without ever
 * learning the real UUID). A fresh `createIdRedactor()` per report run —
 * never reused across runs — so pseudonym numbering never becomes a stable
 * cross-run fingerprint for a real tenant either.
 */
export type IdRedactor = {
  redact(realId: string): string;
  /** Number of distinct real ids seen so far. */
  size(): number;
};

export function createIdRedactor(prefix: string): IdRedactor {
  const seen = new Map<string, string>();

  return {
    redact(realId: string): string {
      const existing = seen.get(realId);

      if (existing) {
        return existing;
      }

      const pseudonym = `${prefix}#${seen.size + 1}`;
      seen.set(realId, pseudonym);

      return pseudonym;
    },
    size(): number {
      return seen.size;
    }
  };
}

/**
 * Recursively walks a plain JSON-ish value and replaces every string that
 * looks like a UUID with its pseudonym via `redactor` — the defensive
 * backstop for report sections (e.g. raw `EXPLAIN` plan JSON, which can
 * embed literal query parameter values) that were not built by code that
 * already redacted ids at the source.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function redactUuidsDeep(value: unknown, redactor: IdRedactor): unknown {
  if (typeof value === "string") {
    return UUID_PATTERN.test(value) ? redactor.redact(value) : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactUuidsDeep(item, redactor));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(record)) {
      result[key] = redactUuidsDeep(record[key], redactor);
    }

    return result;
  }

  return value;
}
