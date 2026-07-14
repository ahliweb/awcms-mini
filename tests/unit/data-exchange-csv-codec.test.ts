/**
 * CSV bounded state-machine parser tests (Issue #752) — RFC4180 quoting
 * correctness plus the unbounded-parsing defense: an oversized row/field
 * count aborts EARLY (mid-parse), not after materializing the whole
 * document.
 */
import { describe, expect, test } from "bun:test";

import {
  ExchangeIntakeLimitExceededError,
  parseCsvBounded,
  serializeCsv
} from "../../src/modules/data-exchange/domain/csv-codec";

describe("parseCsvBounded — RFC4180 correctness", () => {
  test("parses a simple header + rows", () => {
    const result = parseCsvBounded(
      "code,label\nacme,Acme Corp\nglobex,Globex\n",
      {
        maxRowCount: 10,
        maxFieldsPerRow: 10
      }
    );

    expect(result.header).toEqual(["code", "label"]);
    expect(result.rows).toEqual([
      ["acme", "Acme Corp"],
      ["globex", "Globex"]
    ]);
  });

  test("handles quoted fields with embedded commas and escaped quotes", () => {
    const result = parseCsvBounded(
      'code,label\nacme,"Acme, Inc. ""The Best"""\n',
      { maxRowCount: 10, maxFieldsPerRow: 10 }
    );

    expect(result.rows).toEqual([["acme", 'Acme, Inc. "The Best"']]);
  });

  test("handles a literal newline inside a quoted field without splitting the row", () => {
    const result = parseCsvBounded('code,label\nacme,"line1\nline2"\n', {
      maxRowCount: 10,
      maxFieldsPerRow: 10
    });

    expect(result.rows).toEqual([["acme", "line1\nline2"]]);
  });

  test("handles a file with no trailing newline", () => {
    const result = parseCsvBounded("code,label\nacme,Acme", {
      maxRowCount: 10,
      maxFieldsPerRow: 10
    });

    expect(result.rows).toEqual([["acme", "Acme"]]);
  });

  test("empty content parses to no header/rows", () => {
    const result = parseCsvBounded("", {
      maxRowCount: 10,
      maxFieldsPerRow: 10
    });
    expect(result.header).toEqual([]);
    expect(result.rows).toEqual([]);
  });
});

describe("parseCsvBounded — unbounded-parsing defense (early abort)", () => {
  test("throws ExchangeIntakeLimitExceededError the moment maxRowCount is exceeded", () => {
    const rows = Array.from(
      { length: 20 },
      (_, i) => `code${i},label${i}`
    ).join("\n");
    const content = `code,label\n${rows}\n`;

    expect(() =>
      parseCsvBounded(content, { maxRowCount: 5, maxFieldsPerRow: 10 })
    ).toThrow(ExchangeIntakeLimitExceededError);
  });

  test("the thrown error reports maxRowCount as the limit kind", () => {
    const rows = Array.from(
      { length: 20 },
      (_, i) => `code${i},label${i}`
    ).join("\n");
    const content = `code,label\n${rows}\n`;

    try {
      parseCsvBounded(content, { maxRowCount: 5, maxFieldsPerRow: 10 });
      throw new Error("expected parseCsvBounded to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ExchangeIntakeLimitExceededError);
      expect((error as ExchangeIntakeLimitExceededError).limitKind).toBe(
        "maxRowCount"
      );
      expect((error as ExchangeIntakeLimitExceededError).limitValue).toBe(5);
    }
  });

  test("throws ExchangeIntakeLimitExceededError the moment maxFieldsPerRow is exceeded on the header row itself", () => {
    const content = "a,b,c,d,e,f\n1,2,3,4,5,6\n";

    expect(() =>
      parseCsvBounded(content, { maxRowCount: 10, maxFieldsPerRow: 3 })
    ).toThrow(ExchangeIntakeLimitExceededError);
  });

  test("throws ExchangeIntakeLimitExceededError when a DATA row exceeds maxFieldsPerRow even if the header did not", () => {
    const content = "a,b\n1,2,3,4,5\n";

    expect(() =>
      parseCsvBounded(content, { maxRowCount: 10, maxFieldsPerRow: 2 })
    ).toThrow(ExchangeIntakeLimitExceededError);
  });

  test("does not throw when exactly at the row-count limit", () => {
    const rows = Array.from({ length: 5 }, (_, i) => `code${i},label${i}`).join(
      "\n"
    );
    const content = `code,label\n${rows}\n`;

    const result = parseCsvBounded(content, {
      maxRowCount: 5,
      maxFieldsPerRow: 10
    });
    expect(result.rows.length).toBe(5);
  });

  test("a maliciously huge row count (well beyond any realistic import) is rejected promptly, not silently truncated", () => {
    // 50,000 tiny rows -- small byte size, but a row count an attacker
    // might use to exhaust downstream memory/CPU if unbounded.
    const rows = Array.from({ length: 50_000 }, (_, i) => `${i},x`).join("\n");
    const content = `a,b\n${rows}\n`;

    const start = performance.now();
    expect(() =>
      parseCsvBounded(content, { maxRowCount: 100, maxFieldsPerRow: 10 })
    ).toThrow(ExchangeIntakeLimitExceededError);
    const elapsedMs = performance.now() - start;

    // Aborting at row 100 of 50,000 must be fast -- proves the parser did
    // NOT walk the entire 50,000-row document before checking the bound.
    expect(elapsedMs).toBeLessThan(200);
  });
});

describe("serializeCsv", () => {
  test("round-trips through parseCsvBounded", () => {
    const header = ["code", "label"];
    const rows = [
      ["acme", "Acme, Inc."],
      ["globex", 'Globex "Best"']
    ];

    const serialized = serializeCsv(header, rows);
    const parsed = parseCsvBounded(serialized, {
      maxRowCount: 10,
      maxFieldsPerRow: 10
    });

    expect(parsed.header).toEqual(header);
    expect(parsed.rows).toEqual(rows);
  });

  test("quotes only cells that need it", () => {
    const serialized = serializeCsv(["a", "b"], [["plain", "has,comma"]]);
    expect(serialized).toBe('a,b\r\nplain,"has,comma"');
  });
});
