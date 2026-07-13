/**
 * Business-scope assignment domain rules (Issue #746, epic #738
 * platform-evolution Wave 2). Pure functions only — no I/O, no database —
 * same "structural validation here, ABAC/persistence elsewhere" split
 * `data-lifecycle/domain/legal-hold.ts` documents for its own module.
 */

const MAX_TEXT_FIELD_LENGTH = 2000;
const SCOPE_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

export type BusinessScopeAssignmentStatus = "active" | "expired" | "revoked";

export type BusinessScopeAssignmentValidationError = {
  field: string;
  message: string;
};

export type CreateBusinessScopeAssignmentInput = {
  tenantUserId: string;
  roleId: string | null;
  scopeType: string;
  scopeId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isTemporary: boolean;
  reason: string | null;
};

/**
 * Structural validation only — NOT an ABAC/authorization check, NOT scope
 * resolution (that is `BusinessScopeHierarchyPort`, applied separately by
 * `application/business-scope-assignment-service.ts`).
 */
export function validateCreateBusinessScopeAssignmentInput(
  input: CreateBusinessScopeAssignmentInput
): BusinessScopeAssignmentValidationError[] {
  const errors: BusinessScopeAssignmentValidationError[] = [];

  if (!input.scopeType || !SCOPE_TYPE_PATTERN.test(input.scopeType)) {
    errors.push({
      field: "scopeType",
      message:
        'scopeType is required and must be lowercase snake_case (e.g. "office").'
    });
  }

  if (!input.scopeId) {
    errors.push({ field: "scopeId", message: "scopeId is required." });
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

  // "A temporary assignment must have an end date" (issue #746 scope,
  // mirrored by the migration's own CHECK constraint — validated here too
  // so the caller gets a clean 400 instead of a raw constraint violation).
  if (input.isTemporary && input.effectiveTo === null) {
    errors.push({
      field: "effectiveTo",
      message: "effectiveTo is required when isTemporary is true."
    });
  }

  if (input.reason !== null && input.reason.length > MAX_TEXT_FIELD_LENGTH) {
    errors.push({
      field: "reason",
      message: `reason must be at most ${MAX_TEXT_FIELD_LENGTH} characters.`
    });
  }

  return errors;
}

export type RevokeBusinessScopeAssignmentInput = {
  revokeReason: string;
};

export function validateRevokeBusinessScopeAssignmentInput(
  input: RevokeBusinessScopeAssignmentInput
): BusinessScopeAssignmentValidationError[] {
  const errors: BusinessScopeAssignmentValidationError[] = [];

  if (!input.revokeReason || input.revokeReason.trim().length === 0) {
    errors.push({
      field: "revokeReason",
      message: "revokeReason is required."
    });
  } else if (input.revokeReason.length > MAX_TEXT_FIELD_LENGTH) {
    errors.push({
      field: "revokeReason",
      message: `revokeReason must be at most ${MAX_TEXT_FIELD_LENGTH} characters.`
    });
  }

  return errors;
}

/**
 * Whether an assignment ROW is currently in force — checked against `now`,
 * not `status` alone (same "status is a cache, timestamp is the real gate"
 * convention `sod-conflict-evaluation.ts`'s `isSoDConflictExceptionCurrentlyValid`
 * documents). An `active`-status row whose `effectiveTo` has passed, or
 * whose `effectiveFrom` is still in the future, is NOT currently in force.
 */
export function isBusinessScopeAssignmentCurrentlyActive(
  assignment: {
    status: BusinessScopeAssignmentStatus;
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
