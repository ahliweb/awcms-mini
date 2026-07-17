import { describe, expect, test } from "bun:test";
import {
  MAX_PAGE_NUMBER,
  boundedPageNumber,
  boundedPageSize,
  parsePageParam
} from "../../src/modules/_shared/offset-pagination";

describe("boundedPageNumber (Issue #819)", () => {
  test("passes through an ordinary in-range page", () => {
    expect(boundedPageNumber(1)).toBe(1);
    expect(boundedPageNumber(7)).toBe(7);
  });

  test("defaults to page 1 when absent", () => {
    expect(boundedPageNumber(undefined)).toBe(1);
  });

  test("clamps a deep offset to MAX_PAGE_NUMBER (?page=1e8 → OFFSET 1e9 DoS)", () => {
    expect(boundedPageNumber(1e8)).toBe(MAX_PAGE_NUMBER);
    expect(MAX_PAGE_NUMBER).toBe(10_000);
  });

  test("returns 1 for NaN rather than propagating it into OFFSET (?page=abc → 500)", () => {
    expect(boundedPageNumber(Number("abc"))).toBe(1);
    expect(boundedPageNumber(Number.NaN)).toBe(1);
  });

  test("returns 1 for ±Infinity", () => {
    expect(boundedPageNumber(Number.POSITIVE_INFINITY)).toBe(1);
    expect(boundedPageNumber(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  test("clamps a negative page up to 1", () => {
    expect(boundedPageNumber(-1)).toBe(1);
    expect(boundedPageNumber(0)).toBe(1);
  });

  test("truncates a fractional page (OFFSET 1.5 is a Postgres error)", () => {
    expect(boundedPageNumber(1.5)).toBe(1);
    expect(boundedPageNumber(3.9)).toBe(3);
    expect(boundedPageNumber(0.5)).toBe(1);
  });

  test("honours a caller-supplied maxPage", () => {
    expect(boundedPageNumber(500, 100)).toBe(100);
  });

  test("every clamped page yields a finite, non-negative, integral OFFSET", () => {
    const pageSize = 10;
    for (const raw of [
      1e8,
      Number.NaN,
      -1,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined
    ]) {
      const offset = (boundedPageNumber(raw) - 1) * pageSize;
      expect(Number.isSafeInteger(offset)).toBe(true);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual((MAX_PAGE_NUMBER - 1) * pageSize);
    }
  });
});

describe("boundedPageSize (Issue #819)", () => {
  test("passes through an in-range size", () => {
    expect(boundedPageSize(25, 10, 50)).toBe(25);
  });

  test("falls back to the default when absent or NaN", () => {
    expect(boundedPageSize(undefined, 10, 50)).toBe(10);
    expect(boundedPageSize(Number.NaN, 10, 50)).toBe(10);
    expect(boundedPageSize(Number.POSITIVE_INFINITY, 10, 50)).toBe(10);
  });

  test("clamps both ends and truncates fractions", () => {
    expect(boundedPageSize(1e8, 10, 50)).toBe(50);
    expect(boundedPageSize(0, 10, 50)).toBe(1);
    expect(boundedPageSize(-5, 10, 50)).toBe(1);
    expect(boundedPageSize(12.7, 10, 50)).toBe(12);
  });
});

describe("parsePageParam (Issue #819)", () => {
  test("defaults to 1 for a missing or blank ?page=", () => {
    expect(parsePageParam(null)).toBe(1);
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam("")).toBe(1);
    expect(parsePageParam("   ")).toBe(1);
  });

  test("parses a normal ?page=", () => {
    expect(parsePageParam("3")).toBe(3);
  });

  test("normalises the hostile inputs from the issue", () => {
    expect(parsePageParam("1e8")).toBe(MAX_PAGE_NUMBER);
    expect(parsePageParam("abc")).toBe(1);
    expect(parsePageParam("-1")).toBe(1);
    expect(parsePageParam("1.5")).toBe(1);
    expect(parsePageParam("Infinity")).toBe(1);
  });

  test("never returns a value that would render as NaN in pagination nav links", () => {
    for (const raw of ["abc", "1e8", "-1", "1.5", "Infinity", "", null]) {
      const page = parsePageParam(raw);
      expect(Number.isInteger(page)).toBe(true);
      expect(String(page)).not.toContain("NaN");
    }
  });
});
