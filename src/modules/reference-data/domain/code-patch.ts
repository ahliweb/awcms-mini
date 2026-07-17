import type {
  ReferenceCodeLabelInput,
  ReferenceCodeValidationError
} from "./code";

/**
 * Mutable attributes shared by `awcms_mini_reference_codes` and
 * `awcms_mini_reference_tenant_codes`. This is the full-shape input the
 * application-layer `update*` functions expect.
 */
export type ReferenceCodeMutableFields = {
  labels: ReferenceCodeLabelInput[];
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
};

/**
 * A `PATCH` body parsed with true partial semantics: a key that is absent from
 * the request body is absent here too (`undefined`) and must be left untouched
 * by {@link mergeReferenceCodePatchInput}.
 */
export type ReferenceCodePatchInput = {
  labels?: ReferenceCodeLabelInput[];
  sortOrder?: number;
  metadata?: Record<string, unknown>;
  validFrom?: Date;
  validTo?: Date | null;
};

export type ParseReferenceCodePatchResult =
  | { ok: true; patch: ReferenceCodePatchInput }
  | { ok: false; errors: ReferenceCodeValidationError[] };

const DEFAULT_SORT_ORDER = 0;

/**
 * The complete set this parser understands. Kept beside the per-field blocks
 * below so adding a field without listing it here makes that field's own tests
 * fail immediately (it would be rejected as unknown) rather than silently
 * ignored — the failure mode this set exists to prevent.
 */
const KNOWN_PATCH_FIELDS: ReadonlySet<string> = new Set([
  "labels",
  "sortOrder",
  "metadata",
  "validFrom",
  "validTo"
]);

function hasField(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function parseLabels(value: unknown[]): ReferenceCodeLabelInput[] {
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === "object"
    )
    .map((entry) => ({
      locale: typeof entry.locale === "string" ? entry.locale : "",
      label: typeof entry.label === "string" ? entry.label : "",
      description:
        typeof entry.description === "string" ? entry.description : null
    }));
}

/**
 * Parse a reference-code `PATCH` body with normative `PATCH` semantics.
 *
 * Per field: **absent** = keep the stored value untouched, **`null`** =
 * clear/reset to the field's empty value (`sortOrder` -> `0`, `metadata` ->
 * `{}`, `validTo` -> `null`), any other value = replace. `validFrom` is
 * `NOT NULL` in the schema and `labels` always needs at least one entry, so an
 * explicit `null` for either is rejected rather than silently defaulted.
 */
export function parseReferenceCodePatchInput(
  body: Record<string, unknown>
): ParseReferenceCodePatchResult {
  const patch: ReferenceCodePatchInput = {};
  const errors: ReferenceCodeValidationError[] = [];

  // Both PATCH schemas are `additionalProperties: false`, so an unknown key is
  // a 400 by contract — but this parser reads known keys and ignores the rest,
  // which turned a client typo (`validUntil` for `validTo`) into an empty
  // patch. Combined with the empty-patch no-op branch the routes now take,
  // that typo would answer 200 and change nothing: the request LOOKS accepted
  // while doing nothing at all, which is worse than either rejecting it or
  // applying it. Rejecting unknown keys here keeps the parser honest to the
  // published contract. (Review finding, PR #839.)
  const unknownFields = Object.keys(body).filter(
    (key) => !KNOWN_PATCH_FIELDS.has(key)
  );
  for (const field of unknownFields) {
    errors.push({
      field,
      message: `Unknown field "${field}". Allowed fields: ${[...KNOWN_PATCH_FIELDS].join(", ")}. Omit a field to keep its stored value.`
    });
  }

  if (hasField(body, "labels")) {
    const value = body.labels;
    if (Array.isArray(value)) {
      patch.labels = parseLabels(value);
    } else {
      errors.push({
        field: "labels",
        message:
          "labels must be a non-empty array of label objects; null is not allowed because at least one label is always required. Omit the field to keep the stored labels."
      });
    }
  }

  if (hasField(body, "sortOrder")) {
    const value = body.sortOrder;
    if (value === null) {
      patch.sortOrder = DEFAULT_SORT_ORDER;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      patch.sortOrder = value;
    } else {
      errors.push({
        field: "sortOrder",
        message:
          "sortOrder must be a finite number, or null to reset to 0. Omit the field to keep the stored value."
      });
    }
  }

  if (hasField(body, "metadata")) {
    const value = body.metadata;
    if (value === null) {
      patch.metadata = {};
    } else if (typeof value === "object" && !Array.isArray(value)) {
      patch.metadata = value as Record<string, unknown>;
    } else {
      errors.push({
        field: "metadata",
        message:
          "metadata must be an object, or null to clear it. Omit the field to keep the stored value."
      });
    }
  }

  if (hasField(body, "validFrom")) {
    const value = body.validFrom;
    if (typeof value === "string") {
      patch.validFrom = new Date(value);
    } else {
      errors.push({
        field: "validFrom",
        message:
          "validFrom must be an ISO-8601 date string; null is not allowed. Omit the field to keep the stored value."
      });
    }
  }

  if (hasField(body, "validTo")) {
    const value = body.validTo;
    if (value === null) {
      patch.validTo = null;
    } else if (typeof value === "string") {
      patch.validTo = new Date(value);
    } else {
      errors.push({
        field: "validTo",
        message:
          "validTo must be an ISO-8601 date string, or null to clear it. Omit the field to keep the stored value."
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, patch };
}

/**
 * A patch that carries no field at all is the documented `{}` no-op (see the
 * OpenAPI request-body note for both code routes): merging it onto the stored
 * record reproduces the record unchanged, so the caller must skip the write,
 * the audit event and the domain event entirely. Kept here — beside parse and
 * merge — so the "how many fields did the caller send" decision lives in ONE
 * place and can never be re-derived (and drift) at a call site. (Issue #843.)
 */
export function isEmptyReferenceCodePatch(
  patch: ReferenceCodePatchInput
): boolean {
  return Object.keys(patch).length === 0;
}

/**
 * Apply a parsed partial patch onto the stored record's current mutable
 * attributes. Fields absent from the patch are carried over verbatim.
 */
export function mergeReferenceCodePatchInput(
  existing: ReferenceCodeMutableFields,
  patch: ReferenceCodePatchInput
): ReferenceCodeMutableFields {
  return {
    labels: patch.labels === undefined ? existing.labels : patch.labels,
    sortOrder:
      patch.sortOrder === undefined ? existing.sortOrder : patch.sortOrder,
    metadata: patch.metadata === undefined ? existing.metadata : patch.metadata,
    validFrom:
      patch.validFrom === undefined ? existing.validFrom : patch.validFrom,
    validTo: patch.validTo === undefined ? existing.validTo : patch.validTo
  };
}
