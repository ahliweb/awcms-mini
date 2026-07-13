import { recordAuditEvent } from "../../logging/application/audit-log";
import { recordCounter } from "../../../lib/observability/metrics-port";
import {
  buildIdentifierMatchReason,
  combineMatchBasis,
  evaluateNameSimilarityMatch,
  orderProfilePair,
  type MatchBasis,
  type MatchReason
} from "../domain/duplicate-detection";

const AUDIT_MODULE_KEY = "profile_identity";
const AUDIT_RESOURCE_TYPE = "profile_duplicate_candidate";

export type DuplicateCandidateView = {
  id: string;
  profileIdA: string;
  profileIdB: string;
  matchBasis: MatchBasis;
  matchScore: number | null;
  matchReasons: MatchReason[];
  status: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
  updatedAt: string;
};

type DuplicateCandidateRow = {
  id: string;
  profile_id_a: string;
  profile_id_b: string;
  match_basis: MatchBasis;
  match_score: string | null;
  match_reasons: unknown;
  status: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  created_at: Date;
  updated_at: Date;
};

function toView(row: DuplicateCandidateRow): DuplicateCandidateView {
  return {
    id: row.id,
    profileIdA: row.profile_id_a,
    profileIdB: row.profile_id_b,
    matchBasis: row.match_basis,
    matchScore: row.match_score !== null ? Number(row.match_score) : null,
    matchReasons: Array.isArray(row.match_reasons)
      ? (row.match_reasons as MatchReason[])
      : [],
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
    reviewNotes: row.review_notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

type CandidateInput = {
  otherProfileId: string;
  matchBasis: MatchBasis;
  matchScore: number;
  matchReasons: MatchReason[];
};

async function upsertCandidate(
  tx: Bun.SQL,
  tenantId: string,
  profileId: string,
  candidate: CandidateInput
): Promise<void> {
  const { profileIdA, profileIdB } = orderProfilePair(
    profileId,
    candidate.otherProfileId
  );

  await tx`
    INSERT INTO awcms_mini_profile_duplicate_candidates
      (tenant_id, profile_id_a, profile_id_b, match_basis, match_score, match_reasons)
    VALUES (
      ${tenantId}, ${profileIdA}, ${profileIdB}, ${candidate.matchBasis},
      ${candidate.matchScore}, ${JSON.stringify(candidate.matchReasons)}::jsonb
    )
    ON CONFLICT (tenant_id, profile_id_a, profile_id_b) DO UPDATE SET
      match_basis = EXCLUDED.match_basis,
      match_score = EXCLUDED.match_score,
      match_reasons = EXCLUDED.match_reasons,
      updated_at = now()
    WHERE awcms_mini_profile_duplicate_candidates.status = 'pending'
  `;
}

type ProfileForMatching = {
  id: string;
  display_name: string;
};

type IdentifierMatchRow = {
  other_profile_id: string;
  identifier_type: string;
};

/**
 * On-demand duplicate-candidate scan for ONE profile against every other
 * active profile in the SAME tenant (Issue #748). Deliberately on-demand
 * (triggered by `POST .../duplicate-candidates/scan`, `analyze` guard),
 * not a scheduled worker job — this base has no existing case needing
 * cross-tenant background scanning for this feature, and keeping it
 * request-scoped avoids adding a new `awcms_mini_worker` grant/role
 * surface for this issue. Simple O(n) name-similarity comparison against
 * every other active profile — acceptable at this issue's scope (no
 * pagination/batching), matching the "kept intentionally simple" search
 * precedent `party-directory.ts` documents.
 *
 * A `not_duplicate` decision on an existing pending-vs-reviewed candidate
 * sticks: `upsertCandidate`'s `ON CONFLICT ... WHERE status = 'pending'`
 * never overwrites an already-reviewed row.
 *
 * The deterministic-identifier match intentionally compares this profile's
 * ACTIVE identifiers against every OTHER identifier for a different profile
 * REGARDLESS of that other row's `deleted_at` (only `mine.deleted_at IS
 * NULL` is required, not `other.deleted_at IS NULL`) — migration 003's own
 * partial unique index (`tenant_id, identifier_type, value_hash WHERE
 * deleted_at IS NULL`) already makes it impossible for two ACTIVE
 * identifiers on two different profiles to ever share the same normalized
 * value in the first place (the create endpoint returns `409
 * IDENTIFIER_ALREADY_EXISTS` before that could happen). The only
 * historically-reachable "same value, different profile" case is exactly
 * a SOFT-DELETED identifier on one side — still meaningful duplicate
 * evidence (e.g. an operator removed a wrongly-entered identifier from one
 * profile after noticing another profile already claims it), so this scan
 * intentionally still surfaces it rather than silently ignoring the only
 * case its own dedup constraint leaves reachable.
 */
export async function generateDuplicateCandidatesForProfile(
  tx: Bun.SQL,
  tenantId: string,
  profileId: string
): Promise<{ candidatesConsidered: number }> {
  const profileRows = (await tx`
    SELECT id, display_name FROM awcms_mini_profiles
    WHERE tenant_id = ${tenantId} AND id = ${profileId} AND deleted_at IS NULL
  `) as ProfileForMatching[];
  const profile = profileRows[0];

  if (!profile) {
    return { candidatesConsidered: 0 };
  }

  // PR #777 review follow-up: also require the COUNTERPART profile itself
  // to be active (`other_profile.deleted_at IS NULL`) — without this, a
  // profile that is already a dead loser from a PREVIOUS merge (soft-
  // deleted, `merged_into_profile_id` set) could still surface as a
  // "duplicate candidate" for a third profile purely because its now-
  // orphaned identifier row happens to share a value with one from a
  // still-earlier soft delete. Not exploitable either way (merge
  // creation/execution both independently reject a non-active profile),
  // but a real, avoidable source of noisy/misleading candidates.
  const deterministicMatchRows = (await tx`
    SELECT DISTINCT other.profile_id AS other_profile_id, other.identifier_type
    FROM awcms_mini_profile_identifiers AS mine
    JOIN awcms_mini_profile_identifiers AS other
      ON other.tenant_id = mine.tenant_id
      AND other.identifier_type = mine.identifier_type
      AND other.value_hash = mine.value_hash
      AND other.profile_id <> mine.profile_id
    JOIN awcms_mini_profiles AS other_profile
      ON other_profile.tenant_id = other.tenant_id
      AND other_profile.id = other.profile_id
      AND other_profile.deleted_at IS NULL
    WHERE mine.tenant_id = ${tenantId} AND mine.profile_id = ${profileId}
      AND mine.deleted_at IS NULL
  `) as IdentifierMatchRow[];

  const deterministicByProfile = new Map<string, MatchReason[]>();

  for (const row of deterministicMatchRows) {
    const match = buildIdentifierMatchReason(row.identifier_type);
    const existingReasons =
      deterministicByProfile.get(row.other_profile_id) ?? [];
    deterministicByProfile.set(row.other_profile_id, [
      ...existingReasons,
      ...match.reasons
    ]);
  }

  const otherProfileRows = (await tx`
    SELECT id, display_name FROM awcms_mini_profiles
    WHERE tenant_id = ${tenantId} AND id <> ${profileId} AND deleted_at IS NULL
  `) as ProfileForMatching[];

  const candidatesById = new Map<string, CandidateInput>();

  for (const other of otherProfileRows) {
    const nameMatch = evaluateNameSimilarityMatch(
      profile.display_name,
      other.display_name
    );
    const deterministicReasons = deterministicByProfile.get(other.id);
    const hasDeterministicMatch = deterministicReasons !== undefined;
    const hasNameSimilarityMatch = nameMatch !== null;

    if (!hasDeterministicMatch && !hasNameSimilarityMatch) {
      continue;
    }

    const reasons: MatchReason[] = [
      ...(deterministicReasons ?? []),
      ...(nameMatch ? nameMatch.reasons : [])
    ];
    const score = hasDeterministicMatch ? 1 : (nameMatch?.score ?? 0);

    candidatesById.set(other.id, {
      otherProfileId: other.id,
      matchBasis: combineMatchBasis(
        hasDeterministicMatch,
        hasNameSimilarityMatch
      ),
      matchScore: score,
      matchReasons: reasons
    });
  }

  // Deterministic matches for profiles NOT already visited above (e.g. a
  // profile with a shared identifier but a very different display name).
  for (const [otherProfileId, reasons] of deterministicByProfile) {
    if (candidatesById.has(otherProfileId)) {
      continue;
    }

    candidatesById.set(otherProfileId, {
      otherProfileId,
      matchBasis: "deterministic_identifier",
      matchScore: 1,
      matchReasons: reasons
    });
  }

  for (const candidate of candidatesById.values()) {
    await upsertCandidate(tx, tenantId, profileId, candidate);
    recordCounter("profile_identity_duplicate_candidate_total", {
      matchBasis: candidate.matchBasis,
      status: "pending"
    });
  }

  return { candidatesConsidered: candidatesById.size };
}

export async function listDuplicateCandidates(
  tx: Bun.SQL,
  tenantId: string,
  options: { status?: string; profileId?: string } = {}
): Promise<DuplicateCandidateView[]> {
  const status = options.status ?? null;
  const profileId = options.profileId ?? null;

  const rows = (await tx`
    SELECT id, profile_id_a, profile_id_b, match_basis, match_score, match_reasons,
      status, reviewed_by, reviewed_at, review_notes, created_at, updated_at
    FROM awcms_mini_profile_duplicate_candidates
    WHERE tenant_id = ${tenantId}
      AND (${status}::text IS NULL OR status = ${status})
      AND (${profileId}::uuid IS NULL OR profile_id_a = ${profileId} OR profile_id_b = ${profileId})
    ORDER BY created_at DESC
  `) as DuplicateCandidateRow[];

  return rows.map(toView);
}

export async function fetchDuplicateCandidateById(
  tx: Bun.SQL,
  tenantId: string,
  candidateId: string
): Promise<DuplicateCandidateView | null> {
  const rows = (await tx`
    SELECT id, profile_id_a, profile_id_b, match_basis, match_score, match_reasons,
      status, reviewed_by, reviewed_at, review_notes, created_at, updated_at
    FROM awcms_mini_profile_duplicate_candidates
    WHERE tenant_id = ${tenantId} AND id = ${candidateId}
  `) as DuplicateCandidateRow[];

  const row = rows[0];
  return row ? toView(row) : null;
}

export async function reviewDuplicateCandidate(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  candidateId: string,
  decision: "confirmed_duplicate" | "not_duplicate",
  notes: string | null,
  correlationId?: string
): Promise<DuplicateCandidateView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_profile_duplicate_candidates
    SET status = ${decision}, reviewed_by = ${actorTenantUserId}, reviewed_at = now(),
        review_notes = ${notes}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${candidateId} AND status = 'pending'
    RETURNING id, profile_id_a, profile_id_b, match_basis, match_score, match_reasons,
      status, reviewed_by, reviewed_at, review_notes, created_at, updated_at
  `) as DuplicateCandidateRow[];

  const row = rows[0];

  if (!row) {
    return null;
  }

  const view = toView(row);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "duplicate_candidate_reviewed",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: view.id,
    severity: "info",
    message: `Duplicate candidate reviewed: ${decision}.`,
    attributes: { decision },
    correlationId
  });

  recordCounter("profile_identity_duplicate_candidate_total", {
    matchBasis: view.matchBasis,
    status: decision
  });

  return view;
}
