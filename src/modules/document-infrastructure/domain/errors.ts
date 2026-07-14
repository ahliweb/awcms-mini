/**
 * Shared pure validation-error shape for every `domain/*.ts` file in this
 * module (Issue #751) — same `{field, message}` convention
 * `organization-structure/domain/legal-entity.ts` and every other domain
 * validator in this codebase already uses, factored into one file here
 * since this module has more domain files than most and would otherwise
 * redeclare the identical two-field type six times.
 */
export type DocumentValidationError = {
  field: string;
  message: string;
};

export const CONFIDENTIALITY_LEVELS = [
  "public",
  "internal",
  "confidential",
  "restricted"
] as const;

export type ConfidentialityLevel = (typeof CONFIDENTIALITY_LEVELS)[number];

export function isConfidentialityLevel(
  value: unknown
): value is ConfidentialityLevel {
  return (
    typeof value === "string" &&
    (CONFIDENTIALITY_LEVELS as readonly string[]).includes(value)
  );
}

/** `module_key`/`document_type`/`scope_type`/`sequence_key`-shaped identifiers — matches the DB `CHECK` constraints in `sql/066`. */
const SNAKE_CASE_PATTERN_MAX_LENGTH = 64;

export function isSnakeCaseIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > SNAKE_CASE_PATTERN_MAX_LENGTH) {
    return false;
  }
  const first = value.charCodeAt(0);
  const isLowerAlphaFirst = first >= 97 && first <= 122;
  if (!isLowerAlphaFirst) {
    return false;
  }
  for (let i = 1; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isLowerAlpha = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    const isUnderscore = code === 95;
    if (!isLowerAlpha && !isDigit && !isUnderscore) {
      return false;
    }
  }
  return true;
}
