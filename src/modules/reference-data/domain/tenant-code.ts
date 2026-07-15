/**
 * Tenant reference-code override/extension domain rules (Issue #750, epic
 * #738 platform-evolution Wave 3, ADR-0021 §8). Pure functions only — no
 * I/O, no database.
 *
 * A tenant code row is either an OVERRIDE (`baseCodeId` set — restates an
 * existing baseline code's attributes for this tenant only) or an
 * EXTENSION (`baseCodeId` null — a wholly new tenant-defined code). Which
 * kinds a tenant may create is governed by the value set's
 * `overridePolicy` (`domain/value-set.ts`), enforced here so the decision
 * is server-side and never trusted from request input (issue #750
 * security requirement: "Module owner and override policy are enforced
 * server-side, not trusted from request input").
 */
import {
  validateReferenceMetadata,
  type ReferenceCodeLabelInput,
  type ReferenceCodeValidationError
} from "./code";
import type { ReferenceValueSetOverridePolicy } from "./value-set";

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const MAX_LABEL_LENGTH = 300;

export type TenantCodeKind = "override" | "extension";

/** Whether `overridePolicy` allows a tenant to create a row of `kind` at all — the ONLY place this decision is made (application layer calls this, never re-derives it). */
export function isTenantCodeKindAllowed(
  overridePolicy: ReferenceValueSetOverridePolicy,
  kind: TenantCodeKind
): boolean {
  if (overridePolicy === "none") {
    return false;
  }
  if (overridePolicy === "tenant_extend") {
    return kind === "extension";
  }
  if (overridePolicy === "tenant_override") {
    return kind === "override";
  }
  return true; // "tenant_extend_and_override"
}

function validateLabels(
  labels: ReferenceCodeLabelInput[]
): ReferenceCodeValidationError[] {
  const errors: ReferenceCodeValidationError[] = [];

  if (!Array.isArray(labels) || labels.length === 0) {
    errors.push({
      field: "labels",
      message: "at least one label is required."
    });
    return errors;
  }

  const locales = new Set<string>();
  for (const entry of labels) {
    if (!LOCALE_PATTERN.test(entry.locale)) {
      errors.push({
        field: "labels",
        message: `locale ${JSON.stringify(entry.locale)} is not a valid locale.`
      });
    }
    if (locales.has(entry.locale)) {
      errors.push({
        field: "labels",
        message: `duplicate locale ${JSON.stringify(entry.locale)}.`
      });
    }
    locales.add(entry.locale);

    if (!entry.label || entry.label.trim().length === 0) {
      errors.push({
        field: "labels",
        message: `label for locale ${JSON.stringify(entry.locale)} is required.`
      });
    } else if (entry.label.length > MAX_LABEL_LENGTH) {
      errors.push({
        field: "labels",
        message: `label for locale ${JSON.stringify(entry.locale)} must be at most ${MAX_LABEL_LENGTH} characters.`
      });
    }
  }

  if (!locales.has("en")) {
    errors.push({
      field: "labels",
      message:
        'an "en" label is required (doc convention: default en, min en+id).'
    });
  }

  return errors;
}

export type CreateTenantReferenceCodeInput = {
  baseCodeId: string | null;
  code: string;
  labels: ReferenceCodeLabelInput[];
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
};

export function validateCreateTenantReferenceCodeInput(
  input: CreateTenantReferenceCodeInput
): ReferenceCodeValidationError[] {
  const errors: ReferenceCodeValidationError[] = [];

  if (!input.code || !CODE_PATTERN.test(input.code)) {
    errors.push({
      field: "code",
      message:
        "code must be 1-64 characters, alphanumeric plus '_.-', starting with an alphanumeric."
    });
  }

  errors.push(...validateLabels(input.labels));
  errors.push(...validateReferenceMetadata(input.metadata));

  if (Number.isNaN(input.validFrom.getTime())) {
    errors.push({
      field: "validFrom",
      message: "validFrom must be a valid date."
    });
  }
  if (input.validTo !== null) {
    if (Number.isNaN(input.validTo.getTime())) {
      errors.push({
        field: "validTo",
        message: "validTo must be a valid date when provided."
      });
    } else if (input.validTo <= input.validFrom) {
      errors.push({
        field: "validTo",
        message: "validTo must be after validFrom."
      });
    }
  }

  return errors;
}

export type UpdateTenantReferenceCodeInput = {
  labels: ReferenceCodeLabelInput[];
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
};

export function validateUpdateTenantReferenceCodeInput(
  input: UpdateTenantReferenceCodeInput
): ReferenceCodeValidationError[] {
  const errors: ReferenceCodeValidationError[] = [];

  errors.push(...validateLabels(input.labels));
  errors.push(...validateReferenceMetadata(input.metadata));

  if (Number.isNaN(input.validFrom.getTime())) {
    errors.push({
      field: "validFrom",
      message: "validFrom must be a valid date."
    });
  }
  if (input.validTo !== null) {
    if (Number.isNaN(input.validTo.getTime())) {
      errors.push({
        field: "validTo",
        message: "validTo must be a valid date when provided."
      });
    } else if (input.validTo <= input.validFrom) {
      errors.push({
        field: "validTo",
        message: "validTo must be after validFrom."
      });
    }
  }

  return errors;
}

export type DeprecateTenantReferenceCodeInput = {
  reason: string;
};

export function validateDeprecateTenantReferenceCodeInput(
  input: DeprecateTenantReferenceCodeInput
): ReferenceCodeValidationError[] {
  const errors: ReferenceCodeValidationError[] = [];

  if (!input.reason || input.reason.trim().length === 0) {
    errors.push({ field: "reason", message: "reason is required." });
  }

  return errors;
}
