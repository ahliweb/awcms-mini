/**
 * Pure numbering-sequence domain rules (Issue #751). No I/O — the
 * ACTUAL concurrency-safe allocation (row-level `SELECT ... FOR UPDATE`)
 * lives in `application/document-number-sequence-service.ts`; this file
 * only computes the period key / next value GIVEN a row already read
 * under lock, so it stays trivially unit-testable without a database.
 */
import type { DocumentValidationError } from "./errors";
import { isSnakeCaseIdentifier } from "./errors";
import { validateNumberFormatTemplate } from "./number-format-template";

export const RESET_POLICIES = ["never", "yearly", "monthly", "daily"] as const;
export type ResetPolicy = (typeof RESET_POLICIES)[number];

export function isResetPolicy(value: unknown): value is ResetPolicy {
  return (
    typeof value === "string" &&
    (RESET_POLICIES as readonly string[]).includes(value)
  );
}

/** `null` for `"never"` (a never-resetting sequence has no period concept). Computed from UTC calendar fields — same basis `number-format-template.ts`'s `{YYYY}/{MM}/{DD}` tokens use, so a sequence's period key and its rendered date tokens never disagree about "which day is it". */
export function computePeriodKey(
  resetPolicy: ResetPolicy,
  date: Date
): string | null {
  if (resetPolicy === "never") {
    return null;
  }
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  if (resetPolicy === "yearly") return year;
  if (resetPolicy === "monthly") return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

/**
 * The next counter value GIVEN the row's current value/period key
 * (already read under `SELECT ... FOR UPDATE`) and the new period key
 * for "now". A period rollover (new key differs from stored key) resets
 * to 1 — never to 0, since a formatted number's `{SEQ}` should start at
 * 1, not 0.
 */
export function computeNextSequenceValue(
  currentValue: number,
  currentPeriodKey: string | null,
  newPeriodKey: string | null
): number {
  if (newPeriodKey !== currentPeriodKey) {
    return 1;
  }
  return currentValue + 1;
}

/**
 * `resetPolicy` is typed as plain `string` (not the `ResetPolicy` literal
 * union) — same convention `confidentialityLevel` uses across every other
 * domain file in this module: a value straight off an HTTP JSON body is
 * `unknown`/`string` at the route boundary, never pre-validated as the
 * narrower literal type before this function runs. `validateDefineSequenceInput`
 * is what actually checks membership at runtime (`isResetPolicy`).
 */
export type DefineSequenceInput = {
  scopeType: string;
  scopeId: string | null;
  sequenceKey: string;
  formatTemplate: string;
  resetPolicy: string;
};

export function validateDefineSequenceInput(
  input: DefineSequenceInput
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

  if (!isSnakeCaseIdentifier(input.scopeType)) {
    errors.push({
      field: "scopeType",
      message:
        'scopeType must be a lowercase snake_case identifier (e.g. "tenant", "office", "legal_entity").'
    });
  }
  if (input.scopeId !== null && input.scopeId.trim().length === 0) {
    errors.push({
      field: "scopeId",
      message:
        "scopeId must not be blank when provided (omit it entirely for a tenant-wide sequence)."
    });
  }
  if (input.scopeId !== null && input.scopeId.length > 200) {
    errors.push({
      field: "scopeId",
      message: "scopeId must be at most 200 characters."
    });
  }
  if (!isSnakeCaseIdentifier(input.sequenceKey)) {
    errors.push({
      field: "sequenceKey",
      message:
        'sequenceKey must be a lowercase snake_case identifier (e.g. "invoice", "correspondence").'
    });
  }
  if (!isResetPolicy(input.resetPolicy)) {
    errors.push({
      field: "resetPolicy",
      message: `resetPolicy must be one of: ${RESET_POLICIES.join(", ")}.`
    });
  }

  errors.push(...validateNumberFormatTemplate(input.formatTemplate));

  return errors;
}

/** `resetPolicy` typed `string` — see `DefineSequenceInput`'s own comment above for why. */
export type ReviseSequenceInput = {
  formatTemplate: string;
  resetPolicy: string;
  revisionReason: string;
};

export function validateReviseSequenceInput(
  input: ReviseSequenceInput
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

  if (!isResetPolicy(input.resetPolicy)) {
    errors.push({
      field: "resetPolicy",
      message: `resetPolicy must be one of: ${RESET_POLICIES.join(", ")}.`
    });
  }
  if (!input.revisionReason || input.revisionReason.trim().length === 0) {
    errors.push({
      field: "revisionReason",
      message: "revisionReason is required."
    });
  }

  errors.push(...validateNumberFormatTemplate(input.formatTemplate));

  return errors;
}

export type CancelReservationInput = {
  cancelReason: string;
};

export function validateCancelReservationInput(
  input: CancelReservationInput
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

  if (!input.cancelReason || input.cancelReason.trim().length === 0) {
    errors.push({
      field: "cancelReason",
      message: "cancelReason is required."
    });
  }

  return errors;
}
