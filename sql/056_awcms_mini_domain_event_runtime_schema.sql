-- Issue #742 (epic `platform-evolution` #738, Wave 1) — transactional
-- domain-event outbox, idempotent consumers, retries, ordering, and
-- dead-letter handling. Depends on Issue #739 (ADR-0013), which classifies
-- `domain_event_runtime` as a System Foundation candidate (`docs/adr/
-- 0013-extension-layers-and-boundary-model.md` §1/§6: "Status pengiriman
-- envelope event (outbox/inbox/dead-letter) — bukan data bisnis").
--
-- AWCMS-Mini already has three real outbox/queue precedents this migration
-- deliberately follows the shape of (not replaces): `awcms_mini_object_sync_
-- queue` + `dispatchObjectSyncQueue` (Issue #436), `awcms_mini_email_messages`
-- + `dispatchEmailQueue` (Issue #493-#495), and `awcms_mini_social_publish_
-- jobs` + `dispatchSocialPublishQueue` (Issue #643). This module is the
-- generic, provider-neutral, multi-consumer counterpart: one event can fan
-- out to MANY registered consumers (unlike those three, which are each a
-- single-purpose single-consumer queue), with explicit per-aggregate/
-- order-key ordering and operator-safe replay.
--
-- Six tables:
--
-- 1. `awcms_mini_domain_events` — the outbox itself. Append-only (never
--    UPDATEd/DELETEd by application code, matching doc 04/10's posted/
--    append-only convention for immutable history) — one row per published
--    domain event, written in the SAME transaction as the source state
--    change that caused it (Issue #742 acceptance criterion: "Source state
--    and outbox record commit atomically"). `event_sequence` is a plain
--    bigint IDENTITY column — a strictly monotonic, gap-tolerant, per-table
--    insertion-order counter used ONLY as an unambiguous ordering
--    tiebreaker (two events inserted in the same transaction can share an
--    identical `recorded_at` timestamp down to the microsecond; a random
--    UUID primary key has no ordering property at all) — never exposed as
--    a business identifier, never used for tenant-cross-referencing.
-- 2. `awcms_mini_domain_event_deliveries` — one row per (event, registered
--    consumer) pair, created by the SAME transaction that inserts the
--    event (fan-out decided at publish time from the static consumer
--    registry in code, per Issue #742 scope: "a static consumer registry
--    owned by reviewed source code"). This is both the retry/backoff/
--    dead-letter state machine AND the idempotency mechanism: a consumer
--    can only ever have ONE non-replay delivery row per event (partial
--    unique index below), so duplicate dispatch of the SAME event to the
--    SAME consumer is structurally impossible, not just discouraged.
-- 3. `awcms_mini_domain_event_consumer_effects` — a generic, reusable
--    idempotency marker table ANY consumer handler can use (via the
--    `applyConsumerEffectOnce` helper, `application/consumer-effect.ts`) to
--    guarantee its OWN side effect (e.g. a projection upsert, a
--    cross-module call) runs at most once per (consumer, event) even if
--    the SAME event is legitimately redelivered (a crash between the
--    handler's own commit and the delivery row's `delivered` finalize, or
--    an operator-triggered replay) — this is what makes "duplicate
--    delivery cannot duplicate side effects; consumers must use event ID/
--    idempotency" (Issue #742 security requirement) a mechanism, not just
--    documentation.
-- 4. `awcms_mini_domain_event_consumer_state` — per (tenant, consumer)
--    pause/resume flag (Issue #742 scope: "pause/resume"). An operator
--    investigating a misbehaving consumer can pause it without touching the
--    dispatcher process or any other consumer.
-- 5. `awcms_mini_domain_event_replays` — append-only audit trail of every
--    replay action (who, when, reason, which delivery). Separate from the
--    generic `awcms_mini_audit_events` table (which ALSO gets a row per
--    replay, doc 10 "Audit melengkapi, bukan menggantikan") because this
--    table additionally carries the structured `original_delivery_id` /
--    `replay_delivery_id` linkage needed to reconstruct a full replay
--    lineage for a given delivery, which a free-text audit `attributes`
--    blob is not the right place to query.
-- 6. `awcms_mini_domain_event_activity_daily` — a small denormalized
--    read-model projection (tenant_id, activity_date, event_type,
--    event_count), maintained by this issue's REFERENCE "reporting/
--    read-model projection" consumer (Issue #742 scope: "one reporting/
--    read-model projection consumer or test fixture") — proof that the
--    dispatcher can drive a real aggregate view, without touching the
--    separate `reporting` module's own tables (out of scope for this
--    foundation issue, no shared-table write per ADR-0013 §6).
--
-- Every table is tenant-scoped with the standard RLS policy (doc 04) — this
-- migration does not introduce any RLS-free/global table, so none of it
-- needs the manual-grant carve-out documented in migration 013's header;
-- the existing `ALTER DEFAULT PRIVILEGES` there already covers these six.
CREATE TABLE IF NOT EXISTS awcms_mini_domain_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_sequence bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  event_type text NOT NULL,
  event_version text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer,
  order_key text NOT NULL,
  correlation_id text,
  causation_id text,
  producer_module text NOT NULL,
  schema_ref text,
  actor_tenant_user_id uuid,
  actor_profile_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- Each segment allows hyphens, including the first — every real event
  -- name in this repo uses a hyphenated `awcms-mini` namespace prefix
  -- (e.g. `awcms-mini.domain-event-runtime.sample.recorded`); matches
  -- `domain/envelope.ts`'s `EVENT_TYPE_PATTERN` exactly.
  CONSTRAINT awcms_mini_domain_events_event_type_format_check
    CHECK (event_type ~ '^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)+$'),
  CONSTRAINT awcms_mini_domain_events_event_version_format_check
    CHECK (event_version ~ '^[0-9]+\.[0-9]+$'),
  CONSTRAINT awcms_mini_domain_events_aggregate_type_length_check
    CHECK (char_length(aggregate_type) BETWEEN 1 AND 100),
  CONSTRAINT awcms_mini_domain_events_order_key_length_check
    CHECK (char_length(order_key) BETWEEN 1 AND 300),
  CONSTRAINT awcms_mini_domain_events_producer_module_length_check
    CHECK (char_length(producer_module) BETWEEN 1 AND 100),
  -- Defense-in-depth payload size bound (Issue #742 security requirement:
  -- "Payloads are minimized and schema-validated") — the primary
  -- enforcement is application-level (`domain/envelope.ts`'s
  -- `validateDomainEventPayload`, which also rejects secret-shaped values
  -- via the existing `findSecretShapedValues` heuristic), this is a hard
  -- backstop so no caller can ever bypass that at the DB layer.
  CONSTRAINT awcms_mini_domain_events_payload_size_check
    CHECK (octet_length(payload::text) <= 65536)
);

CREATE INDEX IF NOT EXISTS awcms_mini_domain_events_sequence_idx
  ON awcms_mini_domain_events (event_sequence);
CREATE INDEX IF NOT EXISTS awcms_mini_domain_events_tenant_type_idx
  ON awcms_mini_domain_events (tenant_id, event_type, recorded_at DESC);
CREATE INDEX IF NOT EXISTS awcms_mini_domain_events_tenant_aggregate_idx
  ON awcms_mini_domain_events (tenant_id, aggregate_type, aggregate_id);
CREATE INDEX IF NOT EXISTS awcms_mini_domain_events_tenant_recorded_idx
  ON awcms_mini_domain_events (tenant_id, recorded_at DESC);

ALTER TABLE awcms_mini_domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_domain_events FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_domain_events_tenant_isolation
  ON awcms_mini_domain_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Per-(event, consumer) delivery/idempotency/retry/DLQ state. `status`
-- deliberately has NO transient "claimed"/"in-flight" value — unlike the
-- lease-based 3-phase CLAIM/CALL/FINALIZE dispatchers this module's own
-- doc comments cite as precedent (`object-dispatch.ts`, whose CALL phase
-- runs OUTSIDE any transaction because it makes a real external network
-- call), this foundation issue's two reference consumers are same-process,
-- DB-only handlers with NO external I/O — so `application/dispatch-domain-
-- events.ts` claims, executes, AND finalizes a delivery inside ONE
-- transaction (`UPDATE ... WHERE status = 'pending' ... `, then the
-- handler, then the success/failure update, all in the same `withTenant`
-- block). A crash mid-handler rolls the ENTIRE transaction back
-- automatically (Postgres tears down the connection's uncommitted work),
-- which puts the row back to `pending` with no explicit "stale claim"
-- state ever durably observed by another transaction — this is what makes
-- crash/restart recovery correct-by-construction here rather than
-- lease-timeout-based. A future OUT-OF-TRANSACTION consumer (e.g. a real
-- broker adapter, `domain/broker-adapter-port.ts`) is a documented,
-- not-yet-implemented extension (Issue #742 acceptance criterion: "define
-- an optional broker adapter port for future use without making it
-- required") that would need to add a lease-based state back to this
-- column — deliberately not built speculatively here.
CREATE TABLE IF NOT EXISTS awcms_mini_domain_event_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  event_id uuid NOT NULL REFERENCES awcms_mini_domain_events (id),
  event_sequence bigint NOT NULL,
  event_type text NOT NULL,
  event_version text NOT NULL,
  order_key text NOT NULL,
  consumer_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  next_attempt_at timestamptz,
  last_error_code text,
  last_error_message text,
  last_retry_classification text,
  delivered_at timestamptz,
  dead_letter_at timestamptz,
  dead_letter_reason text,
  replay_of_delivery_id uuid REFERENCES awcms_mini_domain_event_deliveries (id),
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_domain_event_deliveries_status_check
    CHECK (status IN ('pending', 'delivered', 'dead_letter', 'skipped')),
  CONSTRAINT awcms_mini_domain_event_deliveries_attempt_count_check
    CHECK (attempt_count >= 0 AND max_attempts >= 1),
  CONSTRAINT awcms_mini_domain_event_deliveries_consumer_name_length_check
    CHECK (char_length(consumer_name) BETWEEN 1 AND 150)
);

-- Exactly one ORIGINAL (non-replay) delivery per (event, consumer) — the
-- structural half of "duplicate delivery cannot duplicate side effects".
-- Replays intentionally fall outside this constraint (each replay is a new
-- row with `replay_of_delivery_id` set) so the full replay history for a
-- delivery stays queryable/append-only rather than overwriting the
-- original row.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_domain_event_deliveries_identity_key
  ON awcms_mini_domain_event_deliveries (tenant_id, event_id, consumer_name)
  WHERE replay_of_delivery_id IS NULL;

-- Dispatcher head-of-line query shape: `SELECT DISTINCT ON (order_key) ...
-- WHERE tenant_id = $1 AND consumer_name = $2 AND status = 'pending' ORDER
-- BY order_key, event_sequence` (application/dispatch-domain-events.ts) —
-- this partial index matches that predicate and sort order exactly.
CREATE INDEX IF NOT EXISTS awcms_mini_domain_event_deliveries_dispatch_idx
  ON awcms_mini_domain_event_deliveries (tenant_id, consumer_name, order_key, event_sequence)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS awcms_mini_domain_event_deliveries_event_id_idx
  ON awcms_mini_domain_event_deliveries (event_id);
CREATE INDEX IF NOT EXISTS awcms_mini_domain_event_deliveries_tenant_status_idx
  ON awcms_mini_domain_event_deliveries (tenant_id, status);
CREATE INDEX IF NOT EXISTS awcms_mini_domain_event_deliveries_tenant_consumer_idx
  ON awcms_mini_domain_event_deliveries (tenant_id, consumer_name, status);
CREATE INDEX IF NOT EXISTS awcms_mini_domain_event_deliveries_replay_of_idx
  ON awcms_mini_domain_event_deliveries (replay_of_delivery_id)
  WHERE replay_of_delivery_id IS NOT NULL;

ALTER TABLE awcms_mini_domain_event_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_domain_event_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_domain_event_deliveries_tenant_isolation
  ON awcms_mini_domain_event_deliveries
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Generic per-consumer side-effect idempotency marker (see file header
-- point 3). `event_id` intentionally has NO foreign key to
-- `awcms_mini_domain_events` — the marker must remain valid even after a
-- future retention/purge policy (Issue #745 `data_lifecycle`, not built
-- here) removes old event rows; an FK would force this table's rows to be
-- purged in lockstep with the event table, coupling two independent
-- retention decisions.
CREATE TABLE IF NOT EXISTS awcms_mini_domain_event_consumer_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_domain_event_consumer_effects_identity_key
  ON awcms_mini_domain_event_consumer_effects (tenant_id, consumer_name, event_id);

ALTER TABLE awcms_mini_domain_event_consumer_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_domain_event_consumer_effects FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_domain_event_consumer_effects_tenant_isolation
  ON awcms_mini_domain_event_consumer_effects
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Per (tenant, consumer) pause/resume switch (see file header point 4).
CREATE TABLE IF NOT EXISTS awcms_mini_domain_event_consumer_state (
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  consumer_name text NOT NULL,
  is_paused boolean NOT NULL DEFAULT false,
  paused_at timestamptz,
  paused_by uuid,
  paused_reason text,
  resumed_at timestamptz,
  resumed_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumer_name)
);

ALTER TABLE awcms_mini_domain_event_consumer_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_domain_event_consumer_state FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_domain_event_consumer_state_tenant_isolation
  ON awcms_mini_domain_event_consumer_state
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Append-only replay audit trail (see file header point 5) — never
-- UPDATEd/DELETEd by application code.
CREATE TABLE IF NOT EXISTS awcms_mini_domain_event_replays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  original_delivery_id uuid NOT NULL REFERENCES awcms_mini_domain_event_deliveries (id),
  replay_delivery_id uuid NOT NULL REFERENCES awcms_mini_domain_event_deliveries (id),
  requested_by uuid NOT NULL,
  reason text NOT NULL,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_domain_event_replays_reason_length_check
    CHECK (char_length(reason) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS awcms_mini_domain_event_replays_original_idx
  ON awcms_mini_domain_event_replays (tenant_id, original_delivery_id);

ALTER TABLE awcms_mini_domain_event_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_domain_event_replays FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_domain_event_replays_tenant_isolation
  ON awcms_mini_domain_event_replays
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Reference "reporting/read-model projection" consumer's own denormalized
-- rollup (see file header point 6) — a read-optimized aggregate, NOT a
-- source of truth (the outbox itself is). `event_count` is maintained via
-- `INSERT ... ON CONFLICT (tenant_id, activity_date, event_type) DO UPDATE
-- SET event_count = event_count + 1` guarded by the SAME
-- `applyConsumerEffectOnce` idempotency marker every other consumer uses,
-- so a redelivered event increments this counter at most once.
CREATE TABLE IF NOT EXISTS awcms_mini_domain_event_activity_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  activity_date date NOT NULL,
  event_type text NOT NULL,
  event_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_domain_event_activity_daily_count_check
    CHECK (event_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_domain_event_activity_daily_identity_key
  ON awcms_mini_domain_event_activity_daily (tenant_id, activity_date, event_type);

ALTER TABLE awcms_mini_domain_event_activity_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_domain_event_activity_daily FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_domain_event_activity_daily_tenant_isolation
  ON awcms_mini_domain_event_activity_daily
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Permission catalog seed.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('domain_event_runtime', 'events', 'read', 'Read domain event outbox entries (redacted payload projections only)'),
  ('domain_event_runtime', 'deliveries', 'read', 'Read domain event consumer delivery/attempt status, including dead-lettered deliveries'),
  ('domain_event_runtime', 'deliveries', 'replay', 'Replay a dead-lettered domain event delivery to a registered consumer'),
  ('domain_event_runtime', 'consumers', 'read', 'Read the domain event consumer registry and pause state'),
  ('domain_event_runtime', 'consumers', 'manage', 'Pause or resume a domain event consumer')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
