/**
 * Organization-unit domain rules (Issue #749, epic #738 platform-evolution
 * Wave 2, ADR-0016). Pure functions only — no I/O.
 *
 * `legalEntityId`/`unitTypeId` are both OPTIONAL — a unit directly under
 * the tenant with no legal entity, and/or with no declared type, is
 * explicitly allowed (issue #749 scope: "each optionally linked to a legal
 * entity (never required — units directly under the tenant are explicitly
 * allowed) and optionally to a unit type").
 */

const MAX_NAME_LENGTH = 200;
const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export type OrganizationUnitValidationError = {
  field: string;
  message: string;
};

export type CreateOrganizationUnitInput = {
  code: string;
  name: string;
  legalEntityId: string | null;
  unitTypeId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

export type UpdateOrganizationUnitInput = {
  name: string;
  legalEntityId: string | null;
  unitTypeId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

function validateEffectivePeriod(
  effectiveFrom: Date,
  effectiveTo: Date | null,
  errors: OrganizationUnitValidationError[]
): void {
  if (Number.isNaN(effectiveFrom.getTime())) {
    errors.push({
      field: "effectiveFrom",
      message: "effectiveFrom must be a valid date."
    });
  }

  if (effectiveTo !== null) {
    if (Number.isNaN(effectiveTo.getTime())) {
      errors.push({
        field: "effectiveTo",
        message: "effectiveTo must be a valid date when provided."
      });
    } else if (effectiveTo <= effectiveFrom) {
      errors.push({
        field: "effectiveTo",
        message: "effectiveTo must be after effectiveFrom."
      });
    }
  }
}

export function validateCreateOrganizationUnitInput(
  input: CreateOrganizationUnitInput
): OrganizationUnitValidationError[] {
  const errors: OrganizationUnitValidationError[] = [];

  if (!input.code || !CODE_PATTERN.test(input.code)) {
    errors.push({
      field: "code",
      message:
        "code is required and must be lowercase alphanumeric with '_'/'-' separators."
    });
  }

  if (!input.name || input.name.trim().length === 0) {
    errors.push({ field: "name", message: "name is required." });
  } else if (input.name.length > MAX_NAME_LENGTH) {
    errors.push({
      field: "name",
      message: `name must be at most ${MAX_NAME_LENGTH} characters.`
    });
  }

  validateEffectivePeriod(input.effectiveFrom, input.effectiveTo, errors);

  return errors;
}

export function validateUpdateOrganizationUnitInput(
  input: UpdateOrganizationUnitInput
): OrganizationUnitValidationError[] {
  const errors: OrganizationUnitValidationError[] = [];

  if (!input.name || input.name.trim().length === 0) {
    errors.push({ field: "name", message: "name is required." });
  } else if (input.name.length > MAX_NAME_LENGTH) {
    errors.push({
      field: "name",
      message: `name must be at most ${MAX_NAME_LENGTH} characters.`
    });
  }

  validateEffectivePeriod(input.effectiveFrom, input.effectiveTo, errors);

  return errors;
}

export type OrganizationUnitStatus = "active" | "inactive";

export function isOrganizationUnitCurrentlyActive(
  unit: {
    status: OrganizationUnitStatus;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  },
  now: Date
): boolean {
  if (unit.status !== "active") {
    return false;
  }
  if (now < unit.effectiveFrom) {
    return false;
  }
  if (unit.effectiveTo !== null && now >= unit.effectiveTo) {
    return false;
  }
  return true;
}
