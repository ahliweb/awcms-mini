/**
 * Validation rules for `data_exchange`'s own SELF-CONTAINED reference
 * fixture (`awcms_mini_data_exchange_reference_items`, Issue #752). This
 * is deliberately NOT a real business domain — it exists solely so this
 * module can prove its own staging/validate/preview/commit/export/
 * reconciliation mechanism end-to-end without touching another module's
 * files while several sibling Wave-3 issues are being implemented in
 * parallel (mirrors the accepted "foundation issue ships zero real
 * business integrations" precedent from `domain_event_runtime`, Issue
 * #742 — see that module's README/module.ts for the identical framing).
 *
 * A "reference item" is an intentionally generic tenant-scoped code/label/
 * numeric-value row (think: a lookup/reference code list) — `code` is the
 * natural key (unique per tenant), `label` a human-readable description,
 * `value` an optional numeric attribute.
 */
import {
  hasDangerousFormulaPrefix,
  neutralizeFormulaInjectionValue
} from "./formula-injection-guard";

const CODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_LABEL_LENGTH = 300;

export type ReferenceItemFields = {
  code: string;
  label: string;
  value: number | null;
  status: "active" | "inactive";
};

export type ReferenceItemFieldError = {
  field: string;
  message: string;
};

export type ReferenceItemValidationResult =
  | { valid: true; fields: ReferenceItemFields; warnings: string[] }
  | { valid: false; errors: ReferenceItemFieldError[] };

function readStringField(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (typeof raw === "number") {
    return String(raw);
  }
  return null;
}

/**
 * Validates ONE parsed row (already formula-injection-neutralized by the
 * generic intake parser) against this fixture's own schema. Every string
 * value is re-checked for a dangerous prefix here too (defense in depth —
 * an adapter should never assume the generic layer's neutralization is
 * the only line of defense, matching this module's own "applied twice"
 * design documented in `formula-injection-guard.ts`).
 */
export function validateReferenceItemRow(
  row: Record<string, unknown>
): ReferenceItemValidationResult {
  const errors: ReferenceItemFieldError[] = [];
  const warnings: string[] = [];

  const rawCode = readStringField(row.code);
  let code = "";
  if (!rawCode) {
    errors.push({ field: "code", message: "code is required." });
  } else {
    const candidate = rawCode.toLowerCase();
    if (!CODE_PATTERN.test(candidate)) {
      errors.push({
        field: "code",
        message:
          "code must start with a lowercase letter and contain only lowercase letters, digits, underscore, or hyphen (max 64 chars)."
      });
    } else {
      code = candidate;
    }
  }

  const rawLabel = readStringField(row.label);
  let label = "";
  if (!rawLabel) {
    errors.push({ field: "label", message: "label is required." });
  } else if (rawLabel.length > MAX_LABEL_LENGTH) {
    errors.push({
      field: "label",
      message: `label must be at most ${MAX_LABEL_LENGTH} characters.`
    });
  } else {
    label = rawLabel;
    if (hasDangerousFormulaPrefix(label)) {
      warnings.push(
        "label began with a spreadsheet-formula-triggering character and was neutralized."
      );
      label = neutralizeFormulaInjectionValue(label).value;
    }
  }

  let value: number | null = null;
  if (row.value !== undefined && row.value !== null && row.value !== "") {
    const numeric =
      typeof row.value === "number" ? row.value : Number(row.value);
    if (!Number.isFinite(numeric)) {
      errors.push({ field: "value", message: "value must be numeric." });
    } else {
      value = numeric;
    }
  }

  let status: "active" | "inactive" = "active";
  if (row.status !== undefined && row.status !== null && row.status !== "") {
    const rawStatus = String(row.status).toLowerCase().trim();
    if (rawStatus !== "active" && rawStatus !== "inactive") {
      errors.push({
        field: "status",
        message: 'status must be "active" or "inactive" when provided.'
      });
    } else {
      status = rawStatus;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, fields: { code, label, value, status }, warnings };
}
