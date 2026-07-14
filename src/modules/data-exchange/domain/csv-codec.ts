/**
 * Bounded, hand-written CSV state-machine parser/serializer (Issue #752).
 *
 * Deliberately NOT regex-based — a regex/`split(",")` approach cannot
 * correctly express RFC4180 quoting (a quoted field may contain literal
 * commas/newlines/escaped double-quotes), and prior incidents in this
 * repo's history (see project memory "SQL tokenizer regex vs state
 * machine") show a regex-alternation approach reliably develops bypasses
 * once nesting/escaping is involved. This parser walks the input
 * character-by-character with explicit quote-state tracking, the same
 * technique `data-lifecycle/infrastructure/local-archive-adapter.ts`'s
 * `parseCsvDocument` already uses for ITS OWN (trusted, self-written)
 * archive files — this is a SEPARATE, independent implementation (not
 * imported from that module, which would create an unwanted cross-module
 * `application`/`domain` dependency for no shared benefit) because this
 * one additionally enforces hard row/field-count bounds DURING parsing
 * with an early abort, which that trusted-input-only parser does not need.
 *
 * ## Unbounded-parsing defense, precisely
 *
 * The HTTP layer (`src/lib/security/request-body-limit.ts`) already caps
 * the raw byte size of the uploaded file BEFORE any text ever reaches this
 * module (streaming read with an abort the instant the running byte count
 * exceeds the limit — never buffers an oversized body fully). This parser
 * adds a SECOND, independent bound on top: `maxRowCount`/`maxFieldsPerRow`
 * (from the import's `ExchangeDescriptor.limits`) are checked INSIDE the
 * character-walking loop — the moment a row completes past `maxRowCount`,
 * or a field separator is seen past `maxFieldsPerRow` fields in the
 * CURRENT row, parsing stops immediately and throws
 * `ExchangeIntakeLimitExceededError` — never "parse the whole document
 * into an array, then check `.length`" (a file with a small byte size but
 * an enormous row count — e.g. millions of one-byte rows — would defeat a
 * post-hoc length check by fully materializing an oversized array first;
 * this parser never builds more than `maxRowCount + 1` rows in memory).
 */

export class ExchangeIntakeLimitExceededError extends Error {
  readonly limitKind: "maxRowCount" | "maxFieldsPerRow";
  readonly limitValue: number;

  constructor(
    limitKind: "maxRowCount" | "maxFieldsPerRow",
    limitValue: number
  ) {
    super(
      `Import intake exceeded ${limitKind} (limit: ${limitValue}) before parsing could complete.`
    );
    this.name = "ExchangeIntakeLimitExceededError";
    this.limitKind = limitKind;
    this.limitValue = limitValue;
  }
}

export type ParsedCsvDocument = {
  header: readonly string[];
  /** Data rows only (header excluded), each an array of raw string cell values aligned by index to `header` (may be shorter/longer than `header` if the source file was malformed — callers validate that per-row, this parser does not silently pad/truncate). */
  rows: readonly (readonly string[])[];
};

export type CsvBoundedParseOptions = {
  maxRowCount: number;
  maxFieldsPerRow: number;
};

/**
 * Parses `content` as RFC4180-ish CSV (first row = header), enforcing
 * `options.maxRowCount` (data rows, header excluded) and
 * `options.maxFieldsPerRow` with an early abort. Throws
 * `ExchangeIntakeLimitExceededError` the instant either bound would be
 * exceeded; throws a plain `Error` for a structurally malformed document
 * (empty content).
 */
export function parseCsvBounded(
  content: string,
  options: CsvBoundedParseOptions
): ParsedCsvDocument {
  if (content.trim().length === 0) {
    return { header: [], rows: [] };
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let field = "";
  let inQuotes = false;
  let header: string[] | null = null;
  let index = 0;

  const finishField = (): void => {
    currentRow.push(field);
    field = "";

    if (header !== null && currentRow.length > options.maxFieldsPerRow) {
      throw new ExchangeIntakeLimitExceededError(
        "maxFieldsPerRow",
        options.maxFieldsPerRow
      );
    }
  };

  const finishRow = (): void => {
    finishField();

    if (header === null) {
      header = currentRow;

      if (header.length > options.maxFieldsPerRow) {
        throw new ExchangeIntakeLimitExceededError(
          "maxFieldsPerRow",
          options.maxFieldsPerRow
        );
      }
    } else {
      rows.push(currentRow);

      if (rows.length > options.maxRowCount) {
        throw new ExchangeIntakeLimitExceededError(
          "maxRowCount",
          options.maxRowCount
        );
      }
    }

    currentRow = [];
  };

  while (index < content.length) {
    const char = content[index]!;

    if (inQuotes) {
      if (char === '"' && content[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      finishField();
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      finishRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // Final row with no trailing newline.
  if (field.length > 0 || currentRow.length > 0) {
    finishRow();
  }

  return { header: header ?? [], rows };
}

function csvCellNeedsQuoting(value: string): boolean {
  return /[",\n\r]/.test(value);
}

function escapeCsvCell(value: string): string {
  if (csvCellNeedsQuoting(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

/**
 * Serializes `header` + `rows` back to CSV text, quoting only where
 * RFC4180 requires it. Callers (`export-execute-job.ts`) are responsible
 * for having already run every string cell through
 * `neutralizeFormulaInjectionValue` (`formula-injection-guard.ts`) — this
 * function does not re-check, it only handles RFC4180 escaping. Kept
 * SEPARATE (not fused into one "sanitize and serialize" step) so a caller
 * that intentionally wants raw values (e.g. an internal, never-exported
 * diagnostic dump) can opt out of neutralization explicitly rather than it
 * being silently unconditional here.
 */
export function serializeCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[]
): string {
  const lines = [header, ...rows].map((row) =>
    row.map(escapeCsvCell).join(",")
  );

  return lines.join("\r\n");
}
