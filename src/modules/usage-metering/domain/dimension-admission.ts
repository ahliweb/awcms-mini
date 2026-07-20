/**
 * Dimension admission (Issue #875, epic #868, ADR-0022). PURE — no I/O.
 *
 * A usage event carries an exact numeric `quantity` plus a SMALL, bounded map of
 * ADMITTED dimensions — NEVER a raw request body, document, secret, or arbitrary
 * JSON (issue #875 out-of-scope: "storing raw request bodies, documents, PII,
 * secrets, or arbitrary JSON dimensions"). The #874 meter descriptor is
 * numeric-only by design and does not enumerate per-meter dimension keys, so
 * admission is STRUCTURAL and fail-closed: only a bounded number of short scalar
 * keys mapping to a finite number or a short safe string are admitted; anything
 * else (nested object/array, boolean, null value, over-long, too many keys,
 * unsafe key/value) is REJECTED (never silently dropped). A meter's
 * `privacyClassification` governs whether a pseudonymous distinct-count key may
 * be recorded at all — the caller must never put directly-identifying PII in a
 * dimension value.
 */
export const MAX_DIMENSION_KEYS = 8;
export const MAX_DIMENSION_KEY_LENGTH = 40;
export const MAX_DIMENSION_VALUE_LENGTH = 64;
/** Backstop matching the sql/087 `dimensions_size_check` (defence in depth). */
export const MAX_DIMENSIONS_SERIALIZED_BYTES = 2000;

const KEY_FORMAT = /^[a-z][a-z0-9_]*$/;
/** A conservative categorical-label value: no control chars, no separators that could smuggle structure. */
const VALUE_STRING_FORMAT = /^[A-Za-z0-9][A-Za-z0-9 _.:@/+-]*$/;

export type AdmittedDimensions = Record<string, string | number>;

export type DimensionAdmissionError = { field: string; message: string };

export type DimensionAdmissionResult =
  | { ok: true; dimensions: AdmittedDimensions }
  | { ok: false; errors: DimensionAdmissionError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Admit an untrusted `dimensions` value. Absent/`undefined`/`null` -> the empty
 * admitted map (a meter without dimensions is valid). A PRESENT value must be a
 * plain object; anything else fails closed (never coerced to `{}`).
 */
export function admitDimensions(raw: unknown): DimensionAdmissionResult {
  if (raw === undefined || raw === null) {
    return { ok: true, dimensions: {} };
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [
        { field: "dimensions", message: "dimensions must be a plain object." }
      ]
    };
  }

  const errors: DimensionAdmissionError[] = [];
  const keys = Object.keys(raw);
  if (keys.length > MAX_DIMENSION_KEYS) {
    errors.push({
      field: "dimensions",
      message: `at most ${MAX_DIMENSION_KEYS} dimension keys are admitted (got ${keys.length}).`
    });
  }

  const dimensions: AdmittedDimensions = {};
  for (const key of keys) {
    if (!KEY_FORMAT.test(key) || key.length > MAX_DIMENSION_KEY_LENGTH) {
      errors.push({
        field: `dimensions.${key}`,
        message: `dimension key must match ${KEY_FORMAT} and be <= ${MAX_DIMENSION_KEY_LENGTH} chars.`
      });
      continue;
    }
    const value = raw[key];
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        errors.push({
          field: `dimensions.${key}`,
          message: "numeric dimension value must be finite."
        });
        continue;
      }
      dimensions[key] = value;
    } else if (typeof value === "string") {
      if (value.length === 0 || value.length > MAX_DIMENSION_VALUE_LENGTH) {
        errors.push({
          field: `dimensions.${key}`,
          message: `string dimension value must be 1..${MAX_DIMENSION_VALUE_LENGTH} chars.`
        });
        continue;
      }
      if (!VALUE_STRING_FORMAT.test(value)) {
        errors.push({
          field: `dimensions.${key}`,
          message:
            "string dimension value must be a safe categorical label (no control characters / structural separators)."
        });
        continue;
      }
      dimensions[key] = value;
    } else {
      errors.push({
        field: `dimensions.${key}`,
        message:
          "dimension value must be a finite number or a short safe string (no nested objects/arrays/booleans/null — dimensions are not a payload)."
      });
    }
  }

  if (errors.length === 0) {
    const serialized = JSON.stringify(dimensions);
    if (
      Buffer.byteLength(serialized, "utf8") > MAX_DIMENSIONS_SERIALIZED_BYTES
    ) {
      errors.push({
        field: "dimensions",
        message: `admitted dimensions exceed ${MAX_DIMENSIONS_SERIALIZED_BYTES} bytes serialized.`
      });
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, dimensions };
}
