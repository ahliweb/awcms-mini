/**
 * Segregation-of-duties (SoD) conflict detection (Issue #746, epic #738
 * platform-evolution Wave 2). Pure, I/O-free domain logic — same
 * "resolve the facts elsewhere, decide here" split `evaluateAccess`
 * (`access-control.ts`) already follows; kept in its own file rather than
 * growing `access-control.ts` further, per this issue's own scope note.
 *
 * A conflict is: the subject holds (via an active business-scope
 * assignment's role) another permission that a registered `SoDRuleDescriptor`
 * (`_shared/module-contract.ts`) declares conflicts with the permission
 * currently being granted/requested — evaluated against `scopeApplicability`
 * (`"global_within_tenant"` = anywhere in the tenant is enough;
 * `"same_scope_only"` = only when both permissions apply to the identical
 * `(scopeType, scopeId)`; `"any"` is reserved, unused today, treated the
 * same as `"global_within_tenant"` so a future rule using it never silently
 * fails open).
 *
 * Ambiguous/unresolved is default-deny, per issue #746's own security
 * requirement: a `"same_scope_only"` rule with no `requestedScope` supplied
 * can never positively rule out a conflict, so it is treated as an
 * INDETERMINATE match here (surfaced in the result, NOT silently dropped) —
 * the caller (the real chokepoint, `access-guard.ts`) decides to deny on
 * indeterminate exactly like a confirmed conflict, per the same
 * default-deny principle, rather than this pure function silently deciding
 * "no requestedScope means no conflict".
 */
import type { SoDRuleDescriptor } from "../../_shared/module-contract";

/** One permission a subject currently holds via an ACTIVE business-scope assignment's role — resolved ahead of time (I/O) by `business-scope-facts.ts`, never here. */
export type SoDAssignmentFact = {
  permissionKey: string;
  scopeType: string;
  scopeId: string;
};

export type RequestedScope = {
  scopeType: string;
  scopeId: string;
};

export type SoDConflictMatch = {
  rule: SoDRuleDescriptor;
  /** The OTHER conflicting permission key the subject was found to already hold (or, for an indeterminate same-scope match, the one that COULD conflict pending scope resolution). */
  conflictingPermissionKey: string;
  /** `true` when scope resolution was required but not supplied — the caller must default-deny, not treat this as "no conflict". */
  indeterminate: boolean;
};

/**
 * Every rule (from the WHOLE registry, `collectSoDRuleDescriptors`) whose
 * `conflictingPermissionKeys` includes `requestedPermissionKey` AND whose
 * OTHER conflicting key(s) the subject is already found to hold (per
 * `scopeApplicability`), based on `subjectFacts` (that subject's OTHER
 * currently-active business-scope-assignment-granted permissions —
 * EXCLUDING the assignment/action being evaluated itself, the caller's
 * responsibility to exclude before calling this).
 */
export function detectSoDConflicts(
  rules: readonly SoDRuleDescriptor[],
  requestedPermissionKey: string,
  requestedScope: RequestedScope | null,
  subjectFacts: readonly SoDAssignmentFact[]
): SoDConflictMatch[] {
  const matches: SoDConflictMatch[] = [];

  for (const rule of rules) {
    if (!rule.conflictingPermissionKeys.includes(requestedPermissionKey)) {
      continue;
    }

    const otherKeys = rule.conflictingPermissionKeys.filter(
      (key) => key !== requestedPermissionKey
    );

    for (const otherKey of otherKeys) {
      const holdingFacts = subjectFacts.filter(
        (fact) => fact.permissionKey === otherKey
      );

      if (holdingFacts.length === 0) {
        continue;
      }

      if (rule.scopeApplicability === "same_scope_only") {
        if (!requestedScope) {
          matches.push({
            rule,
            conflictingPermissionKey: otherKey,
            indeterminate: true
          });
          continue;
        }

        const scopedMatch = holdingFacts.some(
          (fact) =>
            fact.scopeType === requestedScope.scopeType &&
            fact.scopeId === requestedScope.scopeId
        );

        if (scopedMatch) {
          matches.push({
            rule,
            conflictingPermissionKey: otherKey,
            indeterminate: false
          });
        }
        continue;
      }

      // "global_within_tenant" (and the reserved, currently-unused "any")
      // — holding the other permission ANYWHERE in the tenant is itself
      // the conflict, no scope match required.
      matches.push({
        rule,
        conflictingPermissionKey: otherKey,
        indeterminate: false
      });
    }
  }

  return matches;
}

