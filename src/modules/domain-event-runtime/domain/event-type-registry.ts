/**
 * The versioned catalog of event types this runtime is aware of (Issue
 * #742 acceptance criterion: "Runtime registry and AsyncAPI event
 * types/versions pass bidirectional parity checks"). `appendDomainEvent`
 * (`application/append-domain-event.ts`) REFUSES to persist an event whose
 * `(eventType, eventVersion)` is not listed here — this is the mechanism
 * (not just documentation) that stops "event types/versions silently
 * drifting" from the published AsyncAPI contract: a new/changed event type
 * must be added HERE first (reviewed source code), which
 * `tests/unit/domain-event-registry-parity.test.ts` then cross-checks
 * against `asyncapi/awcms-mini-domain-events.asyncapi.yaml` in both
 * directions (registry entry without a channel = fail; a channel this
 * runtime's own consumer registry subscribes to without a matching entry
 * here = fail). `module.ts`'s `events.publishes` array (checked by the
 * existing generic `checkModuleEventChannels`,
 * `scripts/api-spec-check.ts`, already part of `bun run check`) covers the
 * SAME direction for the module-descriptor surface every other module
 * already uses — this registry is the finer-grained, runtime-specific
 * complement scoped to events that actually flow through THIS dispatcher.
 *
 * Scope note: this issue ships exactly one registered event type — a
 * self-contained reference/example (`sample.recorded`) used to exercise
 * and prove the outbox/dispatcher/ordering/retry/DLQ/replay mechanism
 * end-to-end, mirroring the accepted "foundation issue ships zero real
 * business integrations" precedent (#643 shipped zero real provider
 * adapters; PR #713 migrated 2 of 8 scripts as proof-of-concept). Future
 * producer modules add their OWN entries here (and their own
 * `module.ts` `events.publishes` entries, and their own AsyncAPI
 * channels) when they start calling `appendDomainEvent` — deliberately
 * NOT done in this PR to keep this foundation issue's blast radius
 * confined to its own module (AGENTS.md rule #1, Atomic).
 */
export type RegisteredDomainEventType = {
  eventType: string;
  eventVersion: string;
  description: string;
};

export const SAMPLE_RECORDED_EVENT_TYPE =
  "awcms-mini.domain-event-runtime.sample.recorded";
export const SAMPLE_RECORDED_EVENT_VERSION = "1.0";

export const DOMAIN_EVENT_TYPE_REGISTRY: readonly RegisteredDomainEventType[] =
  [
    {
      eventType: SAMPLE_RECORDED_EVENT_TYPE,
      eventVersion: SAMPLE_RECORDED_EVENT_VERSION,
      description:
        "Reference/example event type used to exercise the domain-event-runtime outbox, dispatcher, ordering, retry/backoff, dead-letter, and replay mechanism end-to-end (Issue #742). Real producer modules publish their OWN event types the same way, via appendDomainEvent — this one is intentionally self-contained rather than tied to another module's business logic in this foundation issue."
    },
    // Issue #748 (profile_identity, epic #738 platform-evolution Wave 2) —
    // the first REAL (non-reference) producer registered here. Literal
    // strings match `profile-identity/domain/merge-event.ts`'s
    // `PROFILE_MERGED_EVENT_TYPE`/`PROFILE_MERGED_EVENT_VERSION` constants
    // (kept in sync by convention, not by cross-module import — see that
    // file's own header comment).
    {
      eventType: "awcms-mini.profile-identity.profile.merged",
      eventVersion: "1.0",
      description:
        "Published when a profile merge request is executed: the loser profile is soft-deleted (merged_into_profile_id set) and its awcms_mini_profile_entity_links rows are repointed to the survivor. Lets domain modules react to the merge mapping without importing profile-identity tables directly (see _shared/ports/party-directory-port.ts for the pull-based equivalent)."
    }
  ];

export function isRegisteredDomainEventType(
  eventType: string,
  eventVersion: string
): boolean {
  return DOMAIN_EVENT_TYPE_REGISTRY.some(
    (entry) =>
      entry.eventType === eventType && entry.eventVersion === eventVersion
  );
}
