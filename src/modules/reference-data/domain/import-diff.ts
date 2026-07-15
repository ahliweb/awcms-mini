/**
 * Validated-import diff computation (Issue #750, epic #738
 * platform-evolution Wave 3, ADR-0021 §8/§11). Pure function only — no
 * I/O, no database, no checksum/hashing (that stays in
 * `application/import-service.ts`, which already has `_shared/
 * idempotency.ts`'s `computeRequestHash` available).
 *
 * The core safety property this file exists to prove (issue #750: "A code
 * already referenced by business data is never silently deleted or
 * repurposed in place"; "Reject destructive replacement of codes already
 * referenced by data"): a payload entry marked `replace: true` for a code
 * the caller reports as `referenced: true` (has at least one tenant
 * override/extension pointing at it, `application/import-service.ts`
 * computes this from `awcms_mini_reference_tenant_codes.base_code_id`
 * before calling this function) is collected into `blockedReplacements`
 * and the WHOLE diff is `ok: false` — never partially applied. A code
 * missing from the new payload entirely is only ever DEPRECATED (soft),
 * never deleted — `toDeprecate` is a list of codes to soft-deprecate, not
 * a delete list.
 *
 * Security-review Critical finding: `validateImportPayloadShape` used to
 * check ONLY structural shape (non-empty, size bounds, duplicate `code`
 * strings) — it never validated `code` format, `labels`, or `metadata`
 * content, so the import path completely bypassed the same content-safety
 * rules (`domain/code.ts`'s `validateReferenceMetadata`/`validateLabels`)
 * the manual create/update path enforces. An import payload is now run
 * through the EXACT SAME validators, per entry, so the two paths can
 * never diverge on what content is accepted.
 */
import {
  CODE_PATTERN,
  validateLabels,
  validateReferenceMetadata,
  type ReferenceCodeLabelInput
} from "./code";

export type ImportDiffLabelInput = ReferenceCodeLabelInput;

export type ImportDiffPayloadCode = {
  code: string;
  labels: ImportDiffLabelInput[];
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: string;
  validTo: string | null;
  /** Explicit opt-in to REPLACE (not update) an existing code's identity — only meaningful when `code` already exists in `existingManagedCodes`. Absent/false means "ordinary upsert of mutable attributes", never destructive. */
  replace?: boolean;
};

export type ImportDiffExistingCode = {
  code: string;
  /** `true` when at least one tenant override/extension row references this code (`base_code_id`) — computed by the caller from the database, never guessed here. */
  referenced: boolean;
};

export type ImportDiffResult = {
  ok: boolean;
  toCreate: ImportDiffPayloadCode[];
  toUpdate: ImportDiffPayloadCode[];
  toDeprecate: string[];
  /** Non-empty only when `ok` is `false` — payload codes that requested `replace: true` against a currently-referenced existing code. */
  blockedReplacements: string[];
};

const MAX_PAYLOAD_CODES = 2000;

export type ImportPayloadValidationError = {
  field: string;
  message: string;
};

/**
 * Structural bounds AND per-entry content validation for an import
 * payload — issue #750: "Import is schema/size bounded", and (security-
 * review Critical finding) content must be validated by the SAME rules
 * the manual create/update path enforces (`code` format, `labels`
 * locale/en-required/length, `metadata` type/size/suspicious-pattern) —
 * never a lesser bar just because the entry arrived via a bulk import
 * rather than one-at-a-time through the CRUD API.
 */
export function validateImportPayloadShape(
  codes: ImportDiffPayloadCode[]
): ImportPayloadValidationError[] {
  const errors: ImportPayloadValidationError[] = [];

  if (!Array.isArray(codes) || codes.length === 0) {
    errors.push({
      field: "codes",
      message: "codes must be a non-empty array."
    });
    return errors;
  }

  if (codes.length > MAX_PAYLOAD_CODES) {
    errors.push({
      field: "codes",
      message: `codes must contain at most ${MAX_PAYLOAD_CODES} entries.`
    });
  }

  const seen = new Set<string>();
  for (const entry of codes) {
    if (!entry.code || typeof entry.code !== "string") {
      errors.push({ field: "codes", message: "every entry requires a code." });
      continue;
    }
    if (seen.has(entry.code)) {
      errors.push({
        field: "codes",
        message: `duplicate code ${JSON.stringify(entry.code)} within the same import payload.`
      });
    }
    seen.add(entry.code);

    if (!CODE_PATTERN.test(entry.code)) {
      errors.push({
        field: "codes",
        message: `code ${JSON.stringify(entry.code)} must be 1-64 characters, alphanumeric plus '_.-', starting with an alphanumeric.`
      });
    }

    for (const labelError of validateLabels(entry.labels)) {
      errors.push({
        field: `codes[${entry.code}].${labelError.field}`,
        message: labelError.message
      });
    }

    for (const metadataError of validateReferenceMetadata(
      entry.metadata ?? {}
    )) {
      errors.push({
        field: `codes[${entry.code}].${metadataError.field}`,
        message: metadataError.message
      });
    }
  }

  return errors;
}

export function computeImportDiff(
  existingManagedCodes: readonly ImportDiffExistingCode[],
  payloadCodes: readonly ImportDiffPayloadCode[]
): ImportDiffResult {
  const existingByCode = new Map(
    existingManagedCodes.map((row) => [row.code, row] as const)
  );
  const payloadCodeSet = new Set(payloadCodes.map((row) => row.code));

  const toCreate: ImportDiffPayloadCode[] = [];
  const toUpdate: ImportDiffPayloadCode[] = [];
  const blockedReplacements: string[] = [];

  for (const entry of payloadCodes) {
    const existing = existingByCode.get(entry.code);
    if (!existing) {
      toCreate.push(entry);
      continue;
    }
    if (entry.replace === true && existing.referenced) {
      blockedReplacements.push(entry.code);
      continue;
    }
    toUpdate.push(entry);
  }

  const toDeprecate = [...existingByCode.keys()].filter(
    (code) => !payloadCodeSet.has(code)
  );

  return {
    ok: blockedReplacements.length === 0,
    toCreate,
    toUpdate,
    toDeprecate,
    blockedReplacements
  };
}
