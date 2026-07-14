/**
 * Document classification domain rules (Issue #751). Pure functions only.
 * A classification is a tenant-scoped catalog entry
 * (code/name/confidentiality level/retention reference) — `retention_
 * reference` is a free-text pointer a tenant maps manually to a
 * `data_lifecycle` policy key (ADR-0017 §4, deliberately not an FK in
 * this PR).
 */
import type { DocumentValidationError } from "./errors";
import {
  CONFIDENTIALITY_LEVELS,
  isConfidentialityLevel,
  isSnakeCaseIdentifier
} from "./errors";

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_RETENTION_REFERENCE_LENGTH = 200;

export type CreateClassificationInput = {
  code: string;
  name: string;
  description: string | null;
  confidentialityLevel: string;
  retentionReference: string | null;
};

export type UpdateClassificationInput = {
  name: string;
  description: string | null;
  confidentialityLevel: string;
  retentionReference: string | null;
};

function validateCommon(input: {
  name: string;
  description: string | null;
  confidentialityLevel: string;
  retentionReference: string | null;
}): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

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

  if (!isConfidentialityLevel(input.confidentialityLevel)) {
    errors.push({
      field: "confidentialityLevel",
      message: `confidentialityLevel must be one of: ${CONFIDENTIALITY_LEVELS.join(", ")}.`
    });
  }

  if (
    input.retentionReference !== null &&
    input.retentionReference.length > MAX_RETENTION_REFERENCE_LENGTH
  ) {
    errors.push({
      field: "retentionReference",
      message: `retentionReference must be at most ${MAX_RETENTION_REFERENCE_LENGTH} characters.`
    });
  }

  return errors;
}

export function validateCreateClassificationInput(
  input: CreateClassificationInput
): DocumentValidationError[] {
  const errors = validateCommon(input);

  if (!isSnakeCaseIdentifier(input.code)) {
    errors.push({
      field: "code",
      message: "code must be a lowercase snake_case identifier."
    });
  }

  return errors;
}

export function validateUpdateClassificationInput(
  input: UpdateClassificationInput
): DocumentValidationError[] {
  return validateCommon(input);
}

export type DeactivateClassificationInput = {
  deleteReason: string;
};

export function validateDeactivateClassificationInput(
  input: DeactivateClassificationInput
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

  if (!input.deleteReason || input.deleteReason.trim().length === 0) {
    errors.push({
      field: "deleteReason",
      message: "deleteReason is required."
    });
  }

  return errors;
}
