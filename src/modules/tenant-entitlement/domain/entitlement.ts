/**
 * `tenant_entitlement` domain types + validators (Issue #871, epic #868 SaaS
 * control plane, ADR-0022). Pure — no I/O. The application layer
 * (`application/*`) runs these after the defensive request parsing
 * (`application/request-parsing.ts`) and before persistence.
 *
 * These types describe the ENTITLEMENT RECORDS (assignments, overrides). The
 * RESOLUTION of records into an effective entitlement lives in
 * `domain/resolution.ts`; the KEY REGISTRY (which feature/module/meter keys are
 * known, fail-closed) lives in `domain/entitlement-key-registry.ts`.
 */
import {
  isKnownEntitlementTarget,
  type EntitlementKeyRegistry
} from "./entitlement-key-registry";

/** An assignment's lifecycle status. `canceled` is terminal (entitlement loss; data preserved). */
export type AssignmentStatus = "active" | "suspended" | "canceled";

/** Where an assignment came from (documentary; never a business rule). */
export type AssignmentSource =
  "manual" | "subscription" | "trial" | "migration";

/** What an override targets. */
export type OverrideTargetKind = "feature" | "module" | "quota";

/** Whether an override grants (adds) or denies (restricts) access to its target key. */
export type OverrideEffect = "grant" | "deny";

/** Where an override came from (documentary). */
export type OverrideSource = "manual" | "addon" | "compensation" | "support";

/** The status a `PATCH assignment` transition may request (cancel is a separate route/action). */
export type AssignmentTransitionStatus = "active" | "suspended" | "canceled";

export type EntitlementValidationError = { field: string; message: string };

export const ASSIGNMENT_SOURCES: readonly AssignmentSource[] = [
  "manual",
  "subscription",
  "trial",
  "migration"
];

export const OVERRIDE_TARGET_KINDS: readonly OverrideTargetKind[] = [
  "feature",
  "module",
  "quota"
];

export const OVERRIDE_EFFECTS: readonly OverrideEffect[] = ["grant", "deny"];

export const OVERRIDE_SOURCES: readonly OverrideSource[] = [
  "manual",
  "addon",
  "compensation",
  "support"
];

const PLAN_KEY_FORMAT = /^[a-z][a-z0-9_]*$/;
const REASON_MAX = 500;
const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53-1, matches the DB CHECK bound.

/** A timestamp input is valid only when it is an ISO string that parses (never a coerced non-string — memory `patch-default-in-parse-resets-omitted-fields`). */
export function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SAFE
  );
}

// ---------------------------------------------------------------------------
// Assign input
// ---------------------------------------------------------------------------

export type AssignInput = {
  planKey: string;
  offerVersion: number;
  source: AssignmentSource;
  reason: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
};

/**
 * Validates the shape/values of an assign request. The offer's EXISTENCE +
 * published state + currency/offer-hash are resolved separately at the
 * application layer through the `service_catalog_read` port (an unknown/
 * unpublished offer fails there, not here).
 */
