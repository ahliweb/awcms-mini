# domain-event-runtime

Transactional, versioned domain-event outbox and dispatcher (Issue #742, epic `platform-evolution` #738, Wave 1 — System Foundation candidate per `docs/adr/0013-extension-layers-and-boundary-model.md` §1/§6). Depends on Issue #739 (ADR-0013).

## Why this exists

AWCMS-Mini already has three real single-purpose outbox/queue precedents this module deliberately follows the shape of, not replaces:

- `sync-storage`'s `awcms_mini_object_sync_queue` + `dispatchObjectSyncQueue` (Issue #436)
- `email`'s `awcms_mini_email_messages` + `dispatchEmailQueue` (Issue #493-#495)
- `social-publishing`'s `awcms_mini_social_publish_jobs` + `dispatchSocialPublishQueue` (Issue #643)

Each of those is a **single-purpose queue owned by one module**, with exactly one implicit "consumer" (its own dispatcher calling one external provider). This module is the **generic, provider-neutral, multi-consumer** counterpart: one event can fan out to **many** registered consumers, with explicit per-aggregate/order-key ordering (never a global total order across unrelated aggregates).

## Core mechanism

1. **Producer** — any module's own transactional code calls `application/append-domain-event.ts`'s `appendDomainEvent(tx, tenantId, input)` **inside its own business transaction** (`withTenant`'s callback). This performs only plain DB writes (no network/provider call, ADR-0006) — the event row (`awcms_mini_domain_events`) and one delivery row per matching registered consumer (`awcms_mini_domain_event_deliveries`) are written atomically with the source state change. If the caller's transaction rolls back for any reason, none of it persists.
2. **Static consumer registry** — `infrastructure/consumer-registry.ts`'s `DOMAIN_EVENT_CONSUMERS` holds only reviewed source-code entries. Each declares which event types/versions it wants and a `handler`. Fan-out is decided **at publish time** from this registry, not at dispatch time. This runtime's OWN consumers are listed in the file's base array; a consumer owned by ANOTHER module registers itself via `registerDomainEventConsumer` (Issue #826) — this runtime imports no consumer module's code, because a `system` foundation module must not depend on the feature modules that plug into it (ADR-0013 §1). Until #826 it did, and `domain_event_runtime <-> integration_hub` was a live import cycle.
3. **Dispatcher** — `application/dispatch-domain-events.ts`'s `dispatchDomainEventsForTenant` (driven by `bun run domain-events:dispatch`, built on the shared worker runner `src/lib/jobs/job-runner.ts`, PR #713) claims, executes, and finalizes due deliveries per consumer, honoring per-order-key ordering, exponential backoff, and dead-letter transitions.
4. **Idempotent side effects** — `application/consumer-effect.ts`'s `applyConsumerEffectOnce` gives any consumer handler event-ID-keyed idempotency (`awcms_mini_domain_event_consumer_effects`), so a redelivered event (crash/restart, or an explicit replay) cannot duplicate a side effect.
5. **Dead-letter + replay** — a delivery that exhausts its retry budget (or hits a non-retryable error) transitions to `dead_letter`. A permission-gated, reason-required, idempotent, audited admin action (`application/delivery-replay.ts`) creates a **new** delivery row referencing the original — refusing (409) if the registered consumer no longer supports the delivery's `eventVersion`.
6. **Pause/resume** — `application/consumer-state-directory.ts` lets an operator pause a specific (tenant, consumer) pair; the dispatcher skips claiming any delivery for it until resumed.

## Execution model — why NOT the usual 3-phase CLAIM/CALL/FINALIZE

Every other outbox dispatcher in this repo uses a lease-based 3-phase shape (CLAIM in a short transaction → CALL **outside** any transaction → FINALIZE in a second short transaction) because their CALL phase makes a real external network call (upload, SMTP, provider API), which ADR-0006 forbids running inside a DB transaction.

This foundation issue's two reference consumers are **same-process, DB-only handlers with no external I/O**. `dispatch-domain-events.ts` instead runs claim-check + handler + finalize-on-success in **one** transaction: a crash mid-handler rolls the whole transaction back automatically, returning the delivery row to `pending` with no explicit lease/stale-claim state ever durably observed — this is what makes crash/restart recovery correct-by-construction rather than lease-timeout-based, and is why `awcms_mini_domain_event_deliveries.status` has no transient "claimed" value.

A future **out-of-transaction / broker-backed** consumer (see `infrastructure/broker-adapter-port.ts`) would need the lease-based shape back — not built speculatively here.

## Ordering

`order_key` defaults to `aggregateType:aggregateId` (`domain/envelope.ts`'s `deriveOrderKey`) but a producer may override it. The dispatcher's head-of-line query (`SELECT DISTINCT ON (order_key) ... ORDER BY order_key, event_sequence`) picks, per `order_key`, only the single oldest pending delivery for a given consumer — computed **before** filtering by backoff (`next_attempt_at`), so a backed-off head-of-line row correctly stalls its own `order_key` without letting a later event for the same key jump ahead, while unrelated `order_key`s progress independently every pass.

## Two representative consumers (reference implementations)

Both are registered against a single self-contained reference event, `awcms-mini.domain-event-runtime.sample.recorded` (`domain/event-type-registry.ts`) — deliberately not tied to another module's business logic in this foundation issue (mirrors the accepted "foundation issue ships zero real business integrations" precedent: #643 shipped zero real provider adapters, PR #713 migrated only 2 of 8 scripts as proof-of-concept). Real producer/consumer wiring for existing modules (blog_content, social_publishing, email, etc.) is intentionally deferred to follow-up issues.

- **`logging.sample_event_audit_projector`** — a same-process **cross-module** consumer: reacts to the event by calling `logging`'s own public `recordAuditEvent` (the same cross-module call ~10 other modules already make directly — audit logging is foundational infra, not a domain capability gated behind an ADR-0011 capability port).
- **`domain_event_runtime.activity_rollup_projector`** — a **reporting/read-model projection** consumer: maintains its own denormalized rollup table, `awcms_mini_domain_event_activity_daily` (tenant/day/event-type counts), without touching the separate `reporting` module's own tables (no shared-table write, ADR-0013 §6).

Adding a real consumer (Issue #826): create `<your-module>/infrastructure/domain-event-consumer-registration.ts`, define the `DomainEventConsumerDefinition` there, and call `registerDomainEventConsumer(...)` from it — matching event type(s)/version(s) already present in `domain/event-type-registry.ts`. Do NOT add it to `DOMAIN_EVENT_CONSUMERS` here; that would make this runtime import your module and re-create the cycle #826 removed. Then import your registration file for its side effect from every composition root that publishes, dispatches, or replays that event (`scripts/domain-events-dispatch.ts`, the replay route, and your own producer) — a missed one is SILENT (the dispatcher iterates registered consumers, so unregistered deliveries are never claimed at all). `tests/unit/domain-event-consumer-registration-wiring.test.ts` enforces this. Adding a real producer: call `appendDomainEvent` inside your own module's transaction, with an event type/version first added to `DOMAIN_EVENT_TYPE_REGISTRY` and a matching AsyncAPI channel.

## AsyncAPI parity

`appendDomainEvent` refuses (throws `UnregisteredDomainEventTypeError`) to persist an event whose `(eventType, eventVersion)` is not listed in `domain/event-type-registry.ts`'s `DOMAIN_EVENT_TYPE_REGISTRY` — this is the mechanism, not just documentation, behind "event types/versions cannot silently drift" (Issue #742). `tests/unit/domain-event-registry-parity.test.ts` cross-checks this registry against `asyncapi/awcms-mini-domain-events.asyncapi.yaml` bidirectionally (registry entry without a channel = fail; a registered consumer's subscribed event type without a registry entry = fail), and `module.ts`'s `events.publishes` array is checked against AsyncAPI by the existing repo-wide `checkModuleEventChannels` (`scripts/api-spec-check.ts`, part of `bun run check`).

## Security notes

- **Tenant isolation**: every table is tenant-scoped with `ENABLE`+`FORCE ROW LEVEL SECURITY` and the standard `tenant_id = current_setting('app.current_tenant_id')::uuid` policy (migration 056); every application query additionally filters `tenant_id` explicitly (defense in depth).
- **Payload hygiene**: `domain/envelope.ts`'s `validateDomainEventPayload` hard-rejects (never persists) a payload containing a credential-shaped key name (`password`/`token`/`apiKey`/`secret`/`credential`/`authorization` — deliberately narrower than `_shared/redaction.ts`'s full `REDACTION_KEYS`, which also includes ordinary PII like `email`/`phone` that a legitimate consumer may need) or a credential-shaped **value** regardless of key name (reuses `_shared/redaction.ts`'s `findSecretShapedValues` unchanged — JWT/PEM/AWS key/Bearer header/connection-string credential). A 64 KiB payload size cap is enforced both in application code and as a DB `CHECK` backstop.
- **Read-time masking**: `domain/payload-redaction.ts` applies the full `redactSensitiveAttributes` (PII-inclusive) to every payload leaving `application/domain-event-directory.ts`'s admin/API read functions — the raw payload a consumer `handler` receives internally is never redacted (it needs the real data).
- **Replay**: permission-gated (`domain_event_runtime.deliveries.replay`), reason-required (1-500 chars), idempotent (`Idempotency-Key`), audited, and refuses to replay against an event version the registered consumer no longer declares support for.
- **No external broker required**: `infrastructure/broker-adapter-port.ts` defines an optional port; no adapter is registered by default. Every deployment, including offline/LAN, dispatches purely via PostgreSQL + the in-process consumer registry.

## Tables

| Table                                      | Purpose                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `awcms_mini_domain_events`                 | The outbox itself — append-only.                                                         |
| `awcms_mini_domain_event_deliveries`       | Per (event, consumer) delivery/retry/dead-letter state.                                  |
| `awcms_mini_domain_event_consumer_effects` | Generic event-ID-keyed side-effect idempotency marker, reusable by any consumer handler. |
| `awcms_mini_domain_event_consumer_state`   | Per (tenant, consumer) pause/resume flag.                                                |
| `awcms_mini_domain_event_replays`          | Append-only replay audit trail.                                                          |
| `awcms_mini_domain_event_activity_daily`   | The reference read-model projection consumer's own rollup table.                         |

## API

`GET/POST /api/v1/domain-events/{events,deliveries,consumers}` — see `openapi/modules/domain-event-runtime.openapi.yaml`. Read-mostly admin API; the only mutations are replay and pause/resume. Consumers themselves are never created/edited via this API — they are a static, reviewed-source-code registry.

## Jobs

`bun run domain-events:dispatch` (`scripts/domain-events-dispatch.ts`) — recommended every 30-60 seconds via cron/systemd timer. Pure PostgreSQL/in-process operation, safe in offline/LAN deployments.

## Out of scope (this issue)

- Wiring a real existing module (blog_content, social_publishing, email, etc.) as a producer or consumer — deferred to follow-up issues.
- An out-of-transaction / broker-backed dispatch path for a registered `DomainEventBrokerAdapter` — the port is defined, no dispatch path consumes it yet.
- Retention/purge of `awcms_mini_domain_events`/`_deliveries`/`_consumer_effects`/`_replays` — deferred to the `data_lifecycle` System Foundation candidate (epic #738 Wave 1, sibling issue), which is expected to declare a per-table retention policy contract this module's owner would then implement against, not build a bespoke purge job here.
- A `reporting`-module-owned materialized view over domain event activity — the reference projection consumer owns its own small table instead (no shared-table write).
