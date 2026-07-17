import { recordAuditEvent } from "../../logging/application/audit-log";
import { applyConsumerEffectOnce } from "../application/consumer-effect";
import type { DomainEventConsumerDefinition } from "../domain/consumer-types";
import {
  SAMPLE_RECORDED_EVENT_TYPE,
  SAMPLE_RECORDED_EVENT_VERSION
} from "../domain/event-type-registry";

/**
 * Two representative consumers (Issue #742 scope: "Provide at least two
 * representative consumers: one same-process cross-module consumer; one
 * reporting/read-model projection consumer or test fixture"), both
 * registered against `SAMPLE_RECORDED_EVENT_TYPE` — the same
 * self-contained reference event `event-type-registry.ts` documents.
 *
 * A real consumer/producer module does NOT add its entry to this file
 * (Issue #826 — doing so is what created a live `domain_event_runtime <->
 * integration_hub` import cycle). It calls `registerDomainEventConsumer`
 * below from its own `infrastructure/domain-event-consumer-registration.ts`
 * instead; see that function's doc comment and
 * `integration-hub/infrastructure/domain-event-consumer-registration.ts`
 * for the worked example.
 */

const AUDIT_PROJECTOR_CONSUMER_NAME = "logging.sample_event_audit_projector";

/**
 * Same-process CROSS-MODULE consumer: reacts to a domain event by calling
 * `logging`'s own public `recordAuditEvent` function (the same
 * cross-module call ~10 other modules already make directly — audit
 * logging is foundational infrastructure, not a domain capability gated
 * behind a capability port per ADR-0011's port/adapter pattern, which is
 * reserved for DOMAIN capability boundaries like `blog_content` <->
 * `news_portal`). Demonstrates real cross-module collaboration driven
 * entirely by the dispatcher, with no direct import between a
 * hypothetical "event source" module and `logging` at the call-site that
 * raised the event.
 */
export const sampleAuditProjectorConsumer: DomainEventConsumerDefinition = {
  name: AUDIT_PROJECTOR_CONSUMER_NAME,
  description:
    "Reference same-process cross-module consumer — projects a sample.recorded domain event into the logging module's audit trail via recordAuditEvent (Issue #742).",
  eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
  eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
  handler: async (tx, event, ctx) => {
    await applyConsumerEffectOnce(
      tx,
      ctx.tenantId,
      AUDIT_PROJECTOR_CONSUMER_NAME,
      event.id,
      async () => {
        await recordAuditEvent(tx, {
          tenantId: ctx.tenantId,
          moduleKey: "domain_event_runtime",
          action: "domain_event_runtime.sample.audit_projected",
          resourceType: "domain_event",
          resourceId: event.id,
          severity: "info",
          message: `Sample domain event projected to audit trail (aggregate ${event.aggregateType}:${event.aggregateId}).`,
          attributes: { eventType: event.eventType },
          correlationId: ctx.correlationId
        });
      }
    );
  }
};

const ACTIVITY_ROLLUP_CONSUMER_NAME =
  "domain_event_runtime.activity_rollup_projector";

/**
 * Reporting/READ-MODEL PROJECTION consumer: maintains
 * `awcms_mini_domain_event_activity_daily`, a small denormalized rollup —
 * proof the dispatcher can drive a real read-optimized aggregate, without
 * touching the separate `reporting` module's own tables (no shared-table
 * write across module boundaries, ADR-0013 §6).
 */
export const activityRollupProjectorConsumer: DomainEventConsumerDefinition = {
  name: ACTIVITY_ROLLUP_CONSUMER_NAME,
  description:
    "Reference reporting/read-model projection consumer — maintains a per-tenant/day/event-type activity rollup (awcms_mini_domain_event_activity_daily) for operational dashboards (Issue #742).",
  eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
  eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
  handler: async (tx, event, ctx) => {
    await applyConsumerEffectOnce(
      tx,
      ctx.tenantId,
      ACTIVITY_ROLLUP_CONSUMER_NAME,
      event.id,
      async () => {
        const activityDate = event.occurredAt.toISOString().slice(0, 10);

        await tx`
            INSERT INTO awcms_mini_domain_event_activity_daily
              (tenant_id, activity_date, event_type, event_count)
            VALUES (${ctx.tenantId}, ${activityDate}, ${event.eventType}, 1)
            ON CONFLICT (tenant_id, activity_date, event_type)
            DO UPDATE SET
              event_count = awcms_mini_domain_event_activity_daily.event_count + 1,
              updated_at = now()
          `;
      }
    );
  }
};

