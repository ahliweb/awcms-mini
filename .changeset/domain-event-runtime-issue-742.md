---
"awcms-mini": minor
---

Add `domain_event_runtime` — a transactional, versioned, generic multi-consumer domain-event outbox and dispatcher (Issue #742, epic `platform-evolution` #738 Wave 1).

- New module `domain-event-runtime` (`domain_event_runtime`, `type: system`), registered in `src/modules/index.ts`. Migration `056` adds six tenant-scoped RLS tables: `awcms_mini_domain_events` (the outbox), `awcms_mini_domain_event_deliveries` (per-event/per-consumer retry/dead-letter state), `awcms_mini_domain_event_consumer_effects` (reusable event-ID-keyed side-effect idempotency marker), `awcms_mini_domain_event_consumer_state` (pause/resume), `awcms_mini_domain_event_replays` (append-only replay audit trail), and `awcms_mini_domain_event_activity_daily` (reference read-model projection).
- Producers call `appendDomainEvent(tx, tenantId, input)` inside their own business transaction — the event and its fan-out delivery rows (from a static, reviewed-source-code consumer registry) commit atomically with the source state change; a rolled-back caller transaction produces no dispatchable event.
- The dispatcher (`bun run domain-events:dispatch`, built on the shared worker runner from PR #713) claims/executes/finalizes due deliveries per tenant/consumer with explicit per-aggregate/order-key ordering (unrelated keys progress independently), exponential backoff, and dead-letter transitions after the retry budget is exhausted or a non-retryable error occurs.
- Dead-lettered deliveries can be replayed via a permission-gated (`domain_event_runtime.deliveries.replay`), reason-required, idempotent (`Idempotency-Key`), audited admin action that refuses to replay against an event version the registered consumer no longer supports.
- Two reference consumers exercise the mechanism end-to-end against a self-contained reference event (`awcms-mini.domain-event-runtime.sample.recorded`): a same-process cross-module audit-trail projector, and a reporting/read-model activity-rollup projector. Real producer/consumer wiring for existing modules is intentionally deferred to follow-up issues.
- New REST API under `/api/v1/domain-events/{events,deliveries,consumers}` (read-mostly; replay and pause/resume are the only mutations) — see `openapi/modules/domain-event-runtime.openapi.yaml`. New AsyncAPI channel `awcms-mini.domain-event-runtime.sample.recorded`.
- No external broker is required; `infrastructure/broker-adapter-port.ts` defines an optional port for future use. Offline/LAN deployments are unaffected.
