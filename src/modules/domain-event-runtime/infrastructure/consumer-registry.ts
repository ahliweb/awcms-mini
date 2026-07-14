import { recordAuditEvent } from "../../logging/application/audit-log";
import { applyEventActivityProjectionIncrement } from "../../reporting/application/event-activity-projection";
import { EVENT_ACTIVITY_PROJECTOR_CONSUMER_NAME } from "../../reporting/domain/projection-keys";
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
 * Real producer/consumer modules register their OWN entries here when
 * they start using this runtime (deliberately not done for any existing
 * module in this foundation issue — see that file's scope note).
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
 * REAL cross-module consumer (Issue #753, epic #738 platform-evolution
 * Wave 3 — the first non-reference, genuinely-used consumer registered in
 * this file): projects `sample.recorded` events into `reporting`'s own
 * `awcms_mini_reporting_event_activity_summary` projection metric via
 * `applyEventActivityProjectionIncrement`. This IS the one cross-module
 * edge that wires `domain_event_runtime` -> `reporting/application` — safe
 * against `tests/unit/module-boundary-cycles.test.ts` because
 * `reporting`'s own `application`/`domain` files import nothing back from
 * `domain_event_runtime` (its rebuild path reads
 * `awcms_mini_domain_events` via a plain SQL table name, never a
 * cross-module TypeScript import — see `reporting/application/
 * projection-rebuild.ts`'s header comment), so no cycle exists.
 *
 * Idempotency: `applyConsumerEffectOnce` (this module's own, reused
 * unchanged) guards against a redelivered event double-incrementing the
 * counter — same mechanism the two reference consumers above already use.
 * `reporting`'s own `applyEventActivityProjectionIncrement` ADDITIONALLY
 * skips entirely while a rebuild owns this projection (mutual exclusion
 * with `reporting/application/projection-rebuild.ts` — see that file's
 * header comment §3 for why this is safe against double-counting).
 */
const EVENT_ACTIVITY_PROJECTOR_DESCRIPTION =
  "reporting module consumer — projects a sample.recorded domain event into awcms_mini_reporting_projection_metrics' reporting.event_activity_summary/sample_recorded_count counter (Issue #753).";

export const eventActivityProjectorConsumer: DomainEventConsumerDefinition = {
  name: EVENT_ACTIVITY_PROJECTOR_CONSUMER_NAME,
  description: EVENT_ACTIVITY_PROJECTOR_DESCRIPTION,
  eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
  eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
  handler: async (tx, event, ctx) => {
    await applyConsumerEffectOnce(
      tx,
      ctx.tenantId,
      EVENT_ACTIVITY_PROJECTOR_CONSUMER_NAME,
      event.id,
      () => applyEventActivityProjectionIncrement(tx, ctx.tenantId)
    );
  }
};

const BASE_DOMAIN_EVENT_CONSUMERS: readonly DomainEventConsumerDefinition[] = [
  sampleAuditProjectorConsumer,
  activityRollupProjectorConsumer,
  eventActivityProjectorConsumer
];

/**
 * The static consumer registry (Issue #742 scope: "a static consumer
 * registry owned by reviewed source code") — every REAL entry is added by
 * reviewed source code (`BASE_DOMAIN_EVENT_CONSUMERS` above), never a
 * dynamic/database-driven registration. `application/append-domain-
 * event.ts` fans out delivery rows from this list at PUBLISH time;
 * `application/dispatch-domain-events.ts` iterates it at DISPATCH time.
 *
 * `export let` (not `const`) so `registerDomainEventConsumerForTests`
 * below can append a deliberately-failing fake consumer for a single
 * test's duration (retry/backoff/dead-letter scenarios need a handler
 * that reliably throws — neither of the two real consumers ever does) —
 * same test-injection SHAPE `social-provider-registry.ts`'s
 * `registerSocialProviderAdapter`/`resetSocialProviderRegistryForTests`
 * already established for social_publishing's provider adapters. A
 * reassignment here is a LIVE ES module binding — every other module that
 * imports `DOMAIN_EVENT_CONSUMERS` (not a snapshot taken at import time)
 * sees the update.
 */
export let DOMAIN_EVENT_CONSUMERS: readonly DomainEventConsumerDefinition[] =
  BASE_DOMAIN_EVENT_CONSUMERS;

/** Test-only. Appends `consumer` to the registry for the remainder of the current test file/process — call `resetDomainEventConsumersForTests()` (typically in `afterEach`) to restore the base two real consumers. Never called from production code. */
export function registerDomainEventConsumerForTests(
  consumer: DomainEventConsumerDefinition
): void {
  DOMAIN_EVENT_CONSUMERS = [...DOMAIN_EVENT_CONSUMERS, consumer];
}

/** Test-only. Restores the registry to exactly the two real, reviewed consumers. */
export function resetDomainEventConsumersForTests(): void {
  DOMAIN_EVENT_CONSUMERS = BASE_DOMAIN_EVENT_CONSUMERS;
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