/**
 * This runtime's OWN consumers only (Issue #826). A consumer owned by
 * ANOTHER module is never listed here and never imported by this file —
 * that module registers it itself via `registerDomainEventConsumer` below.
 * Two such consumers moved OUT of this array in #826:
 * `integration_hub`'s outbound fan-out (`integration-hub/infrastructure/
 * domain-event-consumer-registration.ts`) and `reporting`'s event-activity
 * projector (`reporting/infrastructure/domain-event-consumer-
 * registration.ts`).
 *
 * `logging` is the one cross-module import this file still makes
 * (`sampleAuditProjectorConsumer`'s `recordAuditEvent`) and is deliberately
 * kept: `logging` is foundational infrastructure BENEATH this runtime in
 * the layering (13 modules import it, it imports nothing back), so that
 * edge is one-directional by construction, is declared in `module.ts`'s
 * `dependencies`, and is not a plugin registration.
 */
const BASE_DOMAIN_EVENT_CONSUMERS: readonly DomainEventConsumerDefinition[] = [
  sampleAuditProjectorConsumer,
  activityRollupProjectorConsumer
];

/**
 * Consumers owned by OTHER modules, appended by
 * `registerDomainEventConsumer` below at import time of that module's own
 * registration file (Issue #826). Tracked SEPARATELY from
 * `BASE_DOMAIN_EVENT_CONSUMERS` so `resetDomainEventConsumersForTests`
 * can drop test-only fakes without also silently unregistering a REAL
 * cross-module consumer for the rest of the process — a reset that
 * restored only the base array would leave `integration_hub`'s outbound
 * fan-out permanently un-dispatched (its deliveries would sit `pending`
 * forever, since `dispatch-domain-events.ts` iterates registered
 * consumers, not delivery rows).
 */
let registeredConsumers: readonly DomainEventConsumerDefinition[] = [];

/**
 * The static consumer registry (Issue #742 scope: "a static consumer
 * registry owned by reviewed source code") — every REAL entry is still
 * added by reviewed source code, never a dynamic/database-driven
 * registration: this module's OWN consumers via
 * `BASE_DOMAIN_EVENT_CONSUMERS` above, and another module's via that
 * module's own reviewed `registerDomainEventConsumer` call (Issue #826).
 * `application/append-domain-event.ts` fans out delivery rows from this
 * list at PUBLISH time; `application/dispatch-domain-events.ts` iterates
 * it at DISPATCH time.
 *
 * `export let` (not `const`) so `registerDomainEventConsumer` and
 * `registerDomainEventConsumerForTests` below can append (the latter a
 * deliberately-failing fake consumer for a single test's duration —
 * retry/backoff/dead-letter scenarios need a handler that reliably
 * throws, which no real consumer ever does) — same registry SHAPE
 * `social-provider-registry.ts`'s `registerSocialProviderAdapter`/
 * `resetSocialProviderRegistryForTests` already established for
 * social_publishing's provider adapters. A reassignment here is a LIVE ES
 * module binding — every other module that imports
 * `DOMAIN_EVENT_CONSUMERS` (not a snapshot taken at import time) sees the
 * update.
 */
export let DOMAIN_EVENT_CONSUMERS: readonly DomainEventConsumerDefinition[] =
  BASE_DOMAIN_EVENT_CONSUMERS;

