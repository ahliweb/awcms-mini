/**
 * Defensive parsing of untrusted JSON request bodies into the typed domain
 * inputs (Issue #871). Kept out of the route files so it is unit-testable and
 * so the FAIL-CLOSED semantics live in one place (epic pattern #6 — the same
 * discipline `service-catalog/application/request-parsing.ts` proves):
 *   - ABSENT scalar/enum/boolean field -> its default;
 *   - PRESENT field -> kept VERBATIM (cast) so the domain validator rejects a
 *     wrong type/value (400) — NEVER coerced to a default/valid value, which
 *     could grant/deny the wrong thing or silently clear data;
 *   - nullable field -> tri-state: absent -> null (default), present -> verbatim
 *     (a wrong type is rejected by the validator, never coerced to null).
 * Parsing only shapes/coerces types; VALUE validity (formats, bounds, known
 * keys) is the domain layer's job (`domain/entitlement.ts`), run after this.
 */
import type {
  AssignInput,
  AssignmentSource,
  AssignmentTransitionStatus,
  OverrideEffect,
  OverrideInput,
  OverrideSource,
  OverrideTargetKind
} from "../domain/entitlement";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Tri-state nullable at CREATE: absent -> null; present -> verbatim (validator rejects a wrong type; never coerced to null = silent clear). */
function nullableAtCreate(
  record: Record<string, unknown>,
  key: string
): unknown {
  return key in record ? record[key] : null;
}

/** FAIL-CLOSED boolean: absent -> default; present -> verbatim (a non-boolean is rejected by the validator, never coerced to true). */
function asBoolFailClosed(
  record: Record<string, unknown>,
  key: string,
  absentDefault: boolean
): boolean {
  return (key in record ? record[key] : absentDefault) as boolean;
}

export function parseAssignBody(body: unknown): AssignInput {
  const record = asRecord(body);
  return {
    planKey: asString(record.planKey),
    offerVersion:
      typeof record.offerVersion === "number" ? record.offerVersion : NaN,
    // present-but-invalid `source` is passed through verbatim (validator
    // rejects the enum), never coerced to "manual".
    source: ("source" in record
      ? asString(record.source)
      : "manual") as AssignmentSource,
    reason: nullableAtCreate(record, "reason") as string | null,
    effectiveFrom: nullableAtCreate(record, "effectiveFrom") as string | null,
    effectiveTo: nullableAtCreate(record, "effectiveTo") as string | null,
    trialEndsAt: nullableAtCreate(record, "trialEndsAt") as string | null,
    graceEndsAt: nullableAtCreate(record, "graceEndsAt") as string | null
  };
}

export function parseOverrideBody(body: unknown): OverrideInput {
  const record = asRecord(body);
  return {
    targetKind: ("targetKind" in record
      ? asString(record.targetKind)
      : "") as OverrideTargetKind,
    targetKey: asString(record.targetKey),
    effect: ("effect" in record
      ? asString(record.effect)
      : "") as OverrideEffect,
    quotaIsUnlimited: asBoolFailClosed(record, "quotaIsUnlimited", false),
    // Tri-state nullable number: absent -> null; present -> verbatim (validator
    // rejects a non-number, never coerces).
    quotaLimitValue: nullableAtCreate(record, "quotaLimitValue") as
      number | null,
    quotaUnit: nullableAtCreate(record, "quotaUnit") as string | null,
    // reason is REQUIRED — an absent/blank reason is kept as-is (""/wrong type)
    // so the domain validator rejects it (400), never defaulted.
    reason: "reason" in record ? (record.reason as string) : "",
    source: ("source" in record
      ? asString(record.source)
      : "manual") as OverrideSource,
    effectiveFrom: nullableAtCreate(record, "effectiveFrom") as string | null,
    effectiveTo: nullableAtCreate(record, "effectiveTo") as string | null
  };
}

export type TransitionBody = {
  status: AssignmentTransitionStatus;
  reason: string | null;
};

export function parseTransitionBody(body: unknown): TransitionBody {
  const record = asRecord(body);
  return {
    // present-but-invalid status is passed through verbatim so the route/domain
    // rejects it, never coerced.
    status: asString(record.status) as AssignmentTransitionStatus,
    reason: nullableAtCreate(record, "reason") as string | null
  };
}
