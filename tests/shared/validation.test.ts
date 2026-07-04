import { describe, expect, test } from "bun:test";
import {
  assertUuid,
  requireEnum,
  requireFiniteNumber,
  requireString,
  rejectUnknownFields
} from "../../src/modules/_shared/validation";
import { ApiError } from "../../src/modules/_shared/api-error";

describe("validation standard (doc 10)", () => {
  test("assertUuid menerima UUID valid dan menormalkan lowercase", () => {
    expect(assertUuid("123E4567-E89B-42D3-A456-426614174000")).toBe(
      "123e4567-e89b-42d3-a456-426614174000"
    );
  });

  test("assertUuid menolak non-UUID dengan VALIDATION_ERROR", () => {
    expect(() => assertUuid("bukan-uuid")).toThrow(ApiError);
    expect(() => assertUuid("'; DROP TABLE x;--")).toThrow(ApiError);
  });

  test("requireString memangkas spasi dan menegakkan panjang", () => {
    expect(requireString("  halo  ", "name")).toBe("halo");
    expect(() => requireString("", "name")).toThrow(ApiError);
    expect(() => requireString("x".repeat(300), "name")).toThrow(ApiError);
  });

  test("requireEnum menegakkan whitelist", () => {
    expect(requireEnum("active", "status", ["active", "inactive"] as const)).toBe("active");
    expect(() => requireEnum("hacked", "status", ["active", "inactive"] as const)).toThrow(
      ApiError
    );
  });

  test("requireFiniteNumber menolak NaN/Infinity dan menegakkan range", () => {
    expect(requireFiniteNumber("42", "qty", { min: 0 })).toBe(42);
    expect(() => requireFiniteNumber(Number.POSITIVE_INFINITY, "qty")).toThrow(ApiError);
    expect(() => requireFiniteNumber(-1, "qty", { min: 0 })).toThrow(ApiError);
  });

  test("rejectUnknownFields menolak field tak dikenal", () => {
    expect(() => rejectUnknownFields({ name: "a", evil: true }, ["name"])).toThrow(ApiError);
    expect(() => rejectUnknownFields({ name: "a" }, ["name"])).not.toThrow();
  });
});
