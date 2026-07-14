/**
 * Organization-unit type domain rules (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016). Pure functions only — no I/O.
 *
 * A tenant-CONFIGURABLE typed vocabulary — `department`/`branch`/
 * `cost_center`/`warehouse`/`program_unit` (see `DEFAULT_UNIT_TYPE_SEEDS`
 * below) are suggested seed examples documented for admin UI/README
 * convenience, never hardcoded rows in a migration — every tenant defines
 * its own set, and the vocabulary is deliberately generic (not tied to one
 * business vertical).
 */

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

export type OrganizationUnitTypeValidationError = {
  field: string;
  message: string;
};

export type CreateOrganizationUnitTypeInput = {
  code: string;
  name: string;
  description: string | null;
};

export type UpdateOrganizationUnitTypeInput = {
  name: string;
  description: string | null;
};

export function validateCreateOrganizationUnitTypeInput(
  input: CreateOrganizationUnitTypeInput
): OrganizationUnitTypeValidationError[] {
  const errors: OrganizationUnitTypeValidationError[] = [];

  if (!input.code || !CODE_PATTERN.test(input.code)) {
    errors.push({
      field: "code",
      message:
        'code is required and must be lowercase snake_case (e.g. "branch").'
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

  if (
    input.description !== null &&
    input.description.length > MAX_DESCRIPTION_LENGTH
  ) {
    errors.push({
      field: "description",
      message: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`
    });
  }

  return errors;
}

export function validateUpdateOrganizationUnitTypeInput(
  input: UpdateOrganizationUnitTypeInput
): OrganizationUnitTypeValidationError[] {
  const errors: OrganizationUnitTypeValidationError[] = [];

  if (!input.name || input.name.trim().length === 0) {
    errors.push({ field: "name", message: "name is required." });
  } else if (input.name.length > MAX_NAME_LENGTH) {
    errors.push({
      field: "name",
      message: `name must be at most ${MAX_NAME_LENGTH} characters.`
    });
  }

  if (
    input.description !== null &&
    input.description.length > MAX_DESCRIPTION_LENGTH
  ) {
    errors.push({
      field: "description",
      message: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`
    });
  }

  return errors;
}

/** Documentation-only suggested defaults (issue #749 scope) — never auto-seeded into any tenant's row set; an admin UI action MAY offer these as one-click create suggestions, not a migration-time INSERT. */
export const DEFAULT_UNIT_TYPE_SEEDS: readonly {
  code: string;
  name: string;
}[] = [
  { code: "department", name: "Department" },
  { code: "branch", name: "Branch" },
  { code: "cost_center", name: "Cost Center" },
  { code: "warehouse", name: "Warehouse" },
  { code: "program_unit", name: "Program Unit" }
];
