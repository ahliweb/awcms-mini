/**
 * `integration_hub`'s own `domain_event_runtime` consumer registration
 * (Issue #826) — the module that OWNS a consumer registers it, rather
 * than the runtime importing the consumer's code.
 *
 * This file exists to break a real module-level import cycle. Until Issue
 * #826, `domain-event-runtime/infrastructure/consumer-registry.ts`
 * imported `../application/outbound-fanout-consumer` directly, while this
 * module imports `domain_event_runtime` back for genuine, permanent
 * reasons (`appendDomainEvent` in `application/inbound-webhook-intake.ts`,
 * `isRegisteredDomainEventType` in `application/subscription-directory.ts`
 * — `integration_hub` is a PLUGIN of that runtime). Two modules importing
 * each other's `application` code is the exact disease Issue #681 fixed
 * for `blog_content`/`news_portal`; the direction removed here is the
 * runtime's, because the plugin's direction is the correct one and cannot
 * go away.
 *
 * Importing this file has a SIDE EFFECT (the `registerDomainEventConsumer`
 * call below) — that is its entire purpose, so it must be imported for the
 * side effect, never for a value. It is idempotent (see
 * `registerDomainEventConsumer`'s own doc comment): every composition root
 * that could publish, dispatch, or replay this consumer's event imports
 * it, and several do so in the same process.
 *
 * The composition roots that MUST import this file — enforced by
 * `tests/unit/domain-event-consumer-registration-wiring.test.ts`, because
 * a missed one FAILS SILENTLY (`dispatch-domain-events.ts` iterates
 * REGISTERED CONSUMERS, so an unregistered consumer's deliveries are never
 * claimed at all — they sit `pending` forever with no error, no
 * dead-letter, and no log line):
 *
 * 1. `application/inbound-webhook-intake.ts` — PUBLISH side. The only
 *    producer of `integration_hub.inbound_message.normalized` anywhere in
 *    the repo, and `appendDomainEvent` creates delivery rows from the
 *    registry at publish time; an unregistered consumer would mean zero
 *    delivery rows are ever created for an event that did happen.
 * 2. `scripts/domain-events-dispatch.ts` — DISPATCH side (`bun run
 *    domain-events:dispatch`, a separate process that imports none of the
 *    above).
 * 3. `src/pages/api/v1/domain-events/deliveries/[id]/replay.ts` — REPLAY
 *    side (`getConsumerByName`; unlike dispatch this one at least fails
 *    loudly, via `UnknownReplayConsumerError`).
 */
import { registerDomainEventConsumer } from "../../domain-event-runtime/infrastructure/consumer-registry";
import {
  INTEGRATION_HUB_EVENT_VERSION,
  INTEGRATION_HUB_INBOUND_MESSAGE_NORMALIZED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import {
  handleOutboundFanout,
  INTEGRATION_HUB_OUTBOUND_FANOUT_CONSUMER_NAME
} from "../application/outbound-fanout-consumer";

/**
 * `integration_hub`'s real (non-reference) consumer (Issue #754, epic
 * `platform-evolution` #738 Wave 3) — fans a normalized inbound webhook
 * message out to every matching outbound subscription. See
 * `application/outbound-fanout-consumer.ts`'s own doc comment for the full
 * design (same-process, DB-only handler; the real HTTP delivery happens
 * later, outside any transaction, via a separate worker job).
 */
export const integrationHubOutboundFanoutConsumer = {
  name: INTEGRATION_HUB_OUTBOUND_FANOUT_CONSUMER_NAME,
  description:
    "Fans a normalized integration_hub inbound-message event out to every active outbound subscription matching its event type (creates pending awcms_mini_integration_outbound_deliveries rows; the real HTTP delivery happens later via bun run integration-hub:outbound:dispatch, Issue #754).",
  eventTypes: [INTEGRATION_HUB_INBOUND_MESSAGE_NORMALIZED_EVENT_TYPE],
  eventVersions: [INTEGRATION_HUB_EVENT_VERSION],
  handler: handleOutboundFanout
};

registerDomainEventConsumer(integrationHubOutboundFanoutConsumer);
