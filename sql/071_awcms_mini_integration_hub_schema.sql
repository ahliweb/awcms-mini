-- Issue #754 (epic `platform-evolution` #738, Wave 3) — `integration_hub`
-- module schema: signed inbound webhook endpoints, replay-protected
-- inbound delivery inbox, outbound event subscriptions, outbound
-- delivery/retry/dead-letter state, delivery attempt history, and
-- per-(tenant, adapter, direction) health tracking. Depends on Issue #742
-- (`domain_event_runtime`, merged) and Issue #745 (`data_lifecycle`,
-- merged). Admission decision: `docs/adr/0017-integration-hub-module-
-- admission.md`.
--
-- Six tables, all tenant-scoped (`ENABLE`+`FORCE ROW LEVEL SECURITY`),
-- `tenant_id` first in every composite index (doc 04 §RLS standard/§Index
-- standard):
--
-- 1. `awcms_mini_integration_endpoints` — inbound webhook endpoint
--    identity: opaque server-generated `endpoint_token` (never a
--    predictable/tenant-derivable value), a `secret_reference` pointer
--    (`env:VAR_NAME`, NEVER the secret value itself — same convention
--    `social_publishing`'s `token_reference` already established),
--    optional `secret_reference_previous`/`previous_secret_expires_at`
--    for key rotation with overlap. Soft-deletable (config resource).
-- 2. `awcms_mini_integration_inbound_deliveries` — the provider inbox,
--    persisted BEFORE normalization. `UNIQUE (tenant_id, endpoint_id,
--    replay_key)` is the REAL replay-protection mechanism (Issue #754
--    critical requirement: "reject a webhook delivery that's already
--    been processed" enforced by a DB uniqueness constraint, not an
--    in-memory check that would not survive a restart/multi-instance
--    deployment). `raw_body_snippet` is bounded (2000 chars, application-
--    enforced) and only ever populated for a signature-VALID delivery —
--    data minimization per Issue #754's #745 integration requirement.
--    Append-only (no soft delete — same "audit/operational log" category
--    as `awcms_mini_email_delivery_attempts`, doc 04).
-- 3. `awcms_mini_integration_subscriptions` — outbound event subscription
--    registry: `subscribed_event_type` (validated against a small
--    allowlist at the application layer), `target_url` (SSRF-validated at
--    write time AND re-validated at dispatch time, defense in depth),
--    `secret_reference` (optional, for signing the outbound payload).
--    Soft-deletable (config resource).
-- 4. `awcms_mini_integration_outbound_deliveries` — per (subscription,
--    source domain event) delivery/retry/dead-letter state, created by
--    `integration_hub`'s own `domain_event_runtime` consumer (a DB-only
--    write inside the SAME transaction as the source event commit,
--    ADR-0006/#742-compliant — the real outbound HTTP call happens LATER,
--    OUTSIDE any transaction, in the separate `integration-hub:outbound:
--    dispatch` worker job). Partial unique index mirrors
--    `awcms_mini_domain_event_deliveries`'s own dedup pattern: at most one
--    non-replay delivery row per (subscription, source event).
-- 5. `awcms_mini_integration_delivery_attempts` — append-only outbound
--    attempt history, mirrors `awcms_mini_email_delivery_attempts`.
-- 6. `awcms_mini_integration_adapter_health` — per (tenant, adapter,
--    direction) up/degraded/down state, updated by the outbound dispatch
--    job after every attempt and by the inbound intake path after every
--    verification outcome.
--
-- `legal_entity_id`/`organization_unit_id`-style cross-module FK coupling
-- does not apply here — `normalized_event_id`/`source_event_id` are plain
-- uuid POINTERS into `awcms_mini_domain_events` (owned by
-- `domain_event_runtime`, written only via that module's own
-- `appendDomainEvent`), deliberately WITHOUT a `REFERENCES` constraint:
-- this table never writes to `awcms_mini_domain_events` (no shared-table
-- write, ADR-0013 §6), and a hard FK would create a fragile migration-
-- ordering coupling between two independently-owned modules for a
-- reference that is already guaranteed correct by construction (the
-- pointer is only ever written in the SAME transaction that inserted the
-- referenced row, via `appendDomainEvent`'s own return value).

CREATE TABLE IF NOT EXISTS awcms_mini_integration_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  adapter_key text NOT NULL,
  endpoint_token text NOT NULL,
  display_name text NOT NULL,
  description text,
  secret_reference text NOT NULL,
  secret_reference_previous text,
  secret_rotated_at timestamptz,
  previous_secret_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  max_body_bytes integer NOT NULL DEFAULT 65536,
  allowed_content_types text[] NOT NULL DEFAULT ARRAY['application/json'],
  timestamp_tolerance_seconds integer NOT NULL DEFAULT 300,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  CONSTRAINT awcms_mini_integration_endpoints_status_check
    CHECK (status IN ('active', 'paused', 'disabled')),
  CONSTRAINT awcms_mini_integration_endpoints_max_body_bytes_check
    CHECK (max_body_bytes > 0 AND max_body_bytes <= 1048576),
  CONSTRAINT awcms_mini_integration_endpoints_tolerance_check
    CHECK (timestamp_tolerance_seconds > 0 AND timestamp_tolerance_seconds <= 3600),
  CONSTRAINT awcms_mini_integration_endpoints_rotation_check
    CHECK (secret_reference_previous IS NULL OR previous_secret_expires_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_integration_endpoints_token_uidx
  ON awcms_mini_integration_endpoints (endpoint_token);
CREATE INDEX IF NOT EXISTS awcms_mini_integration_endpoints_tenant_idx
  ON awcms_mini_integration_endpoints (tenant_id, status);

ALTER TABLE awcms_mini_integration_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_integration_endpoints FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_integration_endpoints_tenant_isolation
  ON awcms_mini_integration_endpoints
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_integration_inbound_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  endpoint_id uuid NOT NULL REFERENCES awcms_mini_integration_endpoints (id),
  adapter_key text NOT NULL,
  replay_key text NOT NULL,
  provider_delivery_id text,
  signature_valid boolean NOT NULL,
  verification_failure_reason text,
  content_type text,
  raw_body_sha256 text NOT NULL,
  raw_body_size integer NOT NULL,
  raw_body_snippet text,
  status text NOT NULL DEFAULT 'received',
  normalized_event_id uuid,
  correlation_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_integration_inbound_deliveries_status_check
    CHECK (status IN ('received', 'normalized', 'rejected', 'processing_failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_integration_inbound_deliveries_replay_uidx
  ON awcms_mini_integration_inbound_deliveries (tenant_id, endpoint_id, replay_key);
CREATE INDEX IF NOT EXISTS awcms_mini_integration_inbound_deliveries_tenant_idx
  ON awcms_mini_integration_inbound_deliveries (tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS awcms_mini_integration_inbound_deliveries_status_idx
  ON awcms_mini_integration_inbound_deliveries (tenant_id, status);

ALTER TABLE awcms_mini_integration_inbound_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_integration_inbound_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_integration_inbound_deliveries_tenant_isolation
  ON awcms_mini_integration_inbound_deliveries
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_integration_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  subscribed_event_type text NOT NULL,
  target_adapter_key text NOT NULL,
  target_url text NOT NULL,
  target_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_reference text,
  filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  max_attempts integer NOT NULL DEFAULT 8,
  timeout_ms integer NOT NULL DEFAULT 10000,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  CONSTRAINT awcms_mini_integration_subscriptions_status_check
    CHECK (status IN ('active', 'paused', 'disabled')),
  CONSTRAINT awcms_mini_integration_subscriptions_max_attempts_check
    CHECK (max_attempts > 0 AND max_attempts <= 20),
  CONSTRAINT awcms_mini_integration_subscriptions_timeout_check
    CHECK (timeout_ms > 0 AND timeout_ms <= 60000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_integration_subscriptions_tenant_idx
  ON awcms_mini_integration_subscriptions (tenant_id, subscribed_event_type, status);

ALTER TABLE awcms_mini_integration_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_integration_subscriptions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_integration_subscriptions_tenant_isolation
  ON awcms_mini_integration_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_integration_outbound_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  subscription_id uuid NOT NULL REFERENCES awcms_mini_integration_subscriptions (id),
  source_event_id uuid NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  next_attempt_at timestamptz,
  last_error text,
  last_http_status integer,
  replay_of_delivery_id uuid REFERENCES awcms_mini_integration_outbound_deliveries (id),
  correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_integration_outbound_deliveries_status_check
    CHECK (status IN ('pending', 'sending', 'delivered', 'retry_wait', 'dead_letter', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_integration_outbound_deliveries_dedup_uidx
  ON awcms_mini_integration_outbound_deliveries (tenant_id, subscription_id, source_event_id)
  WHERE replay_of_delivery_id IS NULL;
CREATE INDEX IF NOT EXISTS awcms_mini_integration_outbound_deliveries_claim_idx
  ON awcms_mini_integration_outbound_deliveries (tenant_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS awcms_mini_integration_outbound_deliveries_subscription_idx
  ON awcms_mini_integration_outbound_deliveries (tenant_id, subscription_id);
-- Tenant + cursor composite for data_lifecycle's generic bounded archive/
-- purge engine (Issue #745 integration, `data_lifecycle-registry.ts`'s
-- validator requires this for a `"generic"` descriptor's query-plan safety).
CREATE INDEX IF NOT EXISTS awcms_mini_integration_outbound_deliveries_cursor_idx
  ON awcms_mini_integration_outbound_deliveries (tenant_id, created_at);

ALTER TABLE awcms_mini_integration_outbound_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_integration_outbound_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_integration_outbound_deliveries_tenant_isolation
  ON awcms_mini_integration_outbound_deliveries
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_integration_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  delivery_id uuid NOT NULL REFERENCES awcms_mini_integration_outbound_deliveries (id),
  attempt_no integer NOT NULL,
  outcome text NOT NULL,
  http_status integer,
  response_snippet text,
  error_message text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_integration_delivery_attempts_outcome_check
    CHECK (outcome IN ('success', 'failure'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_integration_delivery_attempts_tenant_idx
  ON awcms_mini_integration_delivery_attempts (tenant_id, delivery_id);
-- Tenant + cursor composite for data_lifecycle's generic engine (same
-- reasoning as the outbound-deliveries cursor index above).
CREATE INDEX IF NOT EXISTS awcms_mini_integration_delivery_attempts_cursor_idx
  ON awcms_mini_integration_delivery_attempts (tenant_id, attempted_at);

ALTER TABLE awcms_mini_integration_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_integration_delivery_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_integration_delivery_attempts_tenant_isolation
  ON awcms_mini_integration_delivery_attempts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_integration_adapter_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  adapter_key text NOT NULL,
  direction text NOT NULL,
  state text NOT NULL DEFAULT 'up',
  consecutive_failures integer NOT NULL DEFAULT 0,
  consecutive_successes integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_integration_adapter_health_direction_check
    CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT awcms_mini_integration_adapter_health_state_check
    CHECK (state IN ('up', 'degraded', 'down'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_integration_adapter_health_uidx
  ON awcms_mini_integration_adapter_health (tenant_id, adapter_key, direction);

ALTER TABLE awcms_mini_integration_adapter_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_integration_adapter_health FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_integration_adapter_health_tenant_isolation
  ON awcms_mini_integration_adapter_health
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- SECURITY DEFINER bootstrap lookup (Issue #754) — the inbound webhook
-- receiver (`POST /api/v1/integration-hub/inbound/{endpointToken}`) has no
-- prior tenant JWT/session; it must resolve (tenant_id, endpoint metadata)
-- from an opaque `endpoint_token` path segment BEFORE any `withTenant(...)`
-- transaction can run (RLS requires `app.current_tenant_id` to already be
-- set). Mirrors `awcms_mini_resolve_tenant_domain_lookup` (migration 033)
-- exactly: the function body is fixed, static SQL (no dynamic SQL/string
-- concatenation), returns a narrow, non-secret projection (never
-- `raw_body_snippet`/any other table's data), and joins the (already
-- RLS-free) `awcms_mini_tenants` row in the SAME call so this function
-- costs exactly one round trip for every outcome — avoiding the same
-- timing side-channel migration 033's own comment documents ("unknown
-- token" vs "known token, inactive tenant/endpoint" must not be
-- distinguishable by response latency alone). `secret_reference`/
-- `secret_reference_previous` are pointers (`env:VAR_NAME`), never the
-- resolved secret VALUE — resolving the pointer to an actual secret
-- happens application-side, from `process.env`, never persisted/logged.
CREATE OR REPLACE FUNCTION awcms_mini_resolve_integration_endpoint_lookup(
  p_endpoint_token text
)
RETURNS TABLE (
  endpoint_id uuid,
  tenant_id uuid,
  adapter_key text,
  secret_reference text,
  secret_reference_previous text,
  previous_secret_expires_at timestamptz,
  endpoint_status text,
  max_body_bytes integer,
  allowed_content_types text[],
  timestamp_tolerance_seconds integer,
  tenant_status text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT
    e.id,
    e.tenant_id,
    e.adapter_key,
    e.secret_reference,
    e.secret_reference_previous,
    e.previous_secret_expires_at,
    e.status,
    e.max_body_bytes,
    e.allowed_content_types,
    e.timestamp_tolerance_seconds,
    t.status
  FROM awcms_mini_integration_endpoints AS e
  JOIN awcms_mini_tenants AS t ON t.id = e.tenant_id
  WHERE e.endpoint_token = p_endpoint_token
    AND e.deleted_at IS NULL
$function$;

COMMENT ON FUNCTION awcms_mini_resolve_integration_endpoint_lookup(text) IS
  'Issue #754: narrow SECURITY DEFINER bootstrap read for endpoint_token -> tenant/endpoint lookup before tenant context exists (inbound webhook receiver has no prior tenant JWT). Joins the RLS-free awcms_mini_tenants row in the same call to avoid a timing side-channel between "unknown token" and "known token, inactive tenant/endpoint". Returns only non-secret metadata plus secret_reference (an env: pointer, never the secret value itself) for non-deleted endpoint rows. EXECUTE restricted to awcms_mini_app.';

REVOKE ALL ON FUNCTION awcms_mini_resolve_integration_endpoint_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION awcms_mini_resolve_integration_endpoint_lookup(text) TO awcms_mini_app;

-- `awcms_mini_worker` least-privilege role (migration 013/045) — the
-- outbound dispatch job (`bun run integration-hub:outbound:dispatch`) and
-- the `domain_event_runtime` dispatcher (`bun run domain-events:dispatch`,
-- which now also runs `integration_hub`'s own fan-out consumer, a DB-only
-- handler registered in `domain-event-runtime/infrastructure/consumer-
-- registry.ts`) both run as this role. Migration 013's `ALTER DEFAULT
-- PRIVILEGES` only grants the ordinary runtime `awcms_mini_app` role
-- automatically — `awcms_mini_worker` always needs an explicit per-table
-- grant here, same pattern migration 056/058 already established:
--   - `awcms_mini_integration_subscriptions`: SELECT only — both the
--     fan-out consumer (reads active subscriptions matching an event
--     type) and the dispatch job (reads target_url/secret_reference/
--     timeout/max_attempts) only ever READ this table; subscription
--     CRUD/pause/resume are `awcms_mini_app` admin API routes.
--   - `awcms_mini_integration_outbound_deliveries`: SELECT + INSERT
--     (fan-out consumer creates new pending rows inside the domain-event
--     transaction) + UPDATE (dispatch job's claim/finalize status
--     transitions) — never DELETE (append-only history, replay creates a
--     NEW row rather than mutating history, and replay itself is an
--     `awcms_mini_app` admin action).
--   - `awcms_mini_integration_delivery_attempts`: INSERT only — the
--     dispatch job records one attempt row per delivery per try; never
--     read back by the worker itself (admin API reads these).
--   - `awcms_mini_integration_adapter_health`: SELECT + INSERT + UPDATE —
--     the dispatch job's own
--     `INSERT ... ON CONFLICT (tenant_id, adapter_key, direction) DO UPDATE`
--     health upsert after every attempt.
--   - `awcms_mini_integration_endpoints` is deliberately NOT granted here
--     — inbound webhook intake runs entirely on the `awcms_mini_app`
--     connection (an HTTP route handler, not a worker job); the worker
--     never touches it.
--   - `awcms_mini_integration_inbound_deliveries`: SELECT + DELETE — NOT
--     for the inbound intake path itself (still `awcms_mini_app` only),
--     but because this table is registered as a `"generic"`
--     `data_lifecycle` descriptor (`module.ts`'s `dataLifecycle` array,
--     Issue #745 integration) — `data_lifecycle`'s own bounded archive/
--     purge engine (`bun run data-lifecycle:archive-purge`, running as
--     `awcms_mini_worker`) reads this table for dry-run counts and
--     archive batches (SELECT) and purges past-retention rows (DELETE),
--     exactly the same grant shape every OTHER `"generic"` descriptor's
--     owning module already provides its worker role (see migration 057's
--     own tail for `data_lifecycle.data_lifecycle_runs`, its dogfooded
--     `"generic"` descriptor). No INSERT/UPDATE — the worker never
--     creates/mutates inbound delivery rows, only reads and eventually
--     purges them.
--   - `awcms_mini_domain_events`/`_deliveries`/`_consumer_effects` grants
--     already exist (migration 056) and are reused unchanged by the new
--     fan-out consumer.
GRANT SELECT, DELETE ON awcms_mini_integration_inbound_deliveries TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_integration_subscriptions TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_mini_integration_outbound_deliveries TO awcms_mini_worker;
GRANT INSERT ON awcms_mini_integration_delivery_attempts TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_mini_integration_adapter_health TO awcms_mini_worker;