/**
 * The PRODUCTION registration entry point for a consumer owned by ANOTHER
 * module (Issue #826). Registration is INVERTED — the consumer's owning
 * module calls this from its own `infrastructure/domain-event-consumer-
 * registration.ts`; this runtime never imports a consumer module's code.
 *
 * Why (the actual defect #826 fixed): this file used to import
 * `integration-hub/application/outbound-fanout-consumer` directly, while
 * `integration_hub` legitimately and permanently imports THIS module back
 * (`appendDomainEvent` to publish, `event-type-registry` to validate — it
 * is a PLUGIN of this runtime). That made `domain_event_runtime <->
 * integration_hub` a real module-level import CYCLE. A capability port in
 * `_shared/ports/` could NOT have fixed it: a port only removes the
 * PLUGIN -> runtime type dependency, and here the plugin -> runtime edge
 * is a genuine value import (`appendDomainEvent`) that must stay. Only
 * removing the runtime -> plugin edge — i.e. this inversion — breaks it.
 * A `system`-type foundation module importing a feature module was the
 * layering violation underneath the cycle, not just an accident.
 *
 * Registering is idempotent by NAME: re-importing a registration module
 * (which is expected — several composition roots import the same one)
 * re-runs this call, and the second call is a no-op rather than a
 * duplicate registry entry that would double-fan-out every event at
 * publish time. A DIFFERENT definition claiming an already-registered
 * name is a programming error and throws loudly at import time — silently
 * letting one module hijack another's consumer name would repeat exactly
 * the "later entry silently wins" defect Issue #740/PR #769 shipped.
 */
export function registerDomainEventConsumer(
  consumer: DomainEventConsumerDefinition
): void {
  const existing = [
    ...BASE_DOMAIN_EVENT_CONSUMERS,
    ...registeredConsumers
  ].find((entry) => entry.name === consumer.name);

  if (existing) {
    if (existing.handler !== consumer.handler) {
      throw new Error(
        `Domain event consumer "${consumer.name}" is already registered with a different handler. ` +
          `Consumer names must be globally unique across modules — prefix the name with your own module key.`
      );
    }

    return;
  }

  registeredConsumers = [...registeredConsumers, consumer];
  DOMAIN_EVENT_CONSUMERS = [...DOMAIN_EVENT_CONSUMERS, consumer];
}

/**
 * Test-only. Undoes a `registerDomainEventConsumer` call by name.
 *
 * Needed because `registerDomainEventConsumer` is a PRODUCTION API writing
 * to a module-level singleton, and `bun test` shares module state across
 * every test file in the same process: a test that registers a fixture
 * consumer and relies on `resetDomainEventConsumersForTests` would leak it
 * into unrelated files, since that reset deliberately PRESERVES production
 * registrations. Exactly that leak was caught by
 * `domain-event-registry-parity.test.ts` while building #826 (a fixture's
 * `awcms-mini.test.fixture` event type surfaced in a different file's
 * assertion over `DOMAIN_EVENT_CONSUMERS`).
 *
 * Never called from production code — a real consumer is registered for the
 * life of the process.
 */
export function unregisterDomainEventConsumerForTests(name: string): void {
  registeredConsumers = registeredConsumers.filter(
    (entry) => entry.name !== name
  );
  DOMAIN_EVENT_CONSUMERS = DOMAIN_EVENT_CONSUMERS.filter(
    (entry) => entry.name !== name
  );
}

/** Test-only. Appends `consumer` to the registry for the remainder of the current test file/process — call `resetDomainEventConsumersForTests()` (typically in `afterEach`) to restore the base two real consumers. Never called from production code. */
export function registerDomainEventConsumerForTests(
  consumer: DomainEventConsumerDefinition
): void {
  DOMAIN_EVENT_CONSUMERS = [...DOMAIN_EVENT_CONSUMERS, consumer];
}

/**
 * Test-only. Drops every fake appended by
 * `registerDomainEventConsumerForTests`, restoring the registry to the
 * real, reviewed consumers — this module's own PLUS any cross-module
 * consumer registered via `registerDomainEventConsumer` (Issue #826).
 * Deliberately NOT `= BASE_DOMAIN_EVENT_CONSUMERS`: that would also
 * unregister the real cross-module consumers for the remainder of the
 * process, so whichever test ran next in the same file would silently see
 * an incomplete registry.
 */
export function resetDomainEventConsumersForTests(): void {
  DOMAIN_EVENT_CONSUMERS = [
    ...BASE_DOMAIN_EVENT_CONSUMERS,
    ...registeredConsumers
  ];
}

export function getConsumersForEventType(
  eventType: string
): readonly DomainEventConsumerDefinition[] {
  return DOMAIN_EVENT_CONSUMERS.filter((consumer) =>
    consumer.eventTypes.includes(eventType)
  );
}

export function getConsumerByName(
  name: string
): DomainEventConsumerDefinition | undefined {
  return DOMAIN_EVENT_CONSUMERS.find((consumer) => consumer.name === name);
}
