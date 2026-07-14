/**
 * Pure unit tests for reference_data's validated-import diff computation
 * (Issue #750, epic #738 platform-evolution Wave 3, ADR-0021 §8/§11) —
 * including the ADVERSARIAL case the issue explicitly calls out: import
 * must reject destructive replacement of a code already referenced by
 * tenant data.
 */
import { describe, expect, test } from "bun:test";
import {
  computeImportDiff,
  validateImportPayloadShape,
  type ImportDiffExistingCode,
  type ImportDiffPayloadCode
} from "../../src/modules/reference-data/domain/import-diff";

function payloadCode(
  overrides: Partial<ImportDiffPayloadCode> = {}
): ImportDiffPayloadCode {
  return {
    code: "IDR",
    labels: [{ locale: "en", label: "Indonesian Rupiah", description: null }],
    sortOrder: 0,
    metadata: {},
    validFrom: "2020-01-01",
    validTo: null,
    ...overrides
  };
}

describe("computeImportDiff", () => {
  test("a brand new code (not in existing) is a create", () => {
    const diff = computeImportDiff([], [payloadCode({ code: "USD" })]);
    expect(diff.ok).toBe(true);
    expect(diff.toCreate.map((c) => c.code)).toEqual(["USD"]);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toDeprecate).toHaveLength(0);
  });

  test("an existing code reappearing without replace=true is an ordinary update", () => {
    const existing: ImportDiffExistingCode[] = [
      { code: "IDR", referenced: false }
    ];
    const diff = computeImportDiff(existing, [payloadCode({ code: "IDR" })]);
    expect(diff.ok).toBe(true);
    expect(diff.toUpdate.map((c) => c.code)).toEqual(["IDR"]);
    expect(diff.toCreate).toHaveLength(0);
  });

  test("an existing code missing from the new payload is only ever DEPRECATED, never a delete list", () => {
    const existing: ImportDiffExistingCode[] = [
      { code: "IDR", referenced: false },
      { code: "USD", referenced: false }
    ];
    const diff = computeImportDiff(existing, [payloadCode({ code: "IDR" })]);
    expect(diff.ok).toBe(true);
    expect(diff.toDeprecate).toEqual(["USD"]);
  });

  test("ADVERSARIAL: replace=true against an UNREFERENCED existing code is allowed", () => {
    const existing: ImportDiffExistingCode[] = [
      { code: "IDR", referenced: false }
    ];
    const diff = computeImportDiff(existing, [
      payloadCode({ code: "IDR", replace: true })
    ]);
    expect(diff.ok).toBe(true);
    expect(diff.blockedReplacements).toHaveLength(0);
  });

  test("ADVERSARIAL: replace=true against a code ALREADY REFERENCED by tenant data is REJECTED (issue #750 core safety requirement)", () => {
    const existing: ImportDiffExistingCode[] = [
      { code: "IDR", referenced: true }
    ];
    const diff = computeImportDiff(existing, [
      payloadCode({ code: "IDR", replace: true })
    ]);

    expect(diff.ok).toBe(false);
    expect(diff.blockedReplacements).toEqual(["IDR"]);
    // The blocked code must NOT silently appear in toCreate or toUpdate —
    // the whole point is that NOTHING is applied for it.
    expect(diff.toCreate.some((c) => c.code === "IDR")).toBe(false);
    expect(diff.toUpdate.some((c) => c.code === "IDR")).toBe(false);
  });

  test("ADVERSARIAL: one blocked replacement does not silently also block unrelated codes in the same batch", () => {
    const existing: ImportDiffExistingCode[] = [
      { code: "IDR", referenced: true },
      { code: "USD", referenced: false }
    ];
    const diff = computeImportDiff(existing, [
      payloadCode({ code: "IDR", replace: true }),
      payloadCode({ code: "USD" })
    ]);

    expect(diff.ok).toBe(false); // whole batch reported not-ok...
    expect(diff.blockedReplacements).toEqual(["IDR"]);
    // ...but the diff still correctly reports what WOULD have happened to
    // the unrelated code, for an accurate preview (the caller/commit path
    // is responsible for refusing to apply ANYTHING when ok is false —
    // this pure function's job is just accurate reporting).
    expect(diff.toUpdate.map((c) => c.code)).toEqual(["USD"]);
  });

  test("a code reappearing after being removed in a prior import (no replace flag) is treated as update, not blocked", () => {
    // Regression guard: `code` is unique per value set FOREVER at the DB
    // layer (never a partial unique index) — a previously-deprecated
    // code reappearing in a payload must be an update (which also clears
    // deprecation), never mistaken for a destructive replace.
    const existing: ImportDiffExistingCode[] = [
      { code: "IDR", referenced: false }
    ];
    const diff = computeImportDiff(existing, [payloadCode({ code: "IDR" })]);
    expect(diff.ok).toBe(true);
    expect(diff.toUpdate.map((c) => c.code)).toEqual(["IDR"]);
  });
});

