/**
 * Bounded JSON import codec tests (Issue #752).
 */
import { describe, expect, test } from "bun:test";

import { ExchangeIntakeLimitExceededError } from "../../src/modules/data-exchange/domain/csv-codec";
import {
  parseJsonBounded,
  serializeJson
} from "../../src/modules/data-exchange/domain/json-codec";

describe("parseJsonBounded", () => {
  test("parses a well-formed array of row objects", () => {
    const result = parseJsonBounded('[{"code":"a"},{"code":"b"}]', {
      maxRowCount: 10,
      maxFieldsPerRow: 10
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.rows).toEqual([{ code: "a" }, { code: "b" }]);
    }
  });

  test("empty content parses to zero rows", () => {
    const result = parseJsonBounded("", {
      maxRowCount: 10,
      maxFieldsPerRow: 10
    });
    expect(result).toEqual({ ok: true, document: { rows: [] } });
  });

  test("malformed JSON returns ok:false, never throws", () => {
    const result = parseJsonBounded("{not valid json", {
      maxRowCount: 10,
      maxFieldsPerRow: 10
    });
    expect(result.ok).toBe(false);
  });

  test("a top-level non-array value returns ok:false", () => {
    const result = parseJsonBounded('{"code":"a"}', {
      maxRowCount: 10,
      maxFieldsPerRow: 10
    });
    expect(result.ok).toBe(false);
  });

  test("a row that is not an object returns ok:false", () => {
    const result = parseJsonBounded('[{"code":"a"}, "not-an-object"]', {
      maxRowCount: 10,
      maxFieldsPerRow: 10
    });
    expect(result.ok).toBe(false);
  });

  test("a row that is an array returns ok:false", () => {
    const result = parseJsonBounded("[[1,2,3]]", {
      maxRowCount: 10,
      maxFieldsPerRow: 10
    });
    expect(result.ok).toBe(false);
  });

  test("throws ExchangeIntakeLimitExceededError when the array exceeds maxRowCount", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ code: `c${i}` }));
    const content = JSON.stringify(rows);

    expect(() =>
      parseJsonBounded(content, { maxRowCount: 5, maxFieldsPerRow: 10 })
    ).toThrow(ExchangeIntakeLimitExceededError);
  });

  test("throws ExchangeIntakeLimitExceededError when a row exceeds maxFieldsPerRow", () => {
    const content = JSON.stringify([{ a: 1, b: 2, c: 3, d: 4 }]);

    expect(() =>
      parseJsonBounded(content, { maxRowCount: 10, maxFieldsPerRow: 2 })
    ).toThrow(ExchangeIntakeLimitExceededError);
  });

  test("does not throw when exactly at maxRowCount", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ code: `c${i}` }));
    const result = parseJsonBounded(JSON.stringify(rows), {
      maxRowCount: 5,
      maxFieldsPerRow: 10
    });
    expect(result.ok).toBe(true);
  });
});

describe("serializeJson", () => {
  test("round-trips through parseJsonBounded", () => {
    const rows = [
      { code: "a", value: 1 },
      { code: "b", value: 2 }
    ];
    const serialized = serializeJson(rows);
    const parsed = parseJsonBounded(serialized, {
      maxRowCount: 10,
      maxFieldsPerRow: 10
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document.rows).toEqual(rows);
    }
  });
});
