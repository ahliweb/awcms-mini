import type { ValidationError, ValidationResult } from "./party-validation";

export type MergeRequestInput = {
  sourceProfileId: string;
  targetProfileId: string;
};

/**
 * Naming convention (matches migration 003's column names): `source` is
 * the LOSER (merged away, soft-deleted with `merged_into_profile_id` set
 * on success), `target` is the SURVIVOR (absorbs the loser's references).
 */
export function assertMergeRequestIsValid(input: MergeRequestInput): void {
  if (input.sourceProfileId === input.targetProfileId) {
    throw new Error(
      "Profile merge request source and target must not be the same profile."
    );
  }
}

/**
 * Thrown whenever a merge-adjacent operation (duplicate-candidate
 * generation, merge-request creation, merge EXECUTION) discovers that a
 * profile it was about to compare/merge does not belong to the caller's
 * own tenant. Issue #748 security requirement: "cross-tenant matching/
 * merge is strictly prohibited" — this is the mechanism, not just RLS.
 * RLS alone would only make a cross-tenant row invisible/return zero
 * rows; this throws a distinct, explicit, auditable error so a caller
 * that (by a future bug) obtained a cross-tenant id from anywhere other
 * than the tenant-scoped query itself is still refused loudly.
 */
export class CrossTenantMergeError extends Error {
  constructor() {
    super(
      "Cross-tenant profile matching/merge is not permitted — both profiles must belong to the requesting tenant."
    );
    this.name = "CrossTenantMergeError";
  }
}

/**
 * MUST be called, inside the SAME transaction, immediately before every
 * real state-changing merge/match operation — re-validating against
 * freshly re-fetched rows, never trusting a tenant id carried on a
 * duplicate-candidate row or an earlier request. See
 * `application/merge-workflow.ts`'s `executeMergeRequest` and
 * `application/duplicate-candidate-directory.ts`'s generation function
 * for the two real call sites.
 */
export function assertSameTenant(
  requestTenantId: string,
  ...profileTenantIds: string[]
): void {
  for (const profileTenantId of profileTenantIds) {
    if (profileTenantId !== requestTenantId) {
      throw new CrossTenantMergeError();
    }
  }
}

export type PartySnapshot = {
  id: string;
  profileType: string;
  displayName: string;
  legalName: string | null;
  riskLevel: string;
  verificationStatus: string;
};

export type FieldConflict = {
  field: string;
  sourceValue: unknown;
  targetValue: unknown;
};

const COMPARABLE_FIELDS: readonly (keyof PartySnapshot)[] = [
  "profileType",
  "displayName",
  "legalName",
  "riskLevel",
  "verificationStatus"
];

/** Surfaces exactly which fields differ between the two profiles so a human reviewer picks which value survives — never silently picked by the system. The target's own current values are always what actually survives (this base does not offer per-field pick-and-choose merge, only whole-profile survivor selection) — conflicts are reported for review/audit visibility, matching the issue's "field conflict review" requirement without adding a field-level merge UI in this issue. */
export function computeFieldConflicts(
  source: PartySnapshot,
  target: PartySnapshot
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];

  for (const field of COMPARABLE_FIELDS) {
    if (source[field] !== target[field]) {
      conflicts.push({
        field,
        sourceValue: source[field],
        targetValue: target[field]
      });
    }
  }

  return conflicts;
}

export type ReferenceImpactEntry = {
  moduleKey: string;
  entityType: string;
  count: number;
};

export type ReferenceImpactSummary = {
  totalEntityLinks: number;
  byModule: ReferenceImpactEntry[];
};

/**
 * Every merge in this base requires approval (issue requirement:
 * "approval for high-risk merges is mandatory") — rather than branch on a
 * risk heuristic that could itself be wrong, every merge is treated as
 * high-risk: it is irreversible-by-default (soft-deletes the loser) and
 * can silently ripple into any domain module holding an
 * `awcms_mini_profile_entity_links` reference. This is a strict superset
 * of "high-risk merges require approval", so it also satisfies the
 * requirement for merges that happen to carry zero references today.
 */
export function computeRequiresApproval(): true {
  return true;
}

export type CreateMergeRequestInput = {
  sourceProfileId: string;
  targetProfileId: string;
  reason: string;
  duplicateCandidateId: string | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_REASON_LENGTH = 1000;

export function validateCreateMergeRequestInput(
  body: unknown
): ValidationResult<CreateMergeRequestInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (
    typeof record.sourceProfileId !== "string" ||
    !UUID_PATTERN.test(record.sourceProfileId)
  ) {
    errors.push({
      field: "sourceProfileId",
      message: "sourceProfileId must be a valid profile id."
    });
  }

  if (
    typeof record.targetProfileId !== "string" ||
    !UUID_PATTERN.test(record.targetProfileId)
  ) {
    errors.push({
      field: "targetProfileId",
      message: "targetProfileId must be a valid profile id."
    });
  }

  if (
    typeof record.sourceProfileId === "string" &&
    typeof record.targetProfileId === "string" &&
    record.sourceProfileId === record.targetProfileId
  ) {
    errors.push({
      field: "targetProfileId",
      message:
        "sourceProfileId and targetProfileId must not be the same profile."
    });
  }

  if (
    typeof record.reason !== "string" ||
    record.reason.trim().length === 0 ||
    record.reason.trim().length > MAX_REASON_LENGTH
  ) {
    errors.push({
      field: "reason",
      message: `reason is required and must be at most ${MAX_REASON_LENGTH} characters.`
    });
  }

  let duplicateCandidateId: string | null = null;

  if (
    record.duplicateCandidateId !== undefined &&
    record.duplicateCandidateId !== null
  ) {
    if (
      typeof record.duplicateCandidateId !== "string" ||
      !UUID_PATTERN.test(record.duplicateCandidateId)
    ) {
      errors.push({
        field: "duplicateCandidateId",
        message: "duplicateCandidateId must be a valid id."
      });
    } else {
      duplicateCandidateId = record.duplicateCandidateId;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      sourceProfileId: record.sourceProfileId as string,
      targetProfileId: record.targetProfileId as string,
      reason: (record.reason as string).trim(),
      duplicateCandidateId
    }
  };
}

export type MergeDecisionInput = {
  decision: "approved" | "rejected";
  reason: string | null;
};

export function validateMergeDecisionInput(
  body: unknown
): ValidationResult<MergeDecisionInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (
    typeof record.decision !== "string" ||
    !["approved", "rejected"].includes(record.decision)
  ) {
    errors.push({
      field: "decision",
      message: "decision must be one of: approved, rejected."
    });
  }

  let reason: string | null = null;

  if (record.reason !== undefined && record.reason !== null) {
    if (
      typeof record.reason !== "string" ||
      record.reason.trim().length > MAX_REASON_LENGTH
    ) {
      errors.push({
        field: "reason",
        message: `reason must be a string of at most ${MAX_REASON_LENGTH} characters.`
      });
    } else {
      reason = record.reason.trim() || null;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      decision: record.decision as "approved" | "rejected",
      reason
    }
  };
}
