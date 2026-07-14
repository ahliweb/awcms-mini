/**
 * Unit tests for the bounded document-number format template grammar
 * (Issue #751) — pure, no I/O. Covers the security requirement directly:
 * "Template formatting cannot execute arbitrary code, SQL, filesystem/
 * network access, or unbounded regex" — every rejected case here is a
 * template that a naive `eval`/dynamic-regex implementation would have
 * accepted.
 */
import { describe, expect, test } from "bun:test";

import {
  renderNumberFormatTemplate,
  validateNumberFormatTemplate
} from "../../src/modules/document-infrastructure/domain/number-format-template";

describe("validateNumberFormatTemplate", () => {
  test("accepts a well-formed template with SEQ width, date tokens, and literals", () => {
    expect(validateNumberFormatTemplate("INV/{YYYY}/{SEQ:6}")).toEqual([]);
  });

  test("accepts a bare {SEQ} token (implicit width 1)", () => {
    expect(validateNumberFormatTemplate("{SEQ}")).toEqual([]);
  });

  test("rejects an empty template", () => {
    const errors = validateNumberFormatTemplate("");
    expect(errors.some((e) => e.field === "formatTemplate")).toBe(true);
  });

  test("rejects a template with no SEQ token at all", () => {
    const errors = validateNumberFormatTemplate("INV/{YYYY}/{MM}");
    expect(errors.some((e) => e.message.includes("SEQ"))).toBe(true);
  });

  test("rejects a template with two SEQ tokens", () => {
    const errors = validateNumberFormatTemplate("{SEQ}-{SEQ:3}");
    expect(errors.some((e) => e.message.includes("exactly one"))).toBe(true);
  });

  test("rejects an unmatched opening brace (no closing brace anywhere after it)", () => {
    const errors = validateNumberFormatTemplate("INV/{SEQ");
    expect(errors.some((e) => e.message.includes("Unmatched"))).toBe(true);
  });

  test("rejects a spanning/nested-looking brace pair as an unknown token rather than silently accepting it", () => {
    // The scanner is a single left-to-right pass with no brace nesting —
    // `{YYYY/{SEQ}` pairs the FIRST `{` with the FIRST `}` found after it,
    // producing the garbage token "YYYY/{SEQ" (rejected as unknown),
    // rather than a genuine "unmatched brace" or, worse, silently treating
    // the embedded `{SEQ}` as valid.
    const errors = validateNumberFormatTemplate("INV/{YYYY/{SEQ}");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("rejects an unmatched closing brace", () => {
    const errors = validateNumberFormatTemplate("INV/YYYY}/{SEQ}");
    expect(errors.some((e) => e.message.includes("Unmatched"))).toBe(true);
  });

  test("rejects an unknown token", () => {
    const errors = validateNumberFormatTemplate("{SEQ}-{BOGUS}");
    expect(
      errors.some((e) => e.message.includes("Unknown template token"))
    ).toBe(true);
  });

  test("rejects a SEQ width above the bound (12)", () => {
    const errors = validateNumberFormatTemplate("{SEQ:13}");
    expect(errors.some((e) => e.message.includes("between 1 and 12"))).toBe(
      true
    );
  });

  test("rejects a SEQ width of zero", () => {
    const errors = validateNumberFormatTemplate("{SEQ:0}");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("rejects a non-numeric SEQ width (guards against a template smuggling code into the width slot)", () => {
    const errors = validateNumberFormatTemplate("{SEQ:x}");
    expect(errors.some((e) => e.message.includes("Invalid SEQ width"))).toBe(
      true
    );
  });

  test("rejects a disallowed literal character (control-character/injection guard)", () => {
    const errors = validateNumberFormatTemplate("INV\n{SEQ}");
    expect(errors.some((e) => e.message.includes("is not allowed"))).toBe(true);
  });

  test("rejects a template longer than 128 characters", () => {
    const errors = validateNumberFormatTemplate("A".repeat(129) + "{SEQ}");
    expect(errors.some((e) => e.message.includes("at most 128"))).toBe(true);
  });
});

describe("renderNumberFormatTemplate", () => {
  const date = new Date("2026-07-14T10:00:00Z");

  test("renders SEQ with zero-padding to the declared width", () => {
    expect(
      renderNumberFormatTemplate("INV/{YYYY}/{SEQ:6}", {
        sequenceValue: 42,
        date
      })
    ).toBe("INV/2026/000042");
  });

  test("renders a bare {SEQ} without padding beyond width 1", () => {
    expect(
      renderNumberFormatTemplate("{SEQ}", { sequenceValue: 7, date })
    ).toBe("7");
  });

  test("renders {YY}/{MM}/{DD}", () => {
    expect(
      renderNumberFormatTemplate("{YY}-{MM}-{DD}/{SEQ}", {
        sequenceValue: 1,
        date
      })
    ).toBe("26-07-14/1");
  });

  test("does not truncate a sequence value wider than the declared padding width", () => {
    expect(
      renderNumberFormatTemplate("{SEQ:2}", { sequenceValue: 12345, date })
    ).toBe("12345");
  });

  test("throws (never silently emits attacker-controlled output) for an invalid template", () => {
    expect(() =>
      renderNumberFormatTemplate("{BOGUS}", { sequenceValue: 1, date })
    ).toThrow();
  });
});
