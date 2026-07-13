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
 * Recursively walks a plain JSON-ish value and replaces every UUID-shaped
 * SUBSTRING (not just a value that IS, in its entirety, a UUID) with its
 * pseudonym via `redactor` — the defensive backstop for report sections
 * (e.g. raw `EXPLAIN` plan JSON, or a free-text `detail`/`finding` string
 * that happens to embed a raw id, such as `` `tenant ${tenantId} rejected`
 * ``) that were not built by code that already redacted ids at the
 * source. Reviewer finding on PR #775: the original pattern was anchored
 * (`^...$`), so it only matched a value that was NOTHING BUT a UUID —
 * any UUID embedded inside a longer string sailed through untouched,
 * which contradicted this module's own "defensive backstop" framing.
 * Global (not anchored), so every UUID occurrence in a string is replaced,
 * however many there are and wherever they sit.
 */
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function redactUuidsDeep(value: unknown, redactor: IdRedactor): unknown {
  if (typeof value === "string") {
    return value.replace(UUID_PATTERN, (match) => redactor.redact(match));
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

/**
 * Matches a DSN-shaped `scheme://userinfo@host[...]` substring anywhere in
 * free text — security-auditor finding on PR #775: `redactReport`
 * (`report.ts`) previously only ever redacted the ONE known
 * `environment.databaseUrl` field via `redactDatabaseUrl`, never scanning
 * free-text fields (`ScenarioResult.detail`, `QueryPlanCheckResult.
 * findings`) that could embed a raw thrown `error.message` containing a
 * real connection string. This is the same kind of defensive backstop
 * `redactUuidsDeep` already provides for ids — global, not anchored, so a
 * DSN embedded anywhere inside a longer string is still caught. Reuses
 * `redactDatabaseUrl`'s own credential-stripping logic on each match
 * rather than re-implementing it.
 */
const DSN_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+@[^\s'"<>]+/gi;

export function redactDsnPatternsDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(DSN_PATTERN, (match) => redactDatabaseUrl(match));
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDsnPatternsDeep(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(record)) {
      result[key] = redactDsnPatternsDeep(record[key]);
    }

    return result;
  }

  return value;
}
