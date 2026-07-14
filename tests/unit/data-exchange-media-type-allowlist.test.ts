import { describe, expect, test } from "bun:test";

import {
  allowedMediaTypesFor,
  isAllowedMediaType
} from "../../src/modules/data-exchange/domain/media-type-allowlist";

describe("isAllowedMediaType", () => {
  test("accepts text/csv for csv format", () => {
    expect(isAllowedMediaType("csv", "text/csv")).toBe(true);
  });

  test("accepts application/json for json format", () => {
    expect(isAllowedMediaType("json", "application/json")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isAllowedMediaType("csv", "TEXT/CSV")).toBe(true);
  });

  test("strips a charset parameter suffix", () => {
    expect(isAllowedMediaType("csv", "text/csv; charset=utf-8")).toBe(true);
  });

  test("rejects a media type not on the allow-list for that format", () => {
    expect(isAllowedMediaType("csv", "image/png")).toBe(false);
    expect(isAllowedMediaType("json", "image/png")).toBe(false);
  });

  test("rejects json media type for csv format and vice versa", () => {
    expect(isAllowedMediaType("csv", "application/json")).toBe(false);
    expect(isAllowedMediaType("json", "text/csv")).toBe(false);
  });

  test("rejects an empty media type (never silently accepted)", () => {
    expect(isAllowedMediaType("csv", "")).toBe(false);
    expect(isAllowedMediaType("json", "")).toBe(false);
  });
});

describe("allowedMediaTypesFor", () => {
  test("returns a non-empty list for both formats", () => {
    expect(allowedMediaTypesFor("csv").length).toBeGreaterThan(0);
    expect(allowedMediaTypesFor("json").length).toBeGreaterThan(0);
  });
});