/**
 * Whether a SoD conflict exception ROW currently authorizes bypassing a
 * conflict, checked against `now` rather than trusted from `status` alone —
 * "status is a cache, effective_to compared against now() is the real
 * gate" (same convention `evaluateLoginAttempt`/`evaluatePasswordResetToken`
 * already use for their own DB status fields). A `status: "approved"` row
 * whose `effectiveTo` has already passed is NOT currently valid, even
 * though nothing has (yet) run the expiry job to flip its `status` to
 * `"expired"`.
 */
export function isSoDConflictExceptionCurrentlyValid(
  exception: {
    status: string;
    effectiveFrom: Date;
    effectiveTo: Date;
    scopeType: string | null;
    scopeId: string | null;
  },
  now: Date,
  requestedScope: RequestedScope | null
): boolean {
  if (exception.status !== "approved") {
    return false;
  }
  if (now < exception.effectiveFrom || now >= exception.effectiveTo) {
    return false;
  }
  // A scope-specific exception only covers ITS OWN scope; a blanket
  // exception (scopeType/scopeId both null at creation) covers every
  // scope, including an indeterminate (no requestedScope) high-risk
  // decision — a blanket exception is an explicit, human-approved,
  // bounded-lifetime grant, so covering an indeterminate case is the
  // intended relief this flow exists to provide.
  if (exception.scopeType === null && exception.scopeId === null) {
    return true;
  }
  if (!requestedScope) {
    return false;
  }
  return (
    exception.scopeType === requestedScope.scopeType &&
    exception.scopeId === requestedScope.scopeId
  );
}

const MAX_TEXT_FIELD_LENGTH = 2000;
const MIN_JUSTIFICATION_LENGTH = 10;

export type SoDConflictExceptionValidationError = {
  field: string;
  message: string;
};

export type CreateSoDConflictExceptionInput = {
  ruleKey: string;
  scopeType: string | null;
  scopeId: string | null;
  justification: string;
  effectiveFrom: Date;
  effectiveTo: Date;
};

/**
 * Structural validation only — NOT the "rule actually exists in the
 * registry"/"exceptionPolicy.allowed"/"maxDurationDays bound" checks (those
 * need the SoD rule registry, applied by `application/sod-exception-
 * service.ts`, which has it in scope).
 */
export function validateCreateSoDConflictExceptionInput(
  input: CreateSoDConflictExceptionInput
): SoDConflictExceptionValidationError[] {
  const errors: SoDConflictExceptionValidationError[] = [];

  if (!input.ruleKey) {
    errors.push({ field: "ruleKey", message: "ruleKey is required." });
  }

  if ((input.scopeType === null) !== (input.scopeId === null)) {
    errors.push({
      field: "scopeType",
      message:
        "scopeType and scopeId must both be set (scope-specific exception) or both be null (blanket exception)."
    });
  }

  if (
    !input.justification ||
    input.justification.trim().length < MIN_JUSTIFICATION_LENGTH
  ) {
    errors.push({
      field: "justification",
      message: `justification is required and must be at least ${MIN_JUSTIFICATION_LENGTH} characters.`
    });
  } else if (input.justification.length > MAX_TEXT_FIELD_LENGTH) {
    errors.push({
      field: "justification",
      message: `justification must be at most ${MAX_TEXT_FIELD_LENGTH} characters.`
    });
  }

  if (Number.isNaN(input.effectiveFrom.getTime())) {
    errors.push({
      field: "effectiveFrom",
      message: "effectiveFrom must be a valid date."
    });
  }

  if (Number.isNaN(input.effectiveTo.getTime())) {
    errors.push({
      field: "effectiveTo",
      message: "effectiveTo must be a valid date."
    });
  } else if (input.effectiveTo <= input.effectiveFrom) {
    errors.push({
      field: "effectiveTo",
      message:
        "effectiveTo must be after effectiveFrom — exceptions must have a bounded lifetime (no indefinite override)."
    });
  }

  return errors;
}

export type DecideSoDConflictExceptionInput = {
  decisionReason: string | null;
};

export type RevokeSoDConflictExceptionInput = {
  revokeReason: string;
};

export function validateRevokeSoDConflictExceptionInput(
  input: RevokeSoDConflictExceptionInput
): SoDConflictExceptionValidationError[] {
  const errors: SoDConflictExceptionValidationError[] = [];

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
