/**
 * `neutralizeRowForExport` hardening tests (Issue #752; reviewer finding
 * on PR #782, Low/hardening: a scalar-only check missed a nested array
 * field, since `String(["=1+1"])` evaluates to the bare dangerous string
 * `"=1+1"` at CSV serialization time).
 */
import { describe, expect, test } from "bun:test";

import { neutralizeRowForExport } from "../../src/modules/data-exchange/application/export-execute-job";

describe("neutralizeRowForExport", () => {
  test("neutralizes a plain dangerous string value", () => {
    const result = neutralizeRowForExport({ label: "=1+1" });
    expect(result.label).toBe("'=1+1");
  });

  test("leaves a safe string value untouched", () => {
    const result = neutralizeRowForExport({ label: "Acme Corp" });
    expect(result.label).toBe("Acme Corp");
  });

  test("neutralizes a single-element array whose String() form is dangerous", () => {
    // String(["=1+1"]) === "=1+1" -- Array.prototype.toString() joins with
    // no brackets/quotes for a single element, exactly the CSV
    // serialization path (`serializeCsv` call site's `String(value)`).
    const result = neutralizeRowForExport({ tags: ["=1+1"] });
    expect(result.tags).toBe("'=1+1");
  });

  test("neutralizes a multi-element array whose String() form starts dangerously", () => {
    // String(["=1+1", "b"]) === "=1+1,b"
    const result = neutralizeRowForExport({ tags: ["=1+1", "b"] });
    expect(result.tags).toBe("'=1+1,b");
  });

  test("leaves a safe array untouched (preserves structure for JSON export)", () => {
    const result = neutralizeRowForExport({ tags: ["a", "b"] });
    expect(result.tags).toEqual(["a", "b"]);
  });

  test("leaves a safe plain object untouched (preserves structure for JSON export)", () => {
    const result = neutralizeRowForExport({ meta: { a: 1 } });
    expect(result.meta).toEqual({ a: 1 });
  });

  test("numbers, booleans, null, and undefined pass through unchanged", () => {
    const result = neutralizeRowForExport({
      count: -5,
      active: true,
      note: null,
      missing: undefined
    });
    expect(result.count).toBe(-5);
    expect(result.active).toBe(true);
    expect(result.note).toBeNull();
    expect(result.missing).toBeUndefined();
  });

  test("never mutates the input object", () => {
    const input = { label: "=1+1" };
    neutralizeRowForExport(input);
    expect(input.label).toBe("=1+1");
  });
});
