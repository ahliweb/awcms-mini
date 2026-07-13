import type { ValidationError, ValidationResult } from "./party-validation";

/**
 * Generic party-to-party relationship type validation (Issue #748). This
 * base deliberately does NOT hardcode business-domain roles (customer,
 * supplier, employee, donor, merchant, student, patient, ...) anywhere in
 * code or schema — `relationship_type` is free text supplied by the
 * caller (a derived application or tenant defines its own vocabulary),
 * normalized to `snake_case` and shape-checked only (matches the SQL
 * `CHECK` in migration 059: `^[a-z][a-z0-9_]{1,63}$`).
 *
 * An "authorized representative" relationship is just an ordinary
 * relationship row with `isAuthorizedRepresentative: true` and an
 * optional free-text `representationScope` describing the authority
 * granted (e.g. "sign contracts up to IDR 50,000,000") — representation
 * is a structural/legal concept common across every business domain, not
 * itself a hardcoded domain role.
 */
const RELATIONSHIP_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Denylist of a few obviously domain-specific role names this base must
 * never hardcode meaning around — rejected here as a defensive guard
 * against copy-pasting a business rule into base code, NOT because tenant
 * data containing these words is somehow unsafe (a derived application is
 * free to define richer vocabulary in ITS OWN layer on top of this base).
 */
const RESERVED_DOMAIN_ROLE_WORDS = new Set([
  "customer",
  "supplier",
  "vendor",
  "employee",
  "donor",
  "merchant",
  "student",
  "patient"
]);

export function normalizeRelationshipType(rawValue: string): string {
  return rawValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export type RelationshipTypeValidation =
  { valid: true; value: string } | { valid: false; error: string };

export function validateRelationshipType(
  rawValue: unknown
): RelationshipTypeValidation {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return { valid: false, error: "relationshipType is required." };
  }

  const normalized = normalizeRelationshipType(rawValue);

  if (!RELATIONSHIP_TYPE_PATTERN.test(normalized)) {
    return {
      valid: false,
      error:
        "relationshipType must be 2-64 lowercase letters/digits/underscores, starting with a letter."
    };
  }

  if (RESERVED_DOMAIN_ROLE_WORDS.has(normalized)) {
    return {
      valid: false,
      error:
        "relationshipType must not encode a hardcoded business-domain role (customer/supplier/employee/donor/merchant/student/patient); this base only models generic structural relationships. A derived application may layer domain-specific semantics on top."
    };
  }

  return { valid: true, value: normalized };
}

export type CreateRelationshipInput = {
  toProfileId: string;
  relationshipType: string;
  isAuthorizedRepresentative: boolean;
  representationScope: string | null;
  validFrom: Date;
  validUntil: Date | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_SCOPE_LENGTH = 500;

export function validateCreateRelationshipInput(
  body: unknown,
  fromProfileId: string
): ValidationResult<CreateRelationshipInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (
    typeof record.toProfileId !== "string" ||
    !UUID_PATTERN.test(record.toProfileId)
  ) {
    errors.push({
      field: "toProfileId",
      message: "toProfileId must be a valid profile id."
    });
  } else if (record.toProfileId === fromProfileId) {
    errors.push({
      field: "toProfileId",
      message: "A profile cannot have a relationship with itself."
    });
  }

  const typeValidation = validateRelationshipType(record.relationshipType);

  if (!typeValidation.valid) {
    errors.push({ field: "relationshipType", message: typeValidation.error });
  }

  const isAuthorizedRepresentative =
    typeof record.isAuthorizedRepresentative === "boolean"
      ? record.isAuthorizedRepresentative
      : false;

  let representationScope: string | null = null;

  if (
    record.representationScope !== undefined &&
    record.representationScope !== null
  ) {
    if (
      typeof record.representationScope !== "string" ||
      record.representationScope.trim().length > MAX_SCOPE_LENGTH
    ) {
      errors.push({
        field: "representationScope",
        message: `representationScope must be a string of at most ${MAX_SCOPE_LENGTH} characters.`
      });
    } else {
      representationScope = record.representationScope.trim() || null;
    }
  }

  let validFrom: Date | null = null;
  let validUntil: Date | null = null;

  if (record.validFrom !== undefined && record.validFrom !== null) {
    if (typeof record.validFrom !== "string") {
      errors.push({
        field: "validFrom",
        message: "validFrom must be an ISO date string."
      });
    } else {
      const parsed = new Date(record.validFrom);

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

  if (record.validUntil !== undefined && record.validUntil !== null) {
    if (typeof record.validUntil !== "string") {
      errors.push({
        field: "validUntil",
        message: "validUntil must be an ISO date string."
      });
    } else {
      const parsed = new Date(record.validUntil);

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

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      toProfileId: record.toProfileId as string,
      relationshipType: (typeValidation as { valid: true; value: string })
        .value,
      isAuthorizedRepresentative,
      representationScope,
      validFrom: validFrom ?? new Date(),
      validUntil
    }
  };
}
