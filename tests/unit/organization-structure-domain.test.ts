/**
 * Pure unit tests for organization_structure's remaining domain
 * validators (Issue #749) — legal entity, organization-unit type,
 * organization unit, operational location, and assignment.
 */
import { describe, expect, test } from "bun:test";
import {
  isLegalEntityCurrentlyActive,
  validateCreateLegalEntityInput,
  validateDeactivateLegalEntityInput
} from "../../src/modules/organization-structure/domain/legal-entity";
import { validateCreateOrganizationUnitTypeInput } from "../../src/modules/organization-structure/domain/organization-unit-type";
import { validateCreateOrganizationUnitInput } from "../../src/modules/organization-structure/domain/organization-unit";
import { validateCreateOperationalLocationInput } from "../../src/modules/organization-structure/domain/operational-location";
import {
  isExpiringSoon,
  validateCreateOrganizationUnitAssignmentInput,
  validateEndOrganizationUnitAssignmentInput
} from "../../src/modules/organization-structure/domain/organization-unit-assignment";

describe("legal-entity domain", () => {
  test("requires a non-empty name", () => {
    const errors = validateCreateLegalEntityInput({
      name: "",
      registrationIdentifier: null,
      registrationIdentifierLabel: null,
      effectiveFrom: new Date(),
      effectiveTo: null
    });
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  test("requires registrationIdentifierLabel when registrationIdentifier is set (generic opaque pair)", () => {
    const errors = validateCreateLegalEntityInput({
      name: "PT Contoh",
      registrationIdentifier: "1234567890",
      registrationIdentifierLabel: null,
      effectiveFrom: new Date(),
      effectiveTo: null
    });
    expect(errors.some((e) => e.field === "registrationIdentifierLabel")).toBe(
      true
    );
  });

  test("accepts a valid legal entity with no identifier pair at all", () => {
    const errors = validateCreateLegalEntityInput({
      name: "PT Contoh",
      registrationIdentifier: null,
      registrationIdentifierLabel: null,
      effectiveFrom: new Date(),
      effectiveTo: null
    });
    expect(errors).toEqual([]);
  });

  test("rejects effectiveTo at or before effectiveFrom", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const errors = validateCreateLegalEntityInput({
      name: "PT Contoh",
      registrationIdentifier: null,
      registrationIdentifierLabel: null,
      effectiveFrom: from,
      effectiveTo: from
    });
    expect(errors.some((e) => e.field === "effectiveTo")).toBe(true);
  });

  test("deactivate requires a non-empty deleteReason", () => {
    const errors = validateDeactivateLegalEntityInput({ deleteReason: "" });
    expect(errors).toHaveLength(1);
  });

  test("isLegalEntityCurrentlyActive is false when status is inactive", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(
      isLegalEntityCurrentlyActive(
        {
          status: "inactive",
          effectiveFrom: new Date("2026-01-01T00:00:00Z"),
          effectiveTo: null
        },
        now
      )
    ).toBe(false);
  });

  test("isLegalEntityCurrentlyActive is false before effectiveFrom or after effectiveTo", () => {
    const effectiveFrom = new Date("2026-01-01T00:00:00Z");
    const effectiveTo = new Date("2026-03-01T00:00:00Z");
    expect(
      isLegalEntityCurrentlyActive(
        { status: "active", effectiveFrom, effectiveTo },
        new Date("2025-12-01T00:00:00Z")
      )
    ).toBe(false);
    expect(
      isLegalEntityCurrentlyActive(
        { status: "active", effectiveFrom, effectiveTo },
        new Date("2026-04-01T00:00:00Z")
      )
    ).toBe(false);
    expect(
      isLegalEntityCurrentlyActive(
        { status: "active", effectiveFrom, effectiveTo },
        new Date("2026-02-01T00:00:00Z")
      )
    ).toBe(true);
  });
});

