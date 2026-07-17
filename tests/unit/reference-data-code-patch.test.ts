/**
 * Unit tests for the reference-data PATCH body parser (Issue #822).
 *
 * The parser had NO unit tests: its semantics were only ever exercised through
 * the integration suite, which meant the pure decision table below — absent vs
 * explicit null vs value, per field — was never pinned directly.
 *
 * Both PATCH schemas are `additionalProperties: false`, but the parser read the
 * keys it knew and ignored the rest, so a client typo (`validUntil` for
 * `validTo`) parsed as an EMPTY patch. Together with the routes' empty-patch
 * no-op branch that answered 200 while changing nothing: the request looked
 * accepted while doing nothing at all. (Review finding, PR #839.)
 */
import { describe, expect, test } from "bun:test";

import {
  mergeReferenceCodePatchInput,
  parseReferenceCodePatchInput
} from "../../src/modules/reference-data/domain/code-patch";
import type { ReferenceCodeMutableFields } from "../../src/modules/reference-data/domain/code-patch";

const STORED: ReferenceCodeMutableFields = {
  labels: [{ locale: "en", label: "Stored", description: null }],
  sortOrder: 7,
  metadata: { keep: true },
  validFrom: new Date("2026-01-01T00:00:00.000Z"),
  validTo: new Date("2026-12-31T00:00:00.000Z")
};

describe("parseReferenceCodePatchInput — unknown fields", () => {
  test("rejects an unknown field rather than parsing it as an empty patch", () => {
    const result = parseReferenceCodePatchInput({ validUntil: "2026-06-01" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toEqual(["validUntil"]);
  });

  test("rejects an unknown field even when a KNOWN field is also present -- a valid field must not launder an invalid one", () => {
    const result = parseReferenceCodePatchInput({
      sortOrder: 3,
      validUntil: "2026-06-01"
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toContain("validUntil");
  });

  test("reports EVERY unknown field, not just the first", () => {
    const result = parseReferenceCodePatchInput({
      typoOne: 1,
      typoTwo: 2
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field).sort()).toEqual([
      "typoOne",
      "typoTwo"
    ]);
  });

  test("`{}` stays valid -- the documented no-op must not be collateral damage of the unknown-field check", () => {
    const result = parseReferenceCodePatchInput({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.patch)).toEqual([]);
  });

  test.each([
    ["labels", { labels: [{ locale: "en", label: "New" }] }],
    ["sortOrder", { sortOrder: 3 }],
    ["metadata", { metadata: { a: 1 } }],
    ["validFrom", { validFrom: "2026-02-01T00:00:00.000Z" }],
    ["validTo", { validTo: null }]
  ])(
    "every field the parser documents is accepted, so the known-field set cannot drift from the parser (%s)",
    (_label, body) => {
      const result = parseReferenceCodePatchInput(body);
      expect(result.ok).toBe(true);
    }
  );
});

describe("parseReferenceCodePatchInput — absent vs null vs value", () => {
  test("an absent field is absent from the patch, so the merge keeps the stored value", () => {
    const result = parseReferenceCodePatchInput({ sortOrder: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.patch.validTo).toBeUndefined();
    const merged = mergeReferenceCodePatchInput(STORED, result.patch);
    expect(merged.validTo).toBe(STORED.validTo);
    expect(merged.sortOrder).toBe(3);
    expect(merged.labels).toBe(STORED.labels);
  });

  test.each([
    ["sortOrder", "sortOrder", 0],
    ["metadata", "metadata", {}],
    ["validTo", "validTo", null]
  ])(
    "an explicit null CLEARS %s rather than being conflated with absent",
    (_label, field, cleared) => {
      const result = parseReferenceCodePatchInput({ [field]: null });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const merged = mergeReferenceCodePatchInput(
        STORED,
        result.patch
      ) as Record<string, unknown>;
      expect(merged[field]).toEqual(cleared);
    }
  );

  test.each([["labels"], ["validFrom"]])(
    "an explicit null on %s is REJECTED -- the column is never nullable, so silently defaulting it would be data loss",
    (field) => {
      const result = parseReferenceCodePatchInput({ [field]: null });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.map((e) => e.field)).toContain(field);
    }
  );
});
