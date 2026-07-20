/**
 * Lifecycle command input types + VALUE validation (Issue #873). Shape/type
 * coercion is the parser's job (`application/request-parsing.ts`, fail-closed
 * tri-state); this file validates VALUE VALIDITY (known state/source, bounds,
 * mandatory reason) and runs after parsing. Pure — no I/O.
 *
 * Every high-risk lifecycle mutation carries a MANDATORY reason (AC "audit all
 * high-risk lifecycle actions with mandatory reason").
 */
import {
  isLifecycleSource,
  isLifecycleState,
  type LifecycleSource,
  type LifecycleState
} from "./lifecycle-state";

export type TransitionInput = {
  toState: LifecycleState | string;
  reason: string;
  source: LifecycleSource | string;
  /** Optimistic-concurrency guard: reject if the current version differs (AC). Absent = no version pin. */
  expectedVersion: number | null;
};

export type ScheduleInput = {
  toState: LifecycleState | string;
  /** ISO-8601 due time. */
  at: string;
  reason: string;
  source: LifecycleSource | string;
  expectedVersion: number | null;
};

export type DowngradeInput = {
  offerPlanKey: string;
  offerVersion: number;
  reason: string;
  expectedVersion: number | null;
};

export type RestoreInput = {
  reason: string;
  /**
   * Explicit confirmation that unresolved provisioning/payment issues are
   * accepted (AC "restore does not silently overlook failed provisioning").
   */
  confirmUnresolved: boolean;
  expectedVersion: number | null;
};

export type LifecycleValidationError = { field: string; message: string };

const KEY_RE = /^[a-z][a-z0-9_]*$/;

function validateReason(
  reason: unknown,
  errors: LifecycleValidationError[]
): void {
  if (
    typeof reason !== "string" ||
    reason.trim().length < 1 ||
    reason.length > 2000
  ) {
    errors.push({
      field: "reason",
      message: "reason is required (1..2000 chars) for every lifecycle action"
    });
  }
}

function validateExpectedVersion(
  expectedVersion: unknown,
  errors: LifecycleValidationError[]
): void {
  if (
    expectedVersion !== null &&
    (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1)
  ) {
    errors.push({
      field: "expectedVersion",
      message: "must be a positive integer when provided"
    });
  }
}

function validateSource(
  source: unknown,
  errors: LifecycleValidationError[]
): void {
  if (!isLifecycleSource(source)) {
    errors.push({
      field: "source",
      message:
        "must be one of system/operator/scheduler/billing/provisioning/restore"
    });
  }
}

export function validateTransition(
  input: TransitionInput
): LifecycleValidationError[] {
  const errors: LifecycleValidationError[] = [];
  if (!isLifecycleState(input.toState)) {
    errors.push({ field: "toState", message: "unknown lifecycle state" });
  }
  validateReason(input.reason, errors);
  validateSource(input.source, errors);
  validateExpectedVersion(input.expectedVersion, errors);
  return errors;
}

export function validateSchedule(
  input: ScheduleInput
): LifecycleValidationError[] {
  const errors: LifecycleValidationError[] = [];
  if (!isLifecycleState(input.toState)) {
    errors.push({ field: "toState", message: "unknown lifecycle state" });
  }
  const at = Date.parse(input.at);
  if (typeof input.at !== "string" || Number.isNaN(at)) {
    errors.push({ field: "at", message: "must be an ISO-8601 timestamp" });
  }
  validateReason(input.reason, errors);
  validateSource(input.source, errors);
  validateExpectedVersion(input.expectedVersion, errors);
  return errors;
}

export function validateDowngrade(
  input: DowngradeInput
): LifecycleValidationError[] {
  const errors: LifecycleValidationError[] = [];
  if (!KEY_RE.test(input.offerPlanKey) || input.offerPlanKey.length > 100) {
    errors.push({
      field: "offerPlanKey",
      message: "must be a lower_snake key"
    });
  }
  if (!Number.isInteger(input.offerVersion) || input.offerVersion < 1) {
    errors.push({
      field: "offerVersion",
      message: "must be a positive integer"
    });
  }
  validateReason(input.reason, errors);
  validateExpectedVersion(input.expectedVersion, errors);
  return errors;
}

export function validateRestore(
  input: RestoreInput
): LifecycleValidationError[] {
  const errors: LifecycleValidationError[] = [];
  validateReason(input.reason, errors);
  if (typeof input.confirmUnresolved !== "boolean") {
    errors.push({
      field: "confirmUnresolved",
      message: "must be a boolean"
    });
  }
  validateExpectedVersion(input.expectedVersion, errors);
  return errors;
}
