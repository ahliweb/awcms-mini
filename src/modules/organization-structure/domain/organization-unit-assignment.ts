/**
 * Organization-unit assignment domain rules (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016). Pure functions only — no I/O.
 *
 * An effective-dated assignment of an `identity_access` tenant user to an
 * organization unit, with an optional plain-string `positionLabel`
 * (explicitly NOT an HR/payroll hierarchy or job-grade system — issue #749
 * out-of-scope: "HR, payroll ... organizational payroll positions").
 */

const MAX_POSITION_LABEL_LENGTH = 200;
const MAX_REASON_LENGTH = 2000;

export type OrganizationUnitAssignmentValidationError = {
  field: string;
  message: string;
};

export type CreateOrganizationUnitAssignmentInput = {
  organizationUnitId: string;
  tenantUserId: string;
  positionLabel: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  reason: string | null;
};

export function validateCreateOrganizationUnitAssignmentInput(
  input: CreateOrganizationUnitAssignmentInput
): OrganizationUnitAssignmentValidationError[] {
  const errors: OrganizationUnitAssignmentValidationError[] = [];

  if (!input.organizationUnitId) {
    errors.push({
      field: "organizationUnitId",
      message: "organizationUnitId is required."
    });
  }

  if (!input.tenantUserId) {
    errors.push({
      field: "tenantUserId",
      message: "tenantUserId is required."
    });
  }

  if (
    input.positionLabel !== null &&
    input.positionLabel.length > MAX_POSITION_LABEL_LENGTH
  ) {
    errors.push({
      field: "positionLabel",
      message: `positionLabel must be at most ${MAX_POSITION_LABEL_LENGTH} characters.`
    });
  }

  if (input.reason !== null && input.reason.length > MAX_REASON_LENGTH) {
    errors.push({
      field: "reason",
      message: `reason must be at most ${MAX_REASON_LENGTH} characters.`
    });
  }

  if (Number.isNaN(input.effectiveFrom.getTime())) {
    errors.push({
      field: "effectiveFrom",
      message: "effectiveFrom must be a valid date."
    });
  }

  if (input.effectiveTo !== null) {
    if (Number.isNaN(input.effectiveTo.getTime())) {
      errors.push({
        field: "effectiveTo",
        message: "effectiveTo must be a valid date when provided."
      });
    } else if (input.effectiveTo <= input.effectiveFrom) {
      errors.push({
        field: "effectiveTo",
        message: "effectiveTo must be after effectiveFrom."
      });
    }
  }

  return errors;
}

export type EndOrganizationUnitAssignmentInput = {
  endReason: string;
};

export function validateEndOrganizationUnitAssignmentInput(
  input: EndOrganizationUnitAssignmentInput
): OrganizationUnitAssignmentValidationError[] {
  const errors: OrganizationUnitAssignmentValidationError[] = [];

  if (!input.endReason || input.endReason.trim().length === 0) {
    errors.push({ field: "endReason", message: "endReason is required." });
  } else if (input.endReason.length > MAX_REASON_LENGTH) {
    errors.push({
      field: "endReason",
      message: `endReason must be at most ${MAX_REASON_LENGTH} characters.`
    });
  }

  return errors;
}

export type OrganizationUnitAssignmentStatus = "active" | "ended";

export function isOrganizationUnitAssignmentCurrentlyActive(
  assignment: {
    status: OrganizationUnitAssignmentStatus;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  },
  now: Date
): boolean {
  if (assignment.status !== "active") {
    return false;
  }
  if (now < assignment.effectiveFrom) {
    return false;
  }
  if (assignment.effectiveTo !== null && now >= assignment.effectiveTo) {
    return false;
  }
  return true;
}

/** "Expiring soon" window for the metric/UI signal — a fixed 30-day default, not itself an auto-expiry action (issue #749 scope: "just a metric", no expiry job required). */
export const DEFAULT_EXPIRING_SOON_WINDOW_DAYS = 30;

export function isExpiringSoon(
  effectiveTo: Date | null,
  now: Date,
  windowDays: number = DEFAULT_EXPIRING_SOON_WINDOW_DAYS
): boolean {
  if (effectiveTo === null) {
    return false;
  }
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  return effectiveTo.getTime() - now.getTime() <= windowMs && effectiveTo > now;
}
