/**
 * Pure unit tests for reference_data's core domain validators (Issue
 * #750, epic #738 platform-evolution Wave 3) — value set, code, and
 * tenant-code (override/extension) validation, plus the metadata
 * executable-expression rejection and the override-policy gate.
 */
import { describe, expect, test } from "bun:test";
import {
  validateCreateReferenceValueSetInput,
  validateUpdateReferenceValueSetInput
} from "../../src/modules/reference-data/domain/value-set";
import {
  isReferenceCodeCurrentlyActive,
  validateCreateReferenceCodeInput,
  validateReferenceMetadata
} from "../../src/modules/reference-data/domain/code";
import {
  isTenantCodeKindAllowed,
  validateCreateTenantReferenceCodeInput
} from "../../src/modules/reference-data/domain/tenant-code";

describe("value-set domain", () => {
  test("rejects an invalid key format", () => {
    const errors = validateCreateReferenceValueSetInput({
      key: "Not-Valid-Key",
      name: "Currency",
      description: null,
      overridePolicy: "none",
      validationSchema: null
    });
    expect(errors.some((e) => e.field === "key")).toBe(true);
  });

  test("accepts a valid snake_case key", () => {
    const errors = validateCreateReferenceValueSetInput({
      key: "currency",
      name: "Currency",
      description: null,
      overridePolicy: "tenant_extend",
      validationSchema: null
    });
    expect(errors).toHaveLength(0);
  });

  test("rejects an unknown overridePolicy", () => {
    const errors = validateCreateReferenceValueSetInput({
      key: "currency",
      name: "Currency",
      description: null,
      overridePolicy: "anything_goes" as never,
      validationSchema: null
    });
    expect(errors.some((e) => e.field === "overridePolicy")).toBe(true);
  });

  test("update requires a non-empty name", () => {
    const errors = validateUpdateReferenceValueSetInput({
      name: "",
      description: null
    });
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });
});

