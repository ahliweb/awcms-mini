import { describe, expect, test } from "bun:test";

import { validateReferenceItemRow } from "../../src/modules/data-exchange/domain/reference-item-validation";

describe("validateReferenceItemRow", () => {
  test("accepts a well-formed row", () => {
    const result = validateReferenceItemRow({
      code: "ACME",
      label: "Acme Corp",
      value: "12.5",
      status: "active"
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.fields).toEqual({
        code: "acme",
        label: "Acme Corp",
        value: 12.5,
        status: "active"
      });
    }
  });

  test("rejects a missing code", () => {
    const result = validateReferenceItemRow({ label: "Acme" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === "code")).toBe(true);
    }
  });

  test("rejects a malformed code", () => {
    const result = validateReferenceItemRow({
      code: "Not Valid!",
      label: "Acme"
    });
    expect(result.valid).toBe(false);
  });

  test("rejects a missing label", () => {
    const result = validateReferenceItemRow({ code: "acme" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === "label")).toBe(true);
    }
  });

  test("rejects a non-numeric value", () => {
    const result = validateReferenceItemRow({
      code: "acme",
      label: "Acme",
      value: "not-a-number"
    });
    expect(result.valid).toBe(false);
  });

  test("rejects an invalid status", () => {
    const result = validateReferenceItemRow({
      code: "acme",
      label: "Acme",
      status: "bogus"
    });
    expect(result.valid).toBe(false);
  });

  test("defaults status to active when omitted", () => {
    const result = validateReferenceItemRow({ code: "acme", label: "Acme" });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.fields.status).toBe("active");
    }
  });

  test("neutralizes a formula-injection-shaped label and reports a warning", () => {
    const result = validateReferenceItemRow({
      code: "acme",
      label: "=SUM(A1:A10)"
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.fields.label).toBe("'=SUM(A1:A10)");
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });

  test("lowercases and trims the code", () => {
    const result = validateReferenceItemRow({
      code: "  ACME  ",
      label: "Acme"
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.fields.code).toBe("acme");
    }
  });
});
