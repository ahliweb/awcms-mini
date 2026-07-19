/**
 * `service_catalog` offer-version lifecycle transitions (Issue #870, epic
 * #868, ADR-0022 §3/§11). Pure predicates — the application layer enforces
 * them, the DB triggers in sql/079 back them up. The state machine:
 *
 *   draft --publish--> published --retire--> retired --(archive)--> archived
 *
 * A `published` version is IMMUTABLE (edits are rejected; corrections are a
 * NEW draft version). Retiring a published offer leaves its projection row
 * readable ("existing published versions remain readable after newer versions
 * are published"). Archiving is the terminal state for a long-retired version.
 */
import type { OfferVersionStatus } from "./plan";

/** A draft version's content may be edited (features/quotas/prices/availability). */
export function canEditDraft(status: OfferVersionStatus): boolean {
  return status === "draft";
}

/** Only a draft version can be published. */
export function canPublish(status: OfferVersionStatus): boolean {
  return status === "draft";
}

/** Only a published version can be retired. */
export function canRetire(status: OfferVersionStatus): boolean {
  return status === "published";
}

/** Only a retired version can be archived (terminal). */
export function canArchive(status: OfferVersionStatus): boolean {
  return status === "retired";
}

export type LifecycleTransitionError =
  | { code: "NOT_DRAFT"; message: string }
  | { code: "NOT_PUBLISHED"; message: string }
  | { code: "NOT_RETIRED"; message: string };

export function assertPublishable(
  status: OfferVersionStatus
): LifecycleTransitionError | null {
  return canPublish(status)
    ? null
    : {
        code: "NOT_DRAFT",
        message: `Only a draft version can be published (this version is "${status}"). Corrections require a new version.`
      };
}

export function assertRetirable(
  status: OfferVersionStatus
): LifecycleTransitionError | null {
  return canRetire(status)
    ? null
    : {
        code: "NOT_PUBLISHED",
        message: `Only a published version can be retired (this version is "${status}").`
      };
}