describe("code domain", () => {
  test("requires an 'en' label", () => {
    const errors = validateCreateReferenceCodeInput({
      code: "IDR",
      labels: [{ locale: "id", label: "Rupiah", description: null }],
      sortOrder: 0,
      metadata: {},
      validFrom: new Date(),
      validTo: null
    });
    expect(errors.some((e) => e.field === "labels")).toBe(true);
  });

  test("accepts a valid code with an en label", () => {
    const errors = validateCreateReferenceCodeInput({
      code: "IDR",
      labels: [{ locale: "en", label: "Indonesian Rupiah", description: null }],
      sortOrder: 0,
      metadata: { minorUnit: 2 },
      validFrom: new Date(),
      validTo: null
    });
    expect(errors).toHaveLength(0);
  });

  test("validFrom/validTo ordering is enforced", () => {
    const errors = validateCreateReferenceCodeInput({
      code: "IDR",
      labels: [{ locale: "en", label: "IDR", description: null }],
      sortOrder: 0,
      metadata: {},
      validFrom: new Date("2026-01-01"),
      validTo: new Date("2025-01-01")
    });
    expect(errors.some((e) => e.field === "validTo")).toBe(true);
  });

  test("rejects metadata with a non-primitive value", () => {
    const errors = validateReferenceMetadata({ nested: { a: 1 } });
    expect(errors.some((e) => e.field === "metadata")).toBe(true);
  });

  test("rejects metadata that looks like a SQL/template injection attempt (issue #750: no executable expressions/SQL/templates)", () => {
    const errors = validateReferenceMetadata({
      note: "${process.env.SECRET}"
    });
    expect(errors.some((e) => e.field === "metadata")).toBe(true);

    const sqlErrors = validateReferenceMetadata({
      note: "'; DROP TABLE awcms_mini_reference_codes; --"
    });
    expect(sqlErrors.some((e) => e.field === "metadata")).toBe(true);
  });

  test("rejects metadata that serializes over the size bound", () => {
    const errors = validateReferenceMetadata({ blob: "x".repeat(5000) });
    expect(errors.some((e) => e.field === "metadata")).toBe(true);
  });

  test("ADVERSARIAL (security-review Critical, issue #750 'no secrets'): rejects real credential shapes in metadata via the shared findSecretShapedValues detector, not a bespoke regex", () => {
    const awsKeyErrors = validateReferenceMetadata({
      note: "AKIAIOSFODNN7EXAMPLE"
    });
    expect(awsKeyErrors.some((e) => e.field.startsWith("metadata"))).toBe(true);

    // Deliberately fabricated, not a canonical example JWT (see
    // tests/audit-log.test.ts's "finds a JWT-shaped value..." comment) --
    // only needs to be JWT-*shaped* (three base64url segments prefixed
    // `eyJ`) to exercise the regex, and a fabricated non-canonical value
    // avoids tripping GitGuardian's structural JWT scanner on this PR.
    const jwtErrors = validateReferenceMetadata({
      note: "eyJub3RfYV9yZWFsX2p3dF9maXh0dXJl.eyJqdXN0X3Rlc3RfZGF0YV9oZXJl.bm90YV9yZWFsX3NpZ25hdHVyZQ"
    });
    expect(jwtErrors.some((e) => e.field.startsWith("metadata"))).toBe(true);

    const pemErrors = validateReferenceMetadata({
      note: "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8w\n-----END PRIVATE KEY-----"
    });
    expect(pemErrors.some((e) => e.field.startsWith("metadata"))).toBe(true);

    const bearerErrors = validateReferenceMetadata({
      note: "Bearer not-a-real-token-just-shaped-like-one-1234567890"
    });
    expect(bearerErrors.some((e) => e.field.startsWith("metadata"))).toBe(true);

    const connectionStringErrors = validateReferenceMetadata({
      note: "postgres://admin:S3cretPass@db.internal:5432/prod"
    });
    expect(
      connectionStringErrors.some((e) => e.field.startsWith("metadata"))
    ).toBe(true);
  });

  test("isReferenceCodeCurrentlyActive: deprecated row is never active", () => {
    const now = new Date("2026-06-01");
    const active = isReferenceCodeCurrentlyActive(
      {
        deprecatedAt: new Date("2026-01-01"),
        validFrom: new Date("2025-01-01"),
        validTo: null
      },
      now
    );
    expect(active).toBe(false);
  });

  test("isReferenceCodeCurrentlyActive: future validFrom is not yet active", () => {
    const now = new Date("2026-01-01");
    const active = isReferenceCodeCurrentlyActive(
      { deprecatedAt: null, validFrom: new Date("2026-06-01"), validTo: null },
      now
    );
    expect(active).toBe(false);
  });

  test("isReferenceCodeCurrentlyActive: within the effective window is active", () => {
    const now = new Date("2026-03-01");
    const active = isReferenceCodeCurrentlyActive(
      {
        deprecatedAt: null,
        validFrom: new Date("2026-01-01"),
        validTo: new Date("2026-12-31")
      },
      now
    );
    expect(active).toBe(true);
  });
});

describe("tenant-code override policy gate", () => {
  test("'none' forbids both override and extension", () => {
    expect(isTenantCodeKindAllowed("none", "override")).toBe(false);
    expect(isTenantCodeKindAllowed("none", "extension")).toBe(false);
  });

  test("'tenant_extend' allows extension only", () => {
    expect(isTenantCodeKindAllowed("tenant_extend", "extension")).toBe(true);
    expect(isTenantCodeKindAllowed("tenant_extend", "override")).toBe(false);
  });

  test("'tenant_override' allows override only", () => {
    expect(isTenantCodeKindAllowed("tenant_override", "override")).toBe(true);
    expect(isTenantCodeKindAllowed("tenant_override", "extension")).toBe(false);
  });

  test("'tenant_extend_and_override' allows both", () => {
    expect(
      isTenantCodeKindAllowed("tenant_extend_and_override", "override")
    ).toBe(true);
    expect(
      isTenantCodeKindAllowed("tenant_extend_and_override", "extension")
    ).toBe(true);
  });

  test("create input requires an en label", () => {
    const errors = validateCreateTenantReferenceCodeInput({
      baseCodeId: null,
      code: "CUSTOM",
      labels: [{ locale: "id", label: "Kustom", description: null }],
      sortOrder: 0,
      metadata: {},
      validFrom: new Date(),
      validTo: null
    });
    expect(errors.some((e) => e.field === "labels")).toBe(true);
  });
});
