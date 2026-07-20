/**
 * Fail-closed defensive parsing of the untrusted lifecycle command bodies
 * (Issue #873, epic pattern #6). Same discipline the sibling control-plane
 * parsers prove:
 *   - ABSENT scalar/enum field -> its neutral default (an operator action
 *     defaults `source` to "operator"; a bad TYPE is rejected downstream, never
 *     coerced silently);
 *   - PRESENT field -> kept VERBATIM so the domain validator rejects a wrong
 *     type/value (400) — NEVER coerced to a valid default;
 *   - nullable field (`expectedVersion`) -> tri-state: absent -> null; present
 *     -> verbatim (a wrong type is rejected by the validator, never coerced to
 *     null);
 *   - PRESENT-but-not-an-object body -> `{}` so the validator's required-field
 *     checks fail (never a partial silent default).
 * Parsing only shapes/coerces types; VALUE validity is `domain/request-
 * validation.ts`.
 */
import type {
  DowngradeInput,
  RestoreInput,
  ScheduleInput,
  TransitionInput
} from "../domain/request-validation";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Tri-state nullable: absent -> null; present -> verbatim (validator rejects a wrong type). */
function nullableNumber(
  record: Record<string, unknown>,
  key: string
): number | null {
  if (!(key in record)) return null;
  const value = record[key];
  // Present -> verbatim (NaN forces a validation error; a real wrong type is
  // handled by the validator's Number.isInteger check).
  return typeof value === "number" ? value : (value as number | null);
}

/** Present -> verbatim; absent -> the given operator-action default. */
function sourceOrDefault(record: Record<string, unknown>): string {
  return "source" in record ? asString(record.source) : "operator";
}

export function parseTransitionBody(body: unknown): TransitionInput {
  const record = asRecord(body);
  return {
    toState: asString(record.toState),
    reason: asString(record.reason),
    source: sourceOrDefault(record),
    expectedVersion: nullableNumber(record, "expectedVersion")
  };
}

export function parseScheduleBody(body: unknown): ScheduleInput {
  const record = asRecord(body);
  return {
    toState: asString(record.toState),
    at: asString(record.at),
    reason: asString(record.reason),
    source: "source" in record ? asString(record.source) : "scheduler",
    expectedVersion: nullableNumber(record, "expectedVersion")
  };
}

/** Cancel-schedule body — `{ reason, expectedVersion? }`. */
export function parseCancelScheduleBody(body: unknown): {
  reason: string;
  expectedVersion: number | null;
} {
  const record = asRecord(body);
  return {
    reason: asString(record.reason),
    expectedVersion: nullableNumber(record, "expectedVersion")
  };
}

export function parseDowngradeBody(body: unknown): DowngradeInput {
  const record = asRecord(body);
  return {
    offerPlanKey: asString(record.offerPlanKey),
    // Present -> verbatim (NaN when absent so the validator rejects it).
    offerVersion:
      typeof record.offerVersion === "number"
        ? record.offerVersion
        : "offerVersion" in record
          ? (record.offerVersion as number)
          : NaN,
    reason: asString(record.reason),
    expectedVersion: nullableNumber(record, "expectedVersion")
  };
}

export function parseRestoreBody(body: unknown): RestoreInput {
  const record = asRecord(body);
  return {
    reason: asString(record.reason),
    // Present -> verbatim (a wrong type is rejected; absent -> false, the safe
    // default: an operator must EXPLICITLY confirm unresolved issues).
    confirmUnresolved:
      "confirmUnresolved" in record
        ? (record.confirmUnresolved as boolean)
        : false,
    expectedVersion: nullableNumber(record, "expectedVersion")
  };
}