export function validateAssignInput(
  input: AssignInput
): EntitlementValidationError[] {
  const errors: EntitlementValidationError[] = [];

  if (!PLAN_KEY_FORMAT.test(input.planKey) || input.planKey.length > 100) {
    errors.push({
      field: "planKey",
      message: "planKey must match ^[a-z][a-z0-9_]*$ and be at most 100 chars."
    });
  }
  if (!isSafeNonNegativeInteger(input.offerVersion) || input.offerVersion < 1) {
    errors.push({
      field: "offerVersion",
      message: "offerVersion must be a positive integer."
    });
  }
  if (!ASSIGNMENT_SOURCES.includes(input.source)) {
    errors.push({
      field: "source",
      message: `source must be one of: ${ASSIGNMENT_SOURCES.join(", ")}.`
    });
  }
  if (input.reason !== null && input.reason.length > REASON_MAX) {
    errors.push({
      field: "reason",
      message: `reason must be at most ${REASON_MAX} chars.`
    });
  }

  for (const field of [
    "effectiveFrom",
    "effectiveTo",
    "trialEndsAt",
    "graceEndsAt"
  ] as const) {
    const value = input[field];
    if (value !== null && !isValidTimestamp(value)) {
      errors.push({
        field,
        message: `${field} must be an ISO 8601 timestamp or null.`
      });
    }
  }

  if (
    isValidTimestamp(input.effectiveFrom) &&
    isValidTimestamp(input.effectiveTo) &&
    Date.parse(input.effectiveTo) <= Date.parse(input.effectiveFrom)
  ) {
    errors.push({
      field: "effectiveTo",
      message: "effectiveTo must be after effectiveFrom."
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Override input
// ---------------------------------------------------------------------------

export type OverrideInput = {
  targetKind: OverrideTargetKind;
  targetKey: string;
  effect: OverrideEffect;
  quotaIsUnlimited: boolean;
  quotaLimitValue: number | null;
  quotaUnit: string | null;
  reason: string;
  source: OverrideSource;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

const QUOTA_UNIT_FORMAT = /^[a-z][a-z0-9_]*$/;

/**
 * Validates an override request, INCLUDING that the target key is KNOWN
 * (fail-closed: an unknown feature/module/meter key is rejected 400, never
 * accepted silently — ADR-0022 §4 / AC "unknown keys fail closed"). The key
 * registry is derived from the live module descriptors (`listModules()`), so a
 * derived application's reviewed contributions are honored automatically.
 */
export function validateOverrideInput(
  input: OverrideInput,
  registry: EntitlementKeyRegistry
): EntitlementValidationError[] {
  const errors: EntitlementValidationError[] = [];

  if (!OVERRIDE_TARGET_KINDS.includes(input.targetKind)) {
    errors.push({
      field: "targetKind",
      message: `targetKind must be one of: ${OVERRIDE_TARGET_KINDS.join(", ")}.`
    });
  }
  if (!OVERRIDE_EFFECTS.includes(input.effect)) {
    errors.push({
      field: "effect",
      message: `effect must be one of: ${OVERRIDE_EFFECTS.join(", ")}.`
    });
  }
  if (!OVERRIDE_SOURCES.includes(input.source)) {
    errors.push({
      field: "source",
      message: `source must be one of: ${OVERRIDE_SOURCES.join(", ")}.`
    });
  }
  if (
    typeof input.reason !== "string" ||
    input.reason.length < 1 ||
    input.reason.length > REASON_MAX
  ) {
    errors.push({
      field: "reason",
      message: `reason is required and must be 1-${REASON_MAX} chars (overrides are reason-bound, ADR-0022 §5).`
    });
  }

  // Fail-closed unknown key. Only checked once the kind is a known enum.
  if (
    OVERRIDE_TARGET_KINDS.includes(input.targetKind) &&
    !isKnownEntitlementTarget(registry, input.targetKind, input.targetKey)
  ) {
    errors.push({
      field: "targetKey",
      message: `Unknown ${input.targetKind} key "${input.targetKey}" — a key must resolve through the reviewed static registry (fail-closed).`
    });
  }

  // Quota columns are meaningful ONLY for a quota grant.
  const isQuotaGrant = input.targetKind === "quota" && input.effect === "grant";
  if (isQuotaGrant) {
    if (input.quotaIsUnlimited) {
      if (input.quotaLimitValue !== null) {
        errors.push({
          field: "quotaLimitValue",
          message: "quotaLimitValue must be null when quotaIsUnlimited is true."
        });
      }
    } else if (!isSafeNonNegativeInteger(input.quotaLimitValue)) {
      errors.push({
        field: "quotaLimitValue",
        message:
          "quotaLimitValue must be a non-negative safe integer when not unlimited."
      });
    }
    if (
      typeof input.quotaUnit !== "string" ||
      !QUOTA_UNIT_FORMAT.test(input.quotaUnit) ||
      input.quotaUnit.length > 40
    ) {
      errors.push({
        field: "quotaUnit",
        message: "quotaUnit is required for a quota grant (^[a-z][a-z0-9_]*$)."
      });
    }
  } else {
    // A non-quota-grant override must leave quota columns neutral.
    if (
      input.quotaIsUnlimited !== false ||
      input.quotaLimitValue !== null ||
      input.quotaUnit !== null
    ) {
      errors.push({
        field: "quota",
        message:
          "quota fields (quotaIsUnlimited/quotaLimitValue/quotaUnit) are only valid for a quota GRANT override."
      });
    }
  }

  for (const field of ["effectiveFrom", "effectiveTo"] as const) {
    const value = input[field];
    if (value !== null && !isValidTimestamp(value)) {
      errors.push({
        field,
        message: `${field} must be an ISO 8601 timestamp or null.`
      });
    }
  }
  if (
    isValidTimestamp(input.effectiveFrom) &&
    isValidTimestamp(input.effectiveTo) &&
    Date.parse(input.effectiveTo) <= Date.parse(input.effectiveFrom)
  ) {
    errors.push({
      field: "effectiveTo",
      message: "effectiveTo must be after effectiveFrom."
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Assignment transition (suspend / resume / cancel)
// ---------------------------------------------------------------------------

/**
 * The AccessAction required to request a given transition — canceling an
 * assignment is an entitlement REVOCATION (high-risk, `revoke`); suspend/resume
 * is a reversible restriction (`update`). Pure + exported so the route can
 * authorize with the exact action AND so the mapping is unit-testable.
 */
export function requiredActionForTransition(
  toStatus: AssignmentTransitionStatus
): "revoke" | "update" {
  return toStatus === "canceled" ? "revoke" : "update";
}

/**
 * Whether a status transition from `fromStatus` to `toStatus` is legal (mirrors
 * the DB trigger whitelist in sql/081). A canceled assignment is terminal.
 */
export function isLegalTransition(
  fromStatus: AssignmentStatus,
  toStatus: AssignmentTransitionStatus
): boolean {
  if (fromStatus === "canceled") {
    return false;
  }
  if (fromStatus === "active") {
    return toStatus === "suspended" || toStatus === "canceled";
  }
  // suspended
  return toStatus === "active" || toStatus === "canceled";
}