describe("organization-unit-type domain", () => {
  test("requires lowercase snake_case code", () => {
    const errors = validateCreateOrganizationUnitTypeInput({
      code: "Branch-Office",
      name: "Branch Office",
      description: null
    });
    expect(errors.some((e) => e.field === "code")).toBe(true);
  });

  test("accepts a valid code/name pair", () => {
    const errors = validateCreateOrganizationUnitTypeInput({
      code: "branch",
      name: "Branch",
      description: null
    });
    expect(errors).toEqual([]);
  });
});

describe("organization-unit domain", () => {
  test("legalEntityId/unitTypeId are optional (unit directly under tenant is allowed)", () => {
    const errors = validateCreateOrganizationUnitInput({
      code: "hq-01",
      name: "Head Office",
      legalEntityId: null,
      unitTypeId: null,
      effectiveFrom: new Date(),
      effectiveTo: null
    });
    expect(errors).toEqual([]);
  });

  test("rejects an invalid code format", () => {
    const errors = validateCreateOrganizationUnitInput({
      code: "HQ 01!",
      name: "Head Office",
      legalEntityId: null,
      unitTypeId: null,
      effectiveFrom: new Date(),
      effectiveTo: null
    });
    expect(errors.some((e) => e.field === "code")).toBe(true);
  });
});

describe("operational-location domain", () => {
  test("accepts a location with no coordinates at all", () => {
    const errors = validateCreateOperationalLocationInput({
      name: "Main Warehouse",
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      countryCode: null,
      latitude: null,
      longitude: null
    });
    expect(errors).toEqual([]);
  });

  test("rejects latitude out of range", () => {
    const errors = validateCreateOperationalLocationInput({
      name: "Main Warehouse",
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      countryCode: null,
      latitude: 95,
      longitude: 100
    });
    expect(errors.some((e) => e.field === "latitude")).toBe(true);
  });

  test("rejects longitude out of range", () => {
    const errors = validateCreateOperationalLocationInput({
      name: "Main Warehouse",
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      countryCode: null,
      latitude: 10,
      longitude: 200
    });
    expect(errors.some((e) => e.field === "longitude")).toBe(true);
  });

  test("rejects latitude set without longitude (must both be present or both absent)", () => {
    const errors = validateCreateOperationalLocationInput({
      name: "Main Warehouse",
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      countryCode: null,
      latitude: 10,
      longitude: null
    });
    expect(errors.some((e) => e.field === "longitude")).toBe(true);
  });
});

describe("organization-unit-assignment domain", () => {
  test("requires organizationUnitId and tenantUserId", () => {
    const errors = validateCreateOrganizationUnitAssignmentInput({
      organizationUnitId: "",
      tenantUserId: "",
      positionLabel: null,
      effectiveFrom: new Date(),
      effectiveTo: null,
      reason: null
    });
    expect(errors.some((e) => e.field === "organizationUnitId")).toBe(true);
    expect(errors.some((e) => e.field === "tenantUserId")).toBe(true);
  });

  test("end requires a non-empty endReason", () => {
    const errors = validateEndOrganizationUnitAssignmentInput({
      endReason: ""
    });
    expect(errors).toHaveLength(1);
  });

  test("isExpiringSoon is true within the default 30-day window", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const effectiveTo = new Date("2026-06-15T00:00:00Z");
    expect(isExpiringSoon(effectiveTo, now)).toBe(true);
  });

  test("isExpiringSoon is false when effectiveTo is far in the future", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const effectiveTo = new Date("2027-01-01T00:00:00Z");
    expect(isExpiringSoon(effectiveTo, now)).toBe(false);
  });

  test("isExpiringSoon is false for a null effectiveTo (open-ended assignment)", () => {
    expect(isExpiringSoon(null, new Date())).toBe(false);
  });

  test("isExpiringSoon is false once effectiveTo has already passed", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const effectiveTo = new Date("2026-05-01T00:00:00Z");
    expect(isExpiringSoon(effectiveTo, now)).toBe(false);
  });
});
