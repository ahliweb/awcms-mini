/**
 * Reference code domain rules (Issue #750, epic #738 platform-evolution
 * Wave 3, ADR-0021). Pure functions only — no I/O, no database.
 *
 * A code is one entry within a value set (e.g. "IDR" in "currency").
 * `metadata` is bounded and validated to never carry an executable
 * expression/SQL/template/secret (issue #750 security requirement:
 * "Reference data contains no executable expressions, SQL, templates,
 * secrets, or unbounded arbitrary metadata") — enforced here by (a) a
 * strict size bound (also a DB CHECK, migration 069, defense in depth),
 * (b) rejecting metadata whose values are anything other than plain
 * string/number/boolean/null (no nested functions, no strings that look
 * like template/expression syntax), and (c) reusing the codebase's
 * existing, tested credential-shape detector — `findSecretShapedValues`
 * (`_shared/redaction.ts`, already relied on by
 * `module-management/domain/module-settings.ts`) — rather than
 * reinventing secret detection here (security-review Critical finding:
 * an earlier version of this file only had a SQL/template/XSS regex that
 * was empirically never tested against, and did not catch, an AWS access
 * key, a JWT, a PEM private key block, a `Bearer` token, or a connection
 * string with an embedded credential).
 */
import { findSecretShapedValues } from "../../_shared/redaction";

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const MAX_LABEL_LENGTH = 300;
const MAX_METADATA_JSON_LENGTH = 4000;
/**
 * Best-effort deterrent, NOT a formal guarantee (security-review finding
 * — a string-matching heuristic can never exhaustively enumerate every
 * "looks like an executable expression/SQL/template" shape; a
 * sufficiently creative payload can always be constructed to evade it).
 * The REAL safety property this module relies on is structural: `metadata`
 * values are restricted to string/number/boolean/null (checked below,
 * before this pattern even runs), bounded in size, and — critically —
 * NEVER interpreted/executed/templated/concatenated into a query by any
 * code path in this module (verified: no `eval`/`new Function`, no
 * template-engine call, no raw-SQL string interpolation of a metadata
 * value anywhere in `reference-data/`). This pattern exists as a defense-
 * in-depth tripwire against obviously malicious content landing in a
 * field a FUTURE consumer (e.g. a derived application's own UI) might
 * render or interpret less carefully — broadened to cover more template/
 * script/SQL shapes than a single early example of each, `[\s\S]` instead
 * of `.` so a match is not defeated by a payload containing a newline.
 */
const SUSPICIOUS_METADATA_VALUE_PATTERN =
  /\$\{|\{\{[\s\S]*?\}\}|<%[\s\S]*?%>|#\{|<script\b|<\/script|javascript:|data:text\/html|on(?:error|load|click)\s*=|\b(?:SELECT|INSERT|UPDATE|DELETE|UNION|ALTER|EXEC|DROP)\b[\s\S]*?\b(?:FROM|INTO|TABLE|SET|SELECT)\b|;\s*(?:DROP|DELETE|ALTER)\s+TABLE/i;

export type ReferenceCodeLabelInput = {
  locale: string;
  label: string;
  description: string | null;
};

export type ReferenceCodeValidationError = {
  field: string;
  message: string;
};

/** Exported so `domain/import-diff.ts` can apply the SAME label validation to import payload entries — the manual create/update path and the import path must never diverge on what content is accepted (security-review finding: the import path previously skipped this entirely). */
export function validateLabels(
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
        message: `locale ${JSON.stringify(entry.locale)} is not a valid locale (expected "en", "id", "en-US", ...).`
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

export function validateReferenceMetadata(
  metadata: Record<string, unknown>
): ReferenceCodeValidationError[] {
  const errors: ReferenceCodeValidationError[] = [];
  const serialized = JSON.stringify(metadata ?? {});

  if (serialized.length > MAX_METADATA_JSON_LENGTH) {
    errors.push({
      field: "metadata",
      message: `metadata must serialize to at most ${MAX_METADATA_JSON_LENGTH} characters.`
    });
  }

  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      errors.push({
        field: "metadata",
        message: `metadata.${key} must be a string, number, boolean, or null (no nested objects/arrays/functions).`
      });
      continue;
    }
    if (
      typeof value === "string" &&
      SUSPICIOUS_METADATA_VALUE_PATTERN.test(value)
    ) {
      errors.push({
        field: "metadata",
        message: `metadata.${key} looks like an executable expression/SQL/template, which is not allowed.`
      });
    }
  }

  // Credential-shape check, delegated to the shared detector (see file
  // header comment (c)) rather than a bespoke pattern here — flat object
  // is fine to pass directly since the loop above already rejects any
  // non-primitive value, so `findSecretShapedValues` never has to recurse
  // into anything but this metadata object's own top-level string values.
  for (const path of findSecretShapedValues(metadata ?? {})) {
    errors.push({
      field: `metadata.${path}`,
      message: `metadata.${path} looks like a credential (API key, JWT, private key, Bearer/Basic token, or connection string with an embedded credential), which is not allowed in reference data.`
    });
  }

  return errors;
}

export type CreateReferenceCodeInput = {
  code: string;
  labels: ReferenceCodeLabelInput[];
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
};

export function validateCreateReferenceCodeInput(
  input: CreateReferenceCodeInput
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

export type UpdateReferenceCodeInput = {
  labels: ReferenceCodeLabelInput[];
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
};

export function validateUpdateReferenceCodeInput(
  input: UpdateReferenceCodeInput
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

export type DeprecateReferenceCodeInput = {
  reason: string;
  supersededByCodeId: string | null;
};

export function validateDeprecateReferenceCodeInput(
  input: DeprecateReferenceCodeInput
): ReferenceCodeValidationError[] {
  const errors: ReferenceCodeValidationError[] = [];

  if (!input.reason || input.reason.trim().length === 0) {
    errors.push({ field: "reason", message: "reason is required." });
  }

  return errors;
}

/** Whether a code ROW is currently in force at `asOf` — same "status is a cache, timestamp is the real gate" convention `isLegalEntityCurrentlyActive` documents. */
export function isReferenceCodeCurrentlyActive(
  row: { deprecatedAt: Date | null; validFrom: Date; validTo: Date | null },
  asOf: Date
): boolean {
  if (row.deprecatedAt !== null && row.deprecatedAt <= asOf) {
    return false;
  }
  if (asOf < row.validFrom) {
    return false;
  }
  if (row.validTo !== null && asOf >= row.validTo) {
    return false;
  }
  return true;
}

export { CODE_PATTERN, LOCALE_PATTERN };
