/**
 * Adversarial formula-injection (CSV injection) tests (Issue #752). Proves
 * a value like `=1+1` or `@SUM(...)` round-trips SAFELY — after
 * neutralization, the value never begins with a character a spreadsheet
 * application would interpret as a formula trigger.
 */
import { describe, expect, test } from "bun:test";

import {
  hasDangerousFormulaPrefix,
  neutralizeFormulaInjectionInFields,
  neutralizeFormulaInjectionValue
} from "../../src/modules/data-exchange/domain/formula-injection-guard";

const DANGEROUS_EXAMPLES = [
  "=1+1",
  "=cmd|'/c calc'!A1",
  "@SUM(A1:A10)",
  "+1+1",
  "-1+1",
  "\t=1+1",
  "\r=1+1"
];

describe("hasDangerousFormulaPrefix", () => {
  for (const value of DANGEROUS_EXAMPLES) {
    test(`flags ${JSON.stringify(value)} as dangerous`, () => {
      expect(hasDangerousFormulaPrefix(value)).toBe(true);
    });
  }

  test("does not flag an ordinary string", () => {
    expect(hasDangerousFormulaPrefix("Acme Corp")).toBe(false);
  });

  test("does not flag an empty string", () => {
    expect(hasDangerousFormulaPrefix("")).toBe(false);
  });

  test("does not flag a value merely CONTAINING a dangerous character mid-string", () => {
    expect(hasDangerousFormulaPrefix("A=B+C")).toBe(false);
  });
});

describe("neutralizeFormulaInjectionValue — adversarial round-trip", () => {
  for (const value of DANGEROUS_EXAMPLES) {
    test(`neutralizes ${JSON.stringify(value)} and the result is safe`, () => {
      const result = neutralizeFormulaInjectionValue(value);

      expect(result.neutralized).toBe(true);
      expect(result.value.startsWith("'")).toBe(true);
      // The exact original payload is still recoverable (strip one leading
      // quote) — neutralization is lossless, not destructive.
      expect(result.value.slice(1)).toBe(value);
      // The critical safety property: the NEUTRALIZED value itself must
      // never begin with a dangerous character.
      expect(hasDangerousFormulaPrefix(result.value)).toBe(false);
    });
  }

  test("leaves a safe value completely unchanged", () => {
    const result = neutralizeFormulaInjectionValue("Acme Corp");
    expect(result).toEqual({ value: "Acme Corp", neutralized: false });
  });

  test("is idempotent — re-neutralizing an already-neutralized value is a no-op", () => {
    const first = neutralizeFormulaInjectionValue("=1+1");
    const second = neutralizeFormulaInjectionValue(first.value);

    expect(second.neutralized).toBe(false);
    expect(second.value).toBe(first.value);
  });

  test("empty string is never neutralized", () => {
    expect(neutralizeFormulaInjectionValue("")).toEqual({
      value: "",
      neutralized: false
    });
  });
});

describe("neutralizeFormulaInjectionInFields", () => {
  test("neutralizes only dangerous string fields, leaves everything else untouched", () => {
    const result = neutralizeFormulaInjectionInFields({
      code: "acme",
      label: "=SUM(A1:A10)",
      value: -5,
      active: true,
      nested: { note: "@evil" }
    });

    expect(result.fields.code).toBe("acme");
    expect(result.fields.label).toBe("'=SUM(A1:A10)");
    // Numeric -5 is not a string -- untouched (a legitimate negative
    // number is not a spreadsheet formula).
    expect(result.fields.value).toBe(-5);
    expect(result.fields.active).toBe(true);
    // Nested objects are left as-is by this shallow pass (CSV rows never
    // have nested objects; JSON rows that do are the owning adapter's own
    // responsibility to neutralize recursively if needed).
    expect(result.fields.nested).toEqual({ note: "@evil" });
    expect(result.neutralizedFieldNames).toEqual(["label"]);
  });

  test("reports zero neutralized field names when nothing is dangerous", () => {
    const result = neutralizeFormulaInjectionInFields({ a: "safe", b: 1 });
    expect(result.neutralizedFieldNames).toEqual([]);
  });

  test("never mutates the input object", () => {
    const input = { label: "=1+1" };
    neutralizeFormulaInjectionInFields(input);
    expect(input.label).toBe("=1+1");
  });
});