describe("validateImportPayloadShape", () => {
  test("rejects an empty codes array", () => {
    const errors = validateImportPayloadShape([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("rejects duplicate codes within the same payload", () => {
    const errors = validateImportPayloadShape([
      payloadCode({ code: "IDR" }),
      payloadCode({ code: "IDR" })
    ]);
    expect(errors.some((e) => e.message.includes("duplicate"))).toBe(true);
  });

  test("accepts a well-formed payload", () => {
    const errors = validateImportPayloadShape([
      payloadCode({ code: "IDR" }),
      payloadCode({ code: "USD" })
    ]);
    expect(errors).toHaveLength(0);
  });

  test("ADVERSARIAL (security-review Critical): rejects an invalid code format — the import path must apply the SAME code-format rule as the manual create/update path", () => {
    const errors = validateImportPayloadShape([
      payloadCode({ code: "not a valid code!!" })
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("ADVERSARIAL (security-review Critical): rejects a payload entry missing an 'en' label — the import path previously skipped ALL label validation", () => {
    const errors = validateImportPayloadShape([
      payloadCode({
        code: "IDR",
        labels: [{ locale: "id", label: "Rupiah", description: null }]
      })
    ]);
    expect(errors.some((e) => e.message.includes('"en"'))).toBe(true);
  });

  test("ADVERSARIAL (security-review Critical): rejects metadata that looks like a template/SQL injection attempt via the import path — previously the import path never validated metadata content at all", () => {
    const templateErrors = validateImportPayloadShape([
      payloadCode({ code: "IDR", metadata: { note: "${process.env.SECRET}" } })
    ]);
    expect(templateErrors.length).toBeGreaterThan(0);

    const sqlErrors = validateImportPayloadShape([
      payloadCode({
        code: "IDR",
        metadata: { note: "'; DROP TABLE awcms_mini_reference_codes; --" }
      })
    ]);
    expect(sqlErrors.length).toBeGreaterThan(0);
  });

  test("ADVERSARIAL: rejects metadata with a non-primitive value via the import path", () => {
    const errors = validateImportPayloadShape([
      payloadCode({ code: "IDR", metadata: { nested: { a: 1 } } })
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("ADVERSARIAL (security-review Critical, issue #750 'no secrets'): rejects real credential-shaped metadata via the import path — the import path never called ANY metadata validator before, so even the weak SQL/template regex was skipped for imported codes", () => {
    const awsKeyErrors = validateImportPayloadShape([
      payloadCode({
        code: "IDR",
        metadata: { note: "AKIAIOSFODNN7EXAMPLE" }
      })
    ]);
    expect(awsKeyErrors.length).toBeGreaterThan(0);

    // Deliberately fabricated, not a canonical example JWT (see
    // tests/audit-log.test.ts's "finds a JWT-shaped value..." comment) --
    // only needs to be JWT-*shaped* (three base64url segments prefixed
    // `eyJ`) to exercise the regex, and a fabricated non-canonical value
    // avoids tripping GitGuardian's structural JWT scanner on this PR.
    const jwtErrors = validateImportPayloadShape([
      payloadCode({
        code: "IDR",
        metadata: {
          note: "eyJub3RfYV9yZWFsX2p3dF9maXh0dXJl.eyJqdXN0X3Rlc3RfZGF0YV9oZXJl.bm90YV9yZWFsX3NpZ25hdHVyZQ"
        }
      })
    ]);
    expect(jwtErrors.length).toBeGreaterThan(0);

    const connectionStringErrors = validateImportPayloadShape([
      payloadCode({
        code: "IDR",
        metadata: { note: "postgres://admin:S3cretPass@db.internal:5432/prod" }
      })
    ]);
    expect(connectionStringErrors.length).toBeGreaterThan(0);
  });
});
