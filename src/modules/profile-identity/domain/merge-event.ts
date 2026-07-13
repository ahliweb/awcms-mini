/**
 * Domain event this module publishes through the shared `domain_event_runtime`
 * outbox (Issue #742) when a profile merge is executed — lets domain modules
 * that hold an `awcms_mini_profile_entity_links` reference (or any other
 * future reference to a profile id) react to a merge mapping WITHOUT
 * polling/importing profile-identity tables directly. `PartyDirectoryPort`
 * (`_shared/ports/party-directory-port.ts`) is the PULL-based equivalent
 * ("what is the current survivor for this profile id, right now") — this
 * event is the PUSH-based complement for a consumer that wants to react at
 * the moment a merge happens (e.g. update its own denormalized cache).
 *
 * Kept as this module's OWN local literal constants (not imported from
 * `domain_event_runtime`, and not re-exported the other way either) — same
 * "producer declares its own event type" pattern that module's own README
 * documents; `domain-event-runtime/domain/event-type-registry.ts`'s
 * `DOMAIN_EVENT_TYPE_REGISTRY` entry uses the SAME literal strings,
 * kept in sync by convention (this is a one-directional import, profile_identity
 * -> domain_event_runtime, which `tests/unit/module-boundary-cycles.test.ts`
 * permits — only bidirectional cycles are forbidden).
 */
export const PROFILE_MERGED_EVENT_TYPE =
  "awcms-mini.profile-identity.profile.merged";
export const PROFILE_MERGED_EVENT_VERSION = "1.0";

export type ProfileMergedEventPayload = {
  mergeRequestId: string;
  survivorProfileId: string;
  loserProfileId: string;
  entityLinksRepointedCount: number;
};
