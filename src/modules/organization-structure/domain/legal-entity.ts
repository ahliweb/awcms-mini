/**
 * Legal-entity domain rules (Issue #749, epic #738 platform-evolution Wave
 * 2, ADR-0016). Pure functions only — no I/O, no database — same
 * "structural validation here, ABAC/persistence elsewhere" split
 * `identity-access/domain/business-scope-assignment.ts` documents for its
 * own module.
 *
 * A legal entity is a tenant-scoped business/legal entity (one PT/CV) —
 * NOT the tenant itself (ADR-0013 §2). `registrationIdentifier`/
 * `registrationIdentifierLabel` are a GENERIC opaque pair (e.g. "Business
 * Registration Number" + an opaque string value) — deliberately never a
 * government-specific field name (NPWP/SIUP/etc, issue #749 explicit
 * requirement), so this module never encodes country-specific tax/business
 * registration rules.
 */

const MAX_NAME_LENGTH = 300;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_LABEL_LENGTH = 120;

export type LegalEntityStatus = "active" | "inactive";

export type LegalEntityValidationError = {
  field: string;
  message: string;
};

export type CreateLegalEntityInput = {
  name: string;
  registrationIdentifier: string | null;
  registrationIdentifierLabel: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

export type UpdateLegalEntityInput = {
  name: string;
  registrationIdentifier: string | null;
  registrationIdentifierLabel: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

function validateCommon(input: {
  name: string;
  registrationIdentifier: string | null;
  registrationIdentifierLabel: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}): LegalEntityValidationError[] {
  const errors: LegalEntityValidationError[] = [];

  if (!input.name || input.name.trim().length === 0) {
    errors.push({ field: "name", message: "name is required." });
  } else if (input.name.length > MAX_NAME_LENGTH) {
    errors.push({
      field: "name",
      message: `name must be at most ${MAX_NAME_LENGTH} characters.`
    });
  }

  if (
    input.registrationIdentifier !== null &&
    input.registrationIdentifier.length > MAX_IDENTIFIER_LENGTH
  ) {
    errors.push({
      field: "registrationIdentifier",
      message: `registrationIdentifier must be at most ${MAX_IDENTIFIER_LENGTH} characters.`
    });
  }

  if (
    input.registrationIdentifierLabel !== null &&
    input.registrationIdentifierLabel.length > MAX_LABEL_LENGTH
  ) {
    errors.push({
      field: "registrationIdentifierLabel",
      message: `registrationIdentifierLabel must be at most ${MAX_LABEL_LENGTH} characters.`
    });
  }

  // "A generic opaque identifier pair" — a label without a value is
  // meaningless (nothing to label); a value without a label is allowed at
  // the domain layer but rejected by the DB CHECK constraint, so reject it
  // here too for a clean 400 rather than a raw constraint violation (same
  // "validate here what the migration also enforces" convention
  // `business-scope-assignment.ts`'s `isTemporary`/`effectiveTo` pair
  // check documents).
  if (
    input.registrationIdentifierLabel !== null &&
    input.registrationIdentifier === null
  ) {
    errors.push({
      field: "registrationIdentifier",
      message:
        "registrationIdentifier is required when registrationIdentifierLabel is set."
    });
  }
  if (
    input.registrationIdentifier !== null &&
    input.registrationIdentifierLabel === null
  ) {
    errors.push({
      field: "registrationIdentifierLabel",
      message:
        "registrationIdentifierLabel is required when registrationIdentifier is set."
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

export function validateCreateLegalEntityInput(
  input: CreateLegalEntityInput
): LegalEntityValidationError[] {
  return validateCommon(input);
}

export function validateUpdateLegalEntityInput(
  input: UpdateLegalEntityInput
): LegalEntityValidationError[] {
  return validateCommon(input);
}

export type DeactivateLegalEntityInput = {
  deleteReason: string;
};

export function validateDeactivateLegalEntityInput(
  input: DeactivateLegalEntityInput
): LegalEntityValidationError[] {
  const errors: LegalEntityValidationError[] = [];

  if (!input.deleteReason || input.deleteReason.trim().length === 0) {
    errors.push({
      field: "deleteReason",
      message: "deleteReason is required."
    });
  }

  return errors;
}

/**
 * Whether a legal entity ROW is currently in force — same "status is a
 * cache, timestamp is the real gate" convention
 * `isBusinessScopeAssignmentCurrentlyActive` documents.
 */
export function isLegalEntityCurrentlyActive(
  entity: {
    status: LegalEntityStatus;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  },
  now: Date
): boolean {
  if (entity.status !== "active") {
    return false;
  }
  if (now < entity.effectiveFrom) {
    return false;
  }
  if (entity.effectiveTo !== null && now >= entity.effectiveTo) {
    return false;
  }
  return true;
}
