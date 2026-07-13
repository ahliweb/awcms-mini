import type { ValidationError, ValidationResult } from "./party-validation";
import type { IdentifierType } from "./identifier";

const IDENTIFIER_TYPES: readonly IdentifierType[] = [
  "email",
  "phone",
  "whatsapp",
  "national_id",
  "tax_id",
  "external_code",
  "other"
];

export const IDENTIFIER_PROVENANCES = [
  "self_reported",
  "verified_by_staff",
  "imported",
  "system_generated"
] as const;
export type IdentifierProvenance = (typeof IDENTIFIER_PROVENANCES)[number];

const MAX_RAW_VALUE_LENGTH = 320;

export type CreateIdentifierInput = {
  identifierType: IdentifierType;
  rawValue: string;
  isPrimary: boolean;
  provenance: IdentifierProvenance;
  validFrom: Date;
  validUntil: Date | null;
};

/**
 * Body validation for `POST /profiles/{id}/identifiers`. `validFrom`/
 * `validUntil` are effective dates (Issue #748) — a caller may add an
 * identifier that only becomes valid in the future, or backdate one
 * imported from another system. `hashIdentifier`/`normalizeIdentifier`/
 * `maskIdentifier` (`domain/identifier.ts`) remain the single source of
 * truth for the dedup key and masked display value — this file only
 * validates the request shape and the new provenance/validity fields.
 */
export function validateCreateIdentifierInput(
  body: unknown
): ValidationResult<CreateIdentifierInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (
    typeof record.identifierType !== "string" ||
    !IDENTIFIER_TYPES.includes(record.identifierType as IdentifierType)
  ) {
    errors.push({
      field: "identifierType",
      message: `identifierType must be one of: ${IDENTIFIER_TYPES.join(", ")}.`
    });
  }

  if (
    typeof record.value !== "string" ||
    record.value.trim().length === 0 ||
    record.value.trim().length > MAX_RAW_VALUE_LENGTH
  ) {
    errors.push({
      field: "value",
      message: `value is required and must be at most ${MAX_RAW_VALUE_LENGTH} characters.`
    });
  }

  let isPrimary = false;

  if (record.isPrimary !== undefined) {
    if (typeof record.isPrimary !== "boolean") {
      errors.push({
        field: "isPrimary",
        message: "isPrimary must be a boolean."
      });
    } else {
      isPrimary = record.isPrimary;
    }
  }

  let provenance: IdentifierProvenance = "self_reported";

  if (record.provenance !== undefined) {
    if (
      typeof record.provenance !== "string" ||
      !IDENTIFIER_PROVENANCES.includes(
        record.provenance as IdentifierProvenance
      )
    ) {
      errors.push({
        field: "provenance",
        message: `provenance must be one of: ${IDENTIFIER_PROVENANCES.join(", ")}.`
      });
    } else {
      provenance = record.provenance as IdentifierProvenance;
    }
  }

  const {
    validFrom,
    validUntil,
    errors: windowErrors
  } = validateEffectiveWindow(record.validFrom, record.validUntil);
  errors.push(...windowErrors);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      identifierType: record.identifierType as IdentifierType,
      rawValue: record.value as string,
      isPrimary,
      provenance,
      validFrom: validFrom ?? new Date(),
      validUntil
    }
  };
}

export type UpdateIdentifierInput = {
  isPrimary?: boolean;
  verificationStatus?: "unverified" | "pending" | "verified";
  validUntil?: Date | null;
};

export function validateUpdateIdentifierInput(
  body: unknown
): ValidationResult<UpdateIdentifierInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value: UpdateIdentifierInput = {};

  if (record.isPrimary !== undefined) {
    if (typeof record.isPrimary !== "boolean") {
      errors.push({
        field: "isPrimary",
        message: "isPrimary must be a boolean."
      });
    } else {
      value.isPrimary = record.isPrimary;
    }
  }

  if (record.verificationStatus !== undefined) {
    const allowed = ["unverified", "pending", "verified"];

    if (
      typeof record.verificationStatus !== "string" ||
      !allowed.includes(record.verificationStatus)
    ) {
      errors.push({
        field: "verificationStatus",
        message: `verificationStatus must be one of: ${allowed.join(", ")}.`
      });
    } else {
      value.verificationStatus = record.verificationStatus as
        "unverified" | "pending" | "verified";
    }
  }

  if (record.validUntil !== undefined) {
    if (record.validUntil === null) {
      value.validUntil = null;
    } else if (typeof record.validUntil === "string") {
      const parsed = new Date(record.validUntil);

      if (Number.isNaN(parsed.getTime())) {
        errors.push({
          field: "validUntil",
          message: "validUntil must be a valid ISO date string or null."
        });
      } else {
        value.validUntil = parsed;
      }
    } else {
      errors.push({
        field: "validUntil",
        message: "validUntil must be a valid ISO date string or null."
      });
    }
  }

  if (Object.keys(value).length === 0) {
    errors.push({
      field: "body",
      message: "At least one updatable field must be provided."
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value };
}

function validateEffectiveWindow(
  rawValidFrom: unknown,
  rawValidUntil: unknown
): {
  validFrom: Date | null;
  validUntil: Date | null;
  errors: ValidationError[];
} {
  const errors: ValidationError[] = [];
  let validFrom: Date | null = null;
  let validUntil: Date | null = null;

  if (rawValidFrom !== undefined && rawValidFrom !== null) {
    if (typeof rawValidFrom !== "string") {
      errors.push({
        field: "validFrom",
        message: "validFrom must be an ISO date string."
      });
    } else {
      const parsed = new Date(rawValidFrom);

      if (Number.isNaN(parsed.getTime())) {
        errors.push({
          field: "validFrom",
          message: "validFrom must be a valid ISO date string."
        });
      } else {
        validFrom = parsed;
      }
    }
  }

  if (rawValidUntil !== undefined && rawValidUntil !== null) {
    if (typeof rawValidUntil !== "string") {
      errors.push({
        field: "validUntil",
        message: "validUntil must be an ISO date string."
      });
    } else {
      const parsed = new Date(rawValidUntil);

      if (Number.isNaN(parsed.getTime())) {
        errors.push({
          field: "validUntil",
          message: "validUntil must be a valid ISO date string."
        });
      } else {
        validUntil = parsed;
      }
    }
  }

  if (validFrom && validUntil && validUntil.getTime() <= validFrom.getTime()) {
    errors.push({
      field: "validUntil",
      message: "validUntil must be after validFrom."
    });
  }

  return { validFrom, validUntil, errors };
}
