/**
 * Location-to-unit relationship domain rules (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016). Pure functions only — no I/O.
 *
 * An explicit many-to-many join between `awcms_mini_operational_locations`
 * and `awcms_mini_organization_units`, effective-dated like every other
 * resource in this module (issue #749 acceptance criterion: "locations,
 * relationships ... support effective dates and as-of queries").
 */

export type LocationUnitRelationshipType = "primary" | "secondary";

export type LocationUnitRelationshipValidationError = {
  field: string;
  message: string;
};

export type CreateLocationUnitRelationshipInput = {
  operationalLocationId: string;
  organizationUnitId: string;
  relationshipType: LocationUnitRelationshipType;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

export function validateCreateLocationUnitRelationshipInput(
  input: CreateLocationUnitRelationshipInput
): LocationUnitRelationshipValidationError[] {
  const errors: LocationUnitRelationshipValidationError[] = [];

  if (!input.operationalLocationId) {
    errors.push({
      field: "operationalLocationId",
      message: "operationalLocationId is required."
    });
  }

  if (!input.organizationUnitId) {
    errors.push({
      field: "organizationUnitId",
      message: "organizationUnitId is required."
    });
  }

  if (
    input.relationshipType !== "primary" &&
    input.relationshipType !== "secondary"
  ) {
    errors.push({
      field: "relationshipType",
      message: 'relationshipType must be "primary" or "secondary".'
    });
  }

  if (Number.isNaN(input.effectiveFrom.getTime())) {
    errors.push({
      field: "effectiveFrom",
      message: "effectiveFrom must be a valid date."
    });
  }

  if (input.effectiveTo !== null) {
    if (Number.isNaN(input.effectiveTo.getTime())) {
      errors.push({
        field: "effectiveTo",
        message: "effectiveTo must be a valid date when provided."
      });
    } else if (input.effectiveTo <= input.effectiveFrom) {
      errors.push({
        field: "effectiveTo",
        message: "effectiveTo must be after effectiveFrom."
      });
    }
  }

  return errors;
}

export type EndLocationUnitRelationshipInput = {
  endReason: string | null;
};
