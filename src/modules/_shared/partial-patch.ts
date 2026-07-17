/**
 * Primitives for parsing a JSON `PATCH` body with normative partial semantics
 * (Issue #837 / #822): a key **absent** from the body is left untouched (the
 * reader returns `undefined` — a sentinel the merge step reads as "keep the
 * stored value"); a key present as **`null`** clears a nullable field; any
 * other value **replaces** after a type check. A field that has no meaningful
 * empty state (`NOT NULL`, or a validator that demands a non-empty value)
 * rejects an explicit `null` with an error rather than silently defaulting it.
 *
 * A JSON body can never carry `undefined`, so `undefined` unambiguously means
 * "absent" here — distinct from an explicit `null`. Kept in `_shared` because
 * the exact shape recurs across `reference-data` (`code-patch.ts`) and every
 * `organization_structure` resource; this is the promotion the #837 DoD asks
 * for ("angkat ke `_shared` bila polanya terbukti lintas modul").
 *
 * These readers only distinguish absent/null/typed-value and coerce the raw
 * type — VALUE-level validation (non-empty name, `effectiveTo` after
 * `effectiveFrom`, country-code pattern, ...) stays in each module's existing
 * `validateUpdate*` domain validator, run once on the MERGED result, so there
 * is a single source of truth for what a valid record looks like.
 */
export type PatchFieldError = { field: string; message: string };

/** True when `field` is physically present in the body — even as `null`. */
export function patchFieldPresent(
  body: Record<string, unknown>,
  field: string
): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

/**
 * A required string field (the record's column is `NOT NULL` / the validator
 * demands a non-empty value): present+string replaces, absent keeps
 * (`undefined`), present+`null`/other is an error — `null` has no meaningful
 * empty state here, so it is rejected rather than silently defaulted.
 */
export function readRequiredStringPatch(
  body: Record<string, unknown>,
  field: string,
  errors: PatchFieldError[]
): string | undefined {
  if (!patchFieldPresent(body, field)) return undefined;
  const value = body[field];
  if (typeof value === "string") return value;
  errors.push({
    field,
    message: `${field} must be a string; null is not allowed. Omit the field to keep the stored value.`
  });
  return undefined;
}

/**
 * A nullable string field: present+string replaces, present+`null` clears,
 * absent keeps (`undefined`), any other type is an error.
 */
export function readNullableStringPatch(
  body: Record<string, unknown>,
  field: string,
  errors: PatchFieldError[]
): string | null | undefined {
  if (!patchFieldPresent(body, field)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value === "string") return value;
  errors.push({
    field,
    message: `${field} must be a string, or null to clear it. Omit the field to keep the stored value.`
  });
  return undefined;
}

/**
 * A required date field (`NOT NULL` column): present+string parses to a `Date`
 * (calendar-validity is left to the domain validator, which reports NaN),
 * absent keeps (`undefined`), present+`null`/other is an error.
 */
export function readRequiredDatePatch(
  body: Record<string, unknown>,
  field: string,
  errors: PatchFieldError[]
): Date | undefined {
  if (!patchFieldPresent(body, field)) return undefined;
  const value = body[field];
  if (typeof value === "string") return new Date(value);
  errors.push({
    field,
    message: `${field} must be an ISO-8601 date string; null is not allowed. Omit the field to keep the stored value.`
  });
  return undefined;
}

/**
 * A nullable date field: present+string parses to a `Date`, present+`null`
 * clears, absent keeps (`undefined`), any other type is an error.
 */
export function readNullableDatePatch(
  body: Record<string, unknown>,
  field: string,
  errors: PatchFieldError[]
): Date | null | undefined {
  if (!patchFieldPresent(body, field)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value === "string") return new Date(value);
  errors.push({
    field,
    message: `${field} must be an ISO-8601 date string, or null to clear it. Omit the field to keep the stored value.`
  });
  return undefined;
}

/**
 * A nullable number field: present+finite-number replaces, present+`null`
 * clears, absent keeps (`undefined`), any other value is an error.
 */
export function readNullableNumberPatch(
  body: Record<string, unknown>,
  field: string,
  errors: PatchFieldError[]
): number | null | undefined {
  if (!patchFieldPresent(body, field)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  errors.push({
    field,
    message: `${field} must be a finite number, or null to clear it. Omit the field to keep the stored value.`
  });
  return undefined;
}
