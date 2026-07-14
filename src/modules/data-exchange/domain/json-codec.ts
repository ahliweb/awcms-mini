/**
 * Bounded JSON import/export codec (Issue #752). Expected shape: a JSON
 * ARRAY of flat-ish objects (one object = one row) — anything else is a
 * validation error, not a crash.
 *
 * ## Unbounded-parsing defense, precisely (JSON differs from CSV here)
 *
 * `csv-codec.ts`'s parser can abort MID-DOCUMENT the instant a bound is
 * exceeded, because CSV is parsed character-by-character by hand. Standard
 * `JSON.parse` offers no such mid-parse hook (and this repo is Bun-only
 * with no new dependencies — adding a third-party streaming JSON parser
 * is out of scope for this issue). The safety property this module relies
 * on instead: `JSON.parse` is only ever called on a string ALREADY capped
 * at the HTTP body-size ceiling (`src/lib/security/request-body-limit.ts`,
 * ≤5 MiB for this module's intake tier) — a bounded, sub-second, bounded-
 * memory operation regardless of content shape, so there is no unbounded
 * work to abort mid-flight. The row/field-count bounds
 * (`maxRowCount`/`maxFieldsPerRow`) are then checked IMMEDIATELY after
 * parsing, before any row is normalized/validated/persisted — a violation
 * is rejected in full, with zero further per-row processing (never
 * "process what fits, silently drop the rest").
 */
import { ExchangeIntakeLimitExceededError } from "./csv-codec";

export type ParsedJsonDocument = {
  rows: readonly Record<string, unknown>[];
};

export type JsonBoundedParseOptions = {
  maxRowCount: number;
  maxFieldsPerRow: number;
};

export type JsonParseFailure = {
  ok: false;
  error: string;
};

export type JsonParseSuccess = {
  ok: true;
  document: ParsedJsonDocument;
};

/**
 * Parses `content` as a JSON array of row objects, enforcing
 * `options.maxRowCount`/`options.maxFieldsPerRow` immediately after
 * parsing (see this file's header for why JSON cannot abort mid-parse the
 * way `parseCsvBounded` does). Throws `ExchangeIntakeLimitExceededError`
 * on a bound violation (same error type `parseCsvBounded` throws, so
 * callers handle both formats identically) — returns `{ ok: false }`
 * (never throws) for a malformed/non-array document, distinguishing
 * "attacker-scale abuse" (thrown) from "ordinary bad input" (returned).
 */
export function parseJsonBounded(
  content: string,
  options: JsonBoundedParseOptions
): JsonParseSuccess | JsonParseFailure {
  if (content.trim().length === 0) {
    return { ok: true, document: { rows: [] } };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: "Content is not valid JSON." };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: "Top-level JSON value must be an array of row objects."
    };
  }

  if (parsed.length > options.maxRowCount) {
    throw new ExchangeIntakeLimitExceededError(
      "maxRowCount",
      options.maxRowCount
    );
  }

  const rows: Record<string, unknown>[] = [];

  for (const [rowIndex, item] of parsed.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return {
        ok: false,
        error: `Row ${rowIndex} is not a JSON object.`
      };
    }

    const record = item as Record<string, unknown>;

    if (Object.keys(record).length > options.maxFieldsPerRow) {
      throw new ExchangeIntakeLimitExceededError(
        "maxFieldsPerRow",
        options.maxFieldsPerRow
      );
    }

    rows.push(record);
  }

  return { ok: true, document: { rows } };
}

/** Serializes rows back to a JSON array string — a plain `JSON.stringify`, kept as a named function for symmetry with `serializeCsv` and so call sites read consistently. Same neutralization-is-the-caller's-responsibility contract as `serializeCsv`. */
export function serializeJson(
  rows: readonly Record<string, unknown>[]
): string {
  return JSON.stringify(rows, null, 2);
}
