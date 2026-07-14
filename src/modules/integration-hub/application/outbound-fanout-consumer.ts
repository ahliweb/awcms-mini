import { applyConsumerEffectOnce } from "../../domain-event-runtime/application/consumer-effect";
import type { DomainEventConsumerHandler } from "../../domain-event-runtime/domain/consumer-types";
import {
  matchesSubscriptionFilter,
  validateSubscriptionFilter,
  type SubscriptionFilter
} from "../domain/subscription-filter";

/**
 * `integration_hub`'s real `domain_event_runtime` CONSUMER (Issue #754) —
 * registered into `domain-event-runtime/infrastructure/consumer-
 * registry.ts`'s static array (the designated additive extension point;
 * mirrors how `workflow_approval`/`organization_structure` became real
 * PRODUCERS by editing `event-type-registry.ts`). Runs inside the SAME
 * transaction as the source event's own commit (same-process, DB-only
 * handler — ADR-0006/#742-compliant: this function makes ZERO network
 * calls, only plain DB writes). It fans an internal event out to every
 * ACTIVE outbound subscription matching that event type by creating a
 * `pending` `awcms_mini_integration_outbound_deliveries` row per match —
 * the REAL HTTP delivery to each subscriber's `target_url` happens LATER,
 * strictly OUTSIDE any transaction, via the separate `bun run
 * integration-hub:outbound:dispatch` worker job
 * (`application/outbound-dispatch.ts`). This is the concrete mechanism
 * behind Issue #754's "Dispatch outbound delivery after source commit
 * through #742/shared workers" requirement — no in-transaction network
 * call is possible from this file (it does not import `fetch`/any HTTP
 * client at all).
 *
 * `applyConsumerEffectOnce` gives this handler event-ID-keyed idempotency
 * (redelivery of the SAME event to THIS consumer can never create a
 * second batch of outbound-delivery rows), and the partial unique index
 * on `awcms_mini_integration_outbound_deliveries` itself
 * (`(tenant_id, subscription_id, source_event_id) WHERE replay_of_
 * delivery_id IS NULL`) is a second, independent, DB-enforced dedup layer
 * — the same defense-in-depth shape `appendDomainEvent`'s own delivery
 * fan-out already uses (`ON CONFLICT ... DO NOTHING`).
 */
export const INTEGRATION_HUB_OUTBOUND_FANOUT_CONSUMER_NAME =
  "integration_hub.outbound_subscription_fanout";

type SubscriptionRow = {
  id: string;
  max_attempts: number;
  filter: SubscriptionFilter | null;
};

export const handleOutboundFanout: DomainEventConsumerHandler = async (
  tx,
  event,
  ctx
) => {
  await applyConsumerEffectOnce(
    tx,
    ctx.tenantId,
    INTEGRATION_HUB_OUTBOUND_FANOUT_CONSUMER_NAME,
    event.id,
    async () => {
      const subscriptions = (await tx`
        SELECT id, max_attempts, filter
        FROM awcms_mini_integration_subscriptions
        WHERE tenant_id = ${ctx.tenantId}
          AND subscribed_event_type = ${event.eventType}
          AND status = 'active'
          AND deleted_at IS NULL
      `) as SubscriptionRow[];

      for (const subscription of subscriptions) {
        const filter = subscription.filter ?? {};

        if (Object.keys(filter).length > 0) {
          const validation = validateSubscriptionFilter(filter);

          if (
            !validation.ok ||
            !matchesSubscriptionFilter(event.payload, filter)
          ) {
            continue;
          }
        }

        await tx`
          INSERT INTO awcms_mini_integration_outbound_deliveries
            (tenant_id, subscription_id, source_event_id, event_type, max_attempts, correlation_id)
          VALUES (
            ${ctx.tenantId}, ${subscription.id}, ${event.id}, ${event.eventType},
            ${subscription.max_attempts}, ${ctx.correlationId}
          )
          ON CONFLICT (tenant_id, subscription_id, source_event_id) WHERE replay_of_delivery_id IS NULL
          DO NOTHING
        `;
      }
    }
  );
};
