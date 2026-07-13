/**
 * Duplicate-candidate matching heuristics (Issue #748). Two independent
 * bases for a match, both explainable (a list of concrete matched
 * reasons, never a bare opaque score) and NEVER auto-merging anything —
 * a candidate is only ever an input a human reviews via
 * `POST /profiles/duplicate-candidates/{id}/review`, never a trigger that
 * merges by itself (issue acceptance criterion: "never auto-merge solely
 * from a heuristic score").
 *
 * - `deterministic_identifier` — two profiles share the SAME normalized
 *   identifier value (reuses `domain/identifier.ts`'s `hashIdentifier`,
 *   never a separate matching algorithm) — effectively certain (score
 *   1.0), but still only a candidate, still still reviewable/rejectable.
 * - `heuristic_name_similarity` — `display_name`/`legal_name` token
 *   overlap (Dice/Sorensen coefficient over normalized tokens) — a soft
 *   signal, explicitly probabilistic, never certain.
 */
export type MatchBasis =
  | "deterministic_identifier"
  | "heuristic_name_similarity"
  | "heuristic_combined";

export type MatchReason = {
  field: string;
  reason: string;
  detail: string;
};

const NAME_SIMILARITY_THRESHOLD = 0.6;

export function normalizeNameForSimilarity(rawName: string): string {
  return rawName
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenBigrams(value: string): Set<string> {
  const bigrams = new Set<string>();

  for (let index = 0; index < value.length - 1; index += 1) {
    bigrams.add(value.slice(index, index + 2));
  }

  return bigrams;
}

/** Sorensen-Dice coefficient over character bigrams — a simple, dependency-free, deterministic string-similarity measure appropriate for short display names (no external NLP/ML library, matching this repo's Bun-only/no-heavy-dependency convention). Returns a value in [0, 1]. */
export function nameSimilarityScore(nameA: string, nameB: string): number {
  const normalizedA = normalizeNameForSimilarity(nameA);
  const normalizedB = normalizeNameForSimilarity(nameB);

  if (normalizedA.length === 0 || normalizedB.length === 0) {
    return 0;
  }

  if (normalizedA === normalizedB) {
    return 1;
  }

  const bigramsA = tokenBigrams(normalizedA);
  const bigramsB = tokenBigrams(normalizedB);

  if (bigramsA.size === 0 || bigramsB.size === 0) {
    return 0;
  }

  let intersectionCount = 0;

  for (const bigram of bigramsA) {
    if (bigramsB.has(bigram)) {
      intersectionCount += 1;
    }
  }

  return (2 * intersectionCount) / (bigramsA.size + bigramsB.size);
}

export type NameSimilarityMatch = {
  basis: "heuristic_name_similarity";
  score: number;
  reasons: MatchReason[];
} | null;

/** `null` if the score is below the reviewable threshold — a low-confidence pair is never even surfaced as a candidate, not just soft-scored. */
export function evaluateNameSimilarityMatch(
  displayNameA: string,
  displayNameB: string
): NameSimilarityMatch {
  const score = nameSimilarityScore(displayNameA, displayNameB);

  if (score < NAME_SIMILARITY_THRESHOLD) {
    return null;
  }

  return {
    basis: "heuristic_name_similarity",
    score: Math.round(score * 10000) / 10000,
    reasons: [
      {
        field: "displayName",
        reason: "name_similarity",
        detail: `"${displayNameA}" vs "${displayNameB}" scored ${(score * 100).toFixed(1)}% bigram similarity (threshold ${(NAME_SIMILARITY_THRESHOLD * 100).toFixed(0)}%).`
      }
    ]
  };
}

export type IdentifierMatch = {
  basis: "deterministic_identifier";
  score: 1;
  reasons: MatchReason[];
};

/** Certain match: both profiles have a non-deleted identifier of the SAME type with the SAME `value_hash`. `identifierType` is included for explainability but the raw value never is (only the type — dedup key comparison already happened in SQL against the hash, this is purely for the explanation text). */
export function buildIdentifierMatchReason(
  identifierType: string
): IdentifierMatch {
  return {
    basis: "deterministic_identifier",
    score: 1,
    reasons: [
      {
        field: "identifier",
        reason: "shared_identifier_value",
        detail: `Both profiles have a "${identifierType}" identifier with the same normalized value.`
      }
    ]
  };
}

export function combineMatchBasis(
  hasDeterministicMatch: boolean,
  hasNameSimilarityMatch: boolean
): MatchBasis {
  if (hasDeterministicMatch && hasNameSimilarityMatch) {
    return "heuristic_combined";
  }

  return hasDeterministicMatch
    ? "deterministic_identifier"
    : "heuristic_name_similarity";
}

/** Orders a pair of profile ids so `(a, b)` is stored consistently regardless of which one was scanned first — matches migration 059's `profile_id_a < profile_id_b` `CHECK` constraint. */
export function orderProfilePair(
  profileIdOne: string,
  profileIdTwo: string
): { profileIdA: string; profileIdB: string } {
  return profileIdOne < profileIdTwo
    ? { profileIdA: profileIdOne, profileIdB: profileIdTwo }
    : { profileIdA: profileIdTwo, profileIdB: profileIdOne };
}
