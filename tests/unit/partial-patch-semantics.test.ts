/**
 * Unit tests for the partial-`PATCH` semantics introduced by Issue #837:
 * absent = keep, explicit `null` = clear a nullable field, `null` on a
 * `NOT NULL` field = rejected. Covers the shared primitives
 * (`_shared/partial-patch.ts`) and the per-entity parse/merge helpers so the
 * absent-vs-null distinction is pinned WITHOUT needing a database.
 */
import { describe, expect, test } from "bun:test";

import {
  patchFieldPresent,
  readNullableNumberPatch,
  readNullableStringPatch,
  readRequiredDatePatch,
  readRequiredStringPatch,
  type PatchFieldError
} from "../../src/modules/_shared/partial-patch";
import {
  mergeOrganizationUnitPatch,
  parseOrganizationUnitPatch,
  mergeOrganizationUnitTypePatch,
  parseOrganizationUnitTypePatch
} from "../../src/modules/organization-structure/domain/patch-input";
import {
  mergeReferenceValueSetPatch,
  parseReferenceValueSetPatch
} from "../../src/modules/reference-data/domain/value-set-patch";

describe("_shared/partial-patch primitives", () => {
  test("patchFieldPresent distinguishes an explicit null from an absent key", () => {
    expect(patchFieldPresent({ a: null }, "a")).toBe(true);
    expect(patchFieldPresent({}, "a")).toBe(false);
  });

  test("readNullableStringPatch: absent -> undefined, null -> null, string -> value, other -> error", () => {
    const errors: PatchFieldError[] = [];
    expect(readNullableStringPatch({}, "x", errors)).toBeUndefined();
    expect(readNullableStringPatch({ x: null }, "x", errors)).toBeNull();
    expect(readNullableStringPatch({ x: "v" }, "x", errors)).toBe("v");
    expect(errors).toHaveLength(0);
    expect(readNullableStringPatch({ x: 5 }, "x", errors)).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  test("readRequiredStringPatch: present+null is an error, absent is undefined (no error)", () => {
    const errors: PatchFieldError[] = [];
    expect(readRequiredStringPatch({}, "name", errors)).toBeUndefined();
    expect(errors).toHaveLength(0);
    expect(
      readRequiredStringPatch({ name: null }, "name", errors)
    ).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  test("readRequiredDatePatch: present+null is an error; readNullableNumberPatch: null clears", () => {
    const dateErrors: PatchFieldError[] = [];
    expect(
      readRequiredDatePatch(
        { effectiveFrom: null },
        "effectiveFrom",
        dateErrors
      )
    ).toBeUndefined();
    expect(dateErrors).toHaveLength(1);

    const numErrors: PatchFieldError[] = [];
    expect(readNullableNumberPatch({ lat: null }, "lat", numErrors)).toBeNull();
    expect(readNullableNumberPatch({ lat: 1.5 }, "lat", numErrors)).toBe(1.5);
    expect(numErrors).toHaveLength(0);
  });
});

describe("organization-unit patch parse/merge (Issue #837)", () => {
  const existing = {
    name: "Original",
    legalEntityId: "le-1",
    unitTypeId: "type-1",
    effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
    effectiveTo: new Date("2030-01-01T00:00:00.000Z")
  };

  test("an absent field is carried over verbatim; only the present field changes", () => {
    const parsed = parseOrganizationUnitPatch({ name: "Renamed" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const merged = mergeOrganizationUnitPatch(existing, parsed.patch);
    expect(merged.name).toBe("Renamed");
    expect(merged.effectiveFrom).toEqual(existing.effectiveFrom);
    expect(merged.effectiveTo).toEqual(existing.effectiveTo);
    expect(merged.legalEntityId).toBe("le-1");
    expect(merged.unitTypeId).toBe("type-1");
  });

  test("an explicit null clears a nullable field (effectiveTo, FK) but keeps the rest", () => {
    const parsed = parseOrganizationUnitPatch({
      effectiveTo: null,
      legalEntityId: null
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const merged = mergeOrganizationUnitPatch(existing, parsed.patch);
    expect(merged.effectiveTo).toBeNull();
    expect(merged.legalEntityId).toBeNull();
    expect(merged.name).toBe("Original");
    expect(merged.effectiveFrom).toEqual(existing.effectiveFrom);
  });

  test("an explicit null on a NOT NULL field (name, effectiveFrom) is rejected, not defaulted", () => {
    expect(parseOrganizationUnitPatch({ name: null }).ok).toBe(false);
    expect(parseOrganizationUnitPatch({ effectiveFrom: null }).ok).toBe(false);
  });

  test("an empty patch merges to the stored values unchanged", () => {
    const parsed = parseOrganizationUnitPatch({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(mergeOrganizationUnitPatch(existing, parsed.patch)).toEqual(
      existing
    );
  });
});

describe("value-set + unit-type patch parse/merge (Issue #837)", () => {
  test("value set: PATCH { name } keeps description; { description: null } clears it; { name: null } rejected", () => {
    const existing = { name: "Currencies", description: "ISO 4217" };

    const nameOnly = parseReferenceValueSetPatch({ name: "New" });
    expect(nameOnly.ok).toBe(true);
    if (nameOnly.ok) {
      const merged = mergeReferenceValueSetPatch(existing, nameOnly.patch);
      expect(merged.name).toBe("New");
      expect(merged.description).toBe("ISO 4217");
    }

    const clear = parseReferenceValueSetPatch({ description: null });
    expect(clear.ok).toBe(true);
    if (clear.ok) {
      const merged = mergeReferenceValueSetPatch(existing, clear.patch);
      expect(merged.description).toBeNull();
      expect(merged.name).toBe("Currencies");
    }

    expect(parseReferenceValueSetPatch({ name: null }).ok).toBe(false);
  });

  test("unit-type: description survives a name-only patch and clears on explicit null", () => {
    const existing = { name: "Branch", description: "Retail branch" };
    const nameOnly = parseOrganizationUnitTypePatch({ name: "Store" });
    expect(nameOnly.ok).toBe(true);
    if (nameOnly.ok) {
      expect(
        mergeOrganizationUnitTypePatch(existing, nameOnly.patch).description
      ).toBe("Retail branch");
    }
    const clear = parseOrganizationUnitTypePatch({ description: null });
    expect(clear.ok).toBe(true);
    if (clear.ok) {
      expect(
        mergeOrganizationUnitTypePatch(existing, clear.patch).description
      ).toBeNull();
    }
  });
});
