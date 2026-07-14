/**
 * Reference value-set domain rules (Issue #750, epic #738
 * platform-evolution Wave 3, ADR-0021). Pure functions only — no I/O, no
 * database — same "structural validation here, ABAC/persistence
 * elsewhere" split every other module's domain layer in this repo
 * documents.
 *
 * A value set is a stable, named catalog (e.g. "currency"). `scope`
 * distinguishes `module_contributed` (only ever written by
 * `application/contribution-sync.ts`, never by this module's own CRUD
 * API) from `platform_curated` (created directly via the API). `key`,
 * `scope`, and `overridePolicy` are IMMUTABLE once created — changing
 * `overridePolicy` after tenants have already built overrides under a
 * different policy would retroactively change what those existing rows
 * mean, so this module's update path never touches them (only
 * `name`/`description` are updatable).
 */

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_KEY_LENGTH = 100;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_VALIDATION_SCHEMA_JSON_LENGTH = 8000;

export type ReferenceValueSetScope = "module_contributed" | "platform_curated";

export type ReferenceValueSetOverridePolicy =
  "none" | "tenant_extend" | "tenant_override" | "tenant_extend_and_override";

export type ReferenceValueSetStatus = "active" | "deprecated";

export const VALID_OVERRIDE_POLICIES: readonly ReferenceValueSetOverridePolicy[] =
  ["none", "tenant_extend", "tenant_override", "tenant_extend_and_override"];

export type ReferenceValueSetValidationError = {
  field: string;
  message: string;
};

export type CreateReferenceValueSetInput = {
  key: string;
  name: string;
  description: string | null;
  overridePolicy: ReferenceValueSetOverridePolicy;
  validationSchema: Record<string, unknown> | null;
};

export function validateCreateReferenceValueSetInput(
  input: CreateReferenceValueSetInput
): ReferenceValueSetValidationError[] {
  const errors: ReferenceValueSetValidationError[] = [];

  if (!input.key || !KEY_PATTERN.test(input.key)) {
    errors.push({
      field: "key",
      message:
        "key must be non-empty, lowercase snake_case, starting with a letter."
    });
  } else if (input.key.length > MAX_KEY_LENGTH) {
    errors.push({
      field: "key",
      message: `key must be at most ${MAX_KEY_LENGTH} characters.`
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

  if (!VALID_OVERRIDE_POLICIES.includes(input.overridePolicy)) {
    errors.push({
      field: "overridePolicy",
      message: `overridePolicy must be one of ${VALID_OVERRIDE_POLICIES.join(", ")}.`
    });
  }

  if (input.validationSchema !== null) {
    const size = JSON.stringify(input.validationSchema).length;
    if (size > MAX_VALIDATION_SCHEMA_JSON_LENGTH) {
      errors.push({
        field: "validationSchema",
        message: `validationSchema must serialize to at most ${MAX_VALIDATION_SCHEMA_JSON_LENGTH} characters.`
      });
    }
  }

  return errors;
}

export type UpdateReferenceValueSetInput = {
  name: string;
  description: string | null;
};

export function validateUpdateReferenceValueSetInput(
  input: UpdateReferenceValueSetInput
): ReferenceValueSetValidationError[] {
  const errors: ReferenceValueSetValidationError[] = [];

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

export type DeprecateReferenceValueSetInput = {
  reason: string;
};

export function validateDeprecateReferenceValueSetInput(
  input: DeprecateReferenceValueSetInput
): ReferenceValueSetValidationError[] {
  const errors: ReferenceValueSetValidationError[] = [];

  if (!input.reason || input.reason.trim().length === 0) {
    errors.push({ field: "reason", message: "reason is required." });
  }

  return errors;
}
