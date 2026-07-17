/**
 * `reporting`'s own `domain_event_runtime` consumer registration (Issue
 * #826) — the module that OWNS a consumer registers it, rather than the
 * runtime importing the consumer's code.
 *
 * Moved here from `domain-event-runtime/infrastructure/consumer-registry.ts`
 * (where Issue #753 originally put it). That placement was never an import
 * CYCLE — `reporting` genuinely imports nothing from `domain_event_runtime`
 * in its `application`/`domain` trees, exactly as that file's comment
 * claimed — but it WAS a real contradiction that only surfaced once #826
 * made declarations match imports: `reporting/module.ts` deliberately
 * declares `domain_event_runtime` as "a genuine lifecycle-ordering
 * dependency", while the source-level import ran the OPPOSITE way
 * (`domain_event_runtime` -> `reporting`). Declaring what the code actually
 * did would have made `bun run modules:dag:check` fail with a real
 * `reporting -> domain_event_runtime -> reporting` cycle. Inverting the
 * registration resolves it in the direction that was already documented as
 * correct: `reporting` depends on the runtime, never the reverse.
 *
 * Importing this file has a SIDE EFFECT (the `registerDomainEventConsumer`
 * call below) — that is its entire purpose, so it must be imported for the
 * side effect, never for a value. It is idempotent; see
 * `registerDomainEventConsumer`'s own doc comment, and
 * `integration-hub/infrastructure/domain-event-consumer-registration.ts`
 * for the full description of which composition roots must import it and
 * why a missed one fails silently.
 */
import { applyConsumerEffectOnce } from "../../domain-event-runtime/application/consumer-effect";
import type { DomainEventConsumerDefinition } from "../../domain-event-runtime/domain/consumer-types";
import {
  SAMPLE_RECORDED_EVENT_TYPE,
  SAMPLE_RECORDED_EVENT_VERSION
} from "../../domain-event-runtime/domain/event-type-registry";
import { registerDomainEventConsumer } from "../../domain-event-runtime/infrastructure/consumer-registry";
import { applyEventActivityProjectionIncrement } from "../application/event-activity-projection";
import { EVENT_ACTIVITY_PROJECTOR_CONSUMER_NAME } from "../domain/projection-keys";

/**
 * REAL cross-module consumer (Issue #753, epic #738 platform-evolution
 * Wave 3 — the first non-reference, genuinely-used consumer): projects
 * `sample.recorded` events into this module's own
 * `awcms_mini_reporting_event_activity_summary` projection metric via
 * `applyEventActivityProjectionIncrement`.
 *
 * Idempotency: `applyConsumerEffectOnce` (the runtime's own, reused
 * unchanged) guards against a redelivered event double-incrementing the
 * counter — the same mechanism the runtime's own reference consumers use.
 * `applyEventActivityProjectionIncrement` ADDITIONALLY skips entirely
 * while a rebuild owns this projection (mutual exclusion with
 * `application/projection-rebuild.ts` — see that file's header comment §3
 * for why this is safe against double-counting).
 */
export const eventActivityProjectorConsumer: DomainEventConsumerDefinition = {
  name: EVENT_ACTIVITY_PROJECTOR_CONSUMER_NAME,
  description:
    "reporting module consumer — projects a sample.recorded domain event into awcms_mini_reporting_projection_metrics' reporting.event_activity_summary/sample_recorded_count counter (Issue #753).",
  eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
  eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
  handler: async (tx, event, ctx) => {
    await applyConsumerEffectOnce(
      tx,
      ctx.tenantId,
      EVENT_ACTIVITY_PROJECTOR_CONSUMER_NAME,
      event.id,
      () =>
        applyEventActivityProjectionIncrement(
          tx,
          ctx.tenantId,
          event.occurredAt
        )
    );
  }
};

registerDomainEventConsumer(eventActivityProjectorConsumer);
