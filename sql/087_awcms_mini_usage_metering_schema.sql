-- Issue #875 (epic #868 SaaS control plane, Wave 1, ADR-0022) —
-- `usage_metering` module schema: the provider-neutral metering foundation.
-- Owning modules emit reviewed, numeric-only meter EVENTS (idempotent,
-- privacy-minimized) in the SAME commit as their business transaction, through
-- a transaction-safe append port. An asynchronous, resumable aggregation worker
-- deterministically materializes usage WINDOWS from the immutable events (and
-- their signed CORRECTIONS), which billing (#876) reads through the
-- `usage_aggregate` capability. A reconciliation pass recomputes windows from
-- the immutable source and flags any drift — never trusting a single signal.
--
-- ## Placement (ADR-0022 §3) — a tenant-SCOPED control-plane module
--
-- Every table here is TENANT-SCOPED: `tenant_id` + `ENABLE` +
-- `FORCE ROW LEVEL SECURITY` + a policy whose predicate is ALWAYS AND ONLY
-- `tenant_id = current_setting('app.current_tenant_id')::uuid` (ADR-0022 §6
-- High-1 "no soft super-tenant": the predicate is NEVER extended with an
-- `OR platform-claim` clause — a functional BYPASSRLS that would slip past
-- `scripts/security-readiness.ts`'s role-attribute check). A platform operator
-- reads/corrects/reconciles a tenant's usage ONLY inside that tenant's
-- `withTenant()` per-tenant context (one tenant per context, each mutation
-- audited). Tenant A can never submit/read/correct tenant B usage. `tenant_id`
-- is first in every composite index (doc 04 §Index standard).
--
-- ## No PII / no raw payloads (ADR-0022 §3/§8, issue #875 out-of-scope)
--
-- A usage event stores an exact numeric `quantity` (bigint — NEVER float) plus
-- a bounded map of ADMITTED dimensions (short scalar keys/values only, gated by
-- `domain/dimension-admission.ts`) — NEVER raw request bodies, documents,
-- secrets, or arbitrary JSON. The #874 meter descriptor is numeric-only by
-- design; its `privacyClassification` governs whether a pseudonymous
-- distinct-count key may be recorded at all.
--
-- ## Idempotency identity (issue #875 security requirement)
--
-- A producer event's identity binds (tenant, producer, meter, source_event_id,
-- source_version) via a UNIQUE index. A duplicate producer event (same 5-tuple)
-- is counted ONCE: the append port INSERTs `ON CONFLICT DO NOTHING RETURNING`
-- and replays the winning row. Corrections carry their OWN idempotency identity.
--
-- ## Immutability / determinism (ADR-0022 §9, epic pattern #4)
--
--   - usage_events / usage_corrections: fully APPEND-ONLY (no UPDATE/DELETE) —
--     the immutable source of truth. Corrections LINK to the original event and
--     never mutate it (append-only reversal/adjustment, ADR-0005).
--   - usage_aggregates: a deterministic MATERIALIZATION reproducible from the
--     immutable events+corrections (rebuild reproduces stored values). Window
--     IDENTITY (tenant, meter, type, start) is frozen; `source_watermark` only
--     advances; `window_closed` is one-way (false -> true); never hard-deleted.
--   - usage_aggregation_cursors: the worker LEASE + WRITE-ONCE checkpoint. The
--     checkpoint (`checkpoint_seq`) only advances forward (one-way, never
--     rewound — a crashed/replayed run re-processes the same page and, because
--     aggregation is recompute-from-source, never double-counts); identity
--     frozen; never hard-deleted.
--   - usage_reconciliation_runs: APPEND-ONLY immutable evidence of each
--     recompute-vs-stored comparison.
-- Enforced by BEFORE triggers (defence in depth beneath `application/*`) AND
-- least-privilege grant REVOKEs.
--
-- No secret/provider credential is ever stored here (ADR-0022 §3/§6).

-- A SHARED ingest sequence drawn by BOTH the events and corrections tables, so
-- the aggregation worker can cursor the merged event+correction stream with a
-- SINGLE checkpoint (`checkpoint_seq`). A per-table IDENTITY would give two
-- independent sequences a single cursor could not order.
--
-- IMPORTANT — ingest_seq is NOT commit-ordered. `nextval` is drawn at INSERT
-- time, not at COMMIT: a transaction that draws a LOWER ingest_seq can COMMIT
-- AFTER a transaction that drew a HIGHER one, so a strictly ascending cursor
-- (`checkpoint_seq`) CAN advance past a lower-seq row that commits late. This is
-- a real COMMIT-REORDER hazard, NOT merely a gap from a rolled-back insert:
-- absent any backstop, a late-committing lower-seq event landing in a window
-- that has NO later event to re-touch it (and is NEVER reconciled) would be
-- permanently UNDER-counted by cursor-driven aggregation. The cursor gives
-- forward progress + resumability, NOT exactly-once completeness.
--
-- Two MANDATORY backstops make this safe (see application/aggregation-engine.ts
-- + reconciliation.ts, and the README "reconciliation as a required operational
-- backstop" section):
--   (a) RECOMPUTE-FROM-SOURCE: a window is never incrementally accumulated —
--       `recomputeWindow` re-reads the ENTIRE window by `event_time` (not by
--       ingest order), so ANY later event/correction touching that same window
--       pulls the late-committed lower-seq row back in and corrects the value.
--   (b) SCHEDULED RECONCILIATION: `runReconciliation` independently recomputes
--       each window from the immutable source and flags `missing`/`drift` — the
--       authoritative safety net for a window the cursor advanced past that no
--       later event re-touched. It is REQUIRED, not optional; operations MUST
--       alarm on `missing_count > 0` / `drift_count > 0`.
-- (A true safe-watermark cursor that never advances past an uncommitted lower
-- seq is a deliberate follow-up; this migration's guarantee is (a)+(b).)
--
-- Least-privilege: only the app role (which INSERTs events/corrections) needs USAGE.
CREATE SEQUENCE IF NOT EXISTS awcms_mini_usage_ingest_seq AS bigint;

-- =====================================================================
-- 1. `awcms_mini_usage_events` — the immutable, append-only source of truth.
--    One row per admitted meter event a producing module emitted in its own
--    commit. `ingest_seq` is a global monotonically-increasing value the
--    aggregation worker cursors on (a transactional outbox the worker drains).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingest_seq bigint NOT NULL DEFAULT nextval('awcms_mini_usage_ingest_seq'),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  meter_key text NOT NULL,
  producer text NOT NULL,
  source_event_id text NOT NULL,
  source_version integer NOT NULL DEFAULT 1,
  value_type text NOT NULL,
  aggregation text NOT NULL,
  quantity bigint NOT NULL,
  unique_dimension text,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_time timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_usage_events_meter_key_format_check
    CHECK (meter_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(meter_key) <= 120),
  CONSTRAINT awcms_mini_usage_events_producer_format_check
    CHECK (producer ~ '^[a-z][a-z0-9_]*$' AND length(producer) <= 100),
  CONSTRAINT awcms_mini_usage_events_source_event_id_check
    CHECK (length(source_event_id) BETWEEN 1 AND 200),
  CONSTRAINT awcms_mini_usage_events_source_version_check
    CHECK (source_version >= 1),
  CONSTRAINT awcms_mini_usage_events_value_type_check
    CHECK (value_type IN ('count', 'gauge', 'amount_minor', 'duration_seconds', 'bytes')),
  CONSTRAINT awcms_mini_usage_events_aggregation_check
    CHECK (aggregation IN ('sum', 'max', 'last', 'unique_count')),
  -- A source event's quantity is ALWAYS non-negative and bounded to
  -- Number.MAX_SAFE_INTEGER (read via Number(...)); a decrease is a signed
  -- CORRECTION, never a negative source event.
  CONSTRAINT awcms_mini_usage_events_quantity_bounds_check
    CHECK (quantity BETWEEN 0 AND 9007199254740991),
  CONSTRAINT awcms_mini_usage_events_unique_dimension_check
    CHECK (unique_dimension IS NULL OR length(unique_dimension) BETWEEN 1 AND 200),
  -- Admitted dimensions are a SMALL numeric/short-scalar map, never a raw
  -- payload — the byte cap is a defence-in-depth backstop beneath
  -- `domain/dimension-admission.ts` (which caps key count + value shape).
  CONSTRAINT awcms_mini_usage_events_dimensions_object_check
    CHECK (jsonb_typeof(dimensions) = 'object'),
  CONSTRAINT awcms_mini_usage_events_dimensions_size_check
    CHECK (length(dimensions::text) <= 2000)
);

-- Idempotency identity: at most ONE row per (tenant, producer, meter,
-- source_event_id, source_version). A duplicate producer event hits this index
-- and is turned into a replayed winning row (ON CONFLICT DO NOTHING), counted
-- exactly once (issue #875 AC "duplicate producer events are counted once").
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_usage_events_idempotency_key
  ON awcms_mini_usage_events (tenant_id, producer, meter_key, source_event_id, source_version);

-- The worker cursor: process events in global ingest order, per tenant.
CREATE INDEX IF NOT EXISTS awcms_mini_usage_events_ingest_idx
  ON awcms_mini_usage_events (tenant_id, ingest_seq);

-- Window recompute: read every event for a meter in an event-time window.
CREATE INDEX IF NOT EXISTS awcms_mini_usage_events_window_idx
  ON awcms_mini_usage_events (tenant_id, meter_key, event_time);

-- Retention purge cursor (delegated to data_lifecycle) — bounded age-based delete.
CREATE INDEX IF NOT EXISTS awcms_mini_usage_events_retention_idx
  ON awcms_mini_usage_events (tenant_id, received_at);

ALTER TABLE awcms_mini_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_usage_events FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_usage_events_tenant_isolation
  ON awcms_mini_usage_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 2. `awcms_mini_usage_corrections` — append-only signed corrections/reversals
--    LINKED to the original event, applied to the window of the original
--    event's `event_time`. Only meaningful for meters whose #874 descriptor
--    declares `correction: "signed_delta"` (enforced by the application layer);
--    NEVER mutates the immutable source event.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_usage_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingest_seq bigint NOT NULL DEFAULT nextval('awcms_mini_usage_ingest_seq'),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  original_event_id uuid NOT NULL REFERENCES awcms_mini_usage_events (id),
  meter_key text NOT NULL,
  correction_type text NOT NULL,
  delta_quantity bigint NOT NULL,
  reason text NOT NULL,
  producer text NOT NULL,
  source_event_id text NOT NULL,
  source_version integer NOT NULL DEFAULT 1,
  event_time timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_usage_corrections_meter_key_format_check
    CHECK (meter_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(meter_key) <= 120),
  CONSTRAINT awcms_mini_usage_corrections_type_check
    CHECK (correction_type IN ('reversal', 'adjustment')),
  -- A signed delta bounded symmetrically to +/- Number.MAX_SAFE_INTEGER (the
  -- integer-precision floor/ceiling read via Number(...)).
  CONSTRAINT awcms_mini_usage_corrections_delta_bounds_check
    CHECK (delta_quantity BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT awcms_mini_usage_corrections_reason_length_check
    CHECK (length(reason) BETWEEN 1 AND 500),
  CONSTRAINT awcms_mini_usage_corrections_producer_format_check
    CHECK (producer ~ '^[a-z][a-z0-9_]*$' AND length(producer) <= 100),
  CONSTRAINT awcms_mini_usage_corrections_source_event_id_check
    CHECK (length(source_event_id) BETWEEN 1 AND 200),
  CONSTRAINT awcms_mini_usage_corrections_source_version_check
    CHECK (source_version >= 1)
);

-- Idempotency identity for corrections (same shape as events).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_usage_corrections_idempotency_key
  ON awcms_mini_usage_corrections (tenant_id, producer, meter_key, source_event_id, source_version);

CREATE INDEX IF NOT EXISTS awcms_mini_usage_corrections_ingest_idx
  ON awcms_mini_usage_corrections (tenant_id, ingest_seq);

CREATE INDEX IF NOT EXISTS awcms_mini_usage_corrections_window_idx
  ON awcms_mini_usage_corrections (tenant_id, meter_key, event_time);

CREATE INDEX IF NOT EXISTS awcms_mini_usage_corrections_original_idx
  ON awcms_mini_usage_corrections (tenant_id, original_event_id);

-- Retention purge cursor (delegated to data_lifecycle).
CREATE INDEX IF NOT EXISTS awcms_mini_usage_corrections_retention_idx
  ON awcms_mini_usage_corrections (tenant_id, received_at);

ALTER TABLE awcms_mini_usage_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_usage_corrections FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_usage_corrections_tenant_isolation
  ON awcms_mini_usage_corrections
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 3. `awcms_mini_usage_aggregates` — the DETERMINISTIC materialized window.
--    Reproducible from the immutable events+corrections (rebuild reproduces the
--    stored value + content_hash). The worker UPSERTs these; window IDENTITY is
--    frozen and `window_closed` is one-way.
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_usage_aggregates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  meter_key text NOT NULL,
  window_type text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  value_type text NOT NULL,
  aggregation text NOT NULL,
  aggregate_value bigint NOT NULL DEFAULT 0,
  event_count bigint NOT NULL DEFAULT 0,
  correction_count bigint NOT NULL DEFAULT 0,
  distinct_count bigint,
  last_event_time timestamptz,
  late_event_count bigint NOT NULL DEFAULT 0,
  source_watermark bigint NOT NULL DEFAULT 0,
  content_hash text NOT NULL,
  window_closed boolean NOT NULL DEFAULT false,
  rebuild_count integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_usage_aggregates_meter_key_format_check
    CHECK (meter_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(meter_key) <= 120),
  CONSTRAINT awcms_mini_usage_aggregates_window_type_check
    CHECK (window_type IN ('hour', 'day', 'month')),
  CONSTRAINT awcms_mini_usage_aggregates_window_range_check
    CHECK (window_end > window_start),
  CONSTRAINT awcms_mini_usage_aggregates_value_type_check
    CHECK (value_type IN ('count', 'gauge', 'amount_minor', 'duration_seconds', 'bytes')),
  CONSTRAINT awcms_mini_usage_aggregates_aggregation_check
    CHECK (aggregation IN ('sum', 'max', 'last', 'unique_count')),
  -- The aggregate value bounded to +/- Number.MAX_SAFE_INTEGER (a sum of signed
  -- corrections can dip below zero for a signed_delta meter; a non-negative
  -- clamp is applied at read time per the meter's floor, not stored here).
  CONSTRAINT awcms_mini_usage_aggregates_value_bounds_check
    CHECK (aggregate_value BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT awcms_mini_usage_aggregates_counts_check
    CHECK (event_count >= 0 AND correction_count >= 0 AND late_event_count >= 0
           AND (distinct_count IS NULL OR distinct_count >= 0))
);

-- One aggregate per (tenant, meter, window_type, window_start): the worker's
-- UPSERT target and the deterministic window identity.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_usage_aggregates_window_key
  ON awcms_mini_usage_aggregates (tenant_id, meter_key, window_type, window_start);

CREATE INDEX IF NOT EXISTS awcms_mini_usage_aggregates_lookup_idx
  ON awcms_mini_usage_aggregates (tenant_id, meter_key, window_type, window_start DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_usage_aggregates_freshness_idx
  ON awcms_mini_usage_aggregates (tenant_id, computed_at DESC);

ALTER TABLE awcms_mini_usage_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_usage_aggregates FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_usage_aggregates_tenant_isolation
  ON awcms_mini_usage_aggregates
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 4. `awcms_mini_usage_aggregation_cursors` — the worker LEASE + WRITE-ONCE
--    checkpoint, one row per (tenant, shard). `checkpoint_seq` advances forward
--    only (one-way); `lease_holder`/`lease_expires_at` make a crashed run's
--    lease reclaimable (worker-restart). A rebuild request is a flag the worker
--    consumes (a full recompute leaves the checkpoint where it is).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_usage_aggregation_cursors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  shard_key text NOT NULL DEFAULT 'default',
  checkpoint_seq bigint NOT NULL DEFAULT 0,
  lease_holder text,
  lease_expires_at timestamptz,
  status text NOT NULL DEFAULT 'idle',
  last_run_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  processed_event_total bigint NOT NULL DEFAULT 0,
  rebuild_requested_at timestamptz,
  rebuild_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_usage_cursors_shard_key_check
    CHECK (shard_key ~ '^[a-z][a-z0-9_]*$' AND length(shard_key) <= 60),
  CONSTRAINT awcms_mini_usage_cursors_status_check
    CHECK (status IN ('idle', 'leased', 'error')),
  CONSTRAINT awcms_mini_usage_cursors_checkpoint_check
    CHECK (checkpoint_seq >= 0),
  CONSTRAINT awcms_mini_usage_cursors_failures_check
    CHECK (consecutive_failures >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_usage_cursors_shard_key
  ON awcms_mini_usage_aggregation_cursors (tenant_id, shard_key);

ALTER TABLE awcms_mini_usage_aggregation_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_usage_aggregation_cursors FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_usage_cursors_tenant_isolation
  ON awcms_mini_usage_aggregation_cursors
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- 5. `awcms_mini_usage_reconciliation_runs` — append-only immutable evidence of
--    each recompute-vs-stored comparison. A run recomputes windows from the
--    immutable events+corrections and records how many windows drifted from the
--    stored aggregate (the "reconciliation as the final source of truth" AC).
--    The report is BOUNDED + numeric-only (window keys + expected/stored values,
--    never PII).
-- =====================================================================
CREATE TABLE IF NOT EXISTS awcms_mini_usage_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  meter_key text,
  window_type text NOT NULL,
  range_from timestamptz NOT NULL,
  range_to timestamptz NOT NULL,
  status text NOT NULL,
  windows_checked bigint NOT NULL DEFAULT 0,
  drift_count bigint NOT NULL DEFAULT 0,
  missing_count bigint NOT NULL DEFAULT 0,
  report jsonb NOT NULL DEFAULT '[]'::jsonb,
  correlation_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_usage_recon_meter_key_format_check
    CHECK (meter_key IS NULL OR (meter_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(meter_key) <= 120)),
  CONSTRAINT awcms_mini_usage_recon_window_type_check
    CHECK (window_type IN ('hour', 'day', 'month')),
  CONSTRAINT awcms_mini_usage_recon_range_check
    CHECK (range_to > range_from),
  CONSTRAINT awcms_mini_usage_recon_status_check
    CHECK (status IN ('consistent', 'drift_detected', 'failed')),
  CONSTRAINT awcms_mini_usage_recon_counts_check
    CHECK (windows_checked >= 0 AND drift_count >= 0 AND missing_count >= 0),
  CONSTRAINT awcms_mini_usage_recon_report_object_check
    CHECK (jsonb_typeof(report) = 'array'),
  CONSTRAINT awcms_mini_usage_recon_report_size_check
    CHECK (length(report::text) <= 200000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_usage_recon_tenant_idx
  ON awcms_mini_usage_reconciliation_runs (tenant_id, started_at DESC);

ALTER TABLE awcms_mini_usage_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_usage_reconciliation_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_usage_recon_tenant_isolation
  ON awcms_mini_usage_reconciliation_runs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =====================================================================
-- Immutability / write-once triggers (defence in depth beneath the app guard)
-- =====================================================================

-- Content-immutability guard: reject any UPDATE (a usage event/correction is
-- NEVER edited in place — a decrease is a signed correction, never an edit).
-- DELETE is NOT blocked here: it is reserved for the GOVERNED retention purge
-- (delegated to `data_lifecycle`, legal-hold-respecting, worker-role only, app
-- role REVOKE'd) — exactly the append-only-with-retention model
-- `awcms_mini_audit_events` (logging) already uses for a high-volume evidence
-- table. Reconciliation runs (below) ARE fully immutable (no UPDATE/DELETE).
CREATE OR REPLACE FUNCTION awcms_mini_usage_guard_no_update()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'usage_metering: % rows are never edited in place (a usage event/correction is immutable; a decrease is a signed correction)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_usage_events_no_update
  BEFORE UPDATE ON awcms_mini_usage_events
  FOR EACH ROW EXECUTE FUNCTION awcms_mini_usage_guard_no_update();

CREATE TRIGGER awcms_mini_usage_corrections_no_update
  BEFORE UPDATE ON awcms_mini_usage_corrections
  FOR EACH ROW EXECUTE FUNCTION awcms_mini_usage_guard_no_update();

-- Reconciliation runs: fully append-only immutable evidence (no UPDATE/DELETE).
CREATE OR REPLACE FUNCTION awcms_mini_usage_guard_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'usage_metering: % rows are append-only (no UPDATE/DELETE) — reconciliation runs are immutable evidence', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_usage_recon_append_only
  BEFORE UPDATE OR DELETE ON awcms_mini_usage_reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION awcms_mini_usage_guard_append_only();

-- Aggregate: the deterministic materialization may be RECOMPUTED (UPDATE), but
-- its window IDENTITY is frozen, `source_watermark` only advances (monotonic),
-- and `window_closed` is one-way (false -> true). Never hard-deleted.
CREATE OR REPLACE FUNCTION awcms_mini_usage_guard_aggregate_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.meter_key <> OLD.meter_key
     OR NEW.window_type <> OLD.window_type
     OR NEW.window_start <> OLD.window_start
     OR NEW.window_end <> OLD.window_end
     OR NEW.value_type <> OLD.value_type
     OR NEW.aggregation <> OLD.aggregation
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'usage_metering: aggregate % window identity is immutable (a window is re-computed in place, never re-keyed)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source_watermark < OLD.source_watermark THEN
    RAISE EXCEPTION 'usage_metering: aggregate % source_watermark is monotonic (a recompute never rewinds the watermark)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.window_closed AND NOT NEW.window_closed THEN
    RAISE EXCEPTION 'usage_metering: aggregate % window_closed is one-way (a closed window stays closed; late events still recompute its value)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_usage_aggregates_immutability
  BEFORE UPDATE ON awcms_mini_usage_aggregates
  FOR EACH ROW EXECUTE FUNCTION awcms_mini_usage_guard_aggregate_immutability();

CREATE OR REPLACE FUNCTION awcms_mini_usage_guard_no_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'usage_metering: % rows are never hard-deleted (deterministic materialization + resumable checkpoint)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_usage_aggregates_no_delete
  BEFORE DELETE ON awcms_mini_usage_aggregates
  FOR EACH ROW EXECUTE FUNCTION awcms_mini_usage_guard_no_delete();

-- Cursor: identity frozen; the checkpoint (`checkpoint_seq`) only advances
-- forward (write-once/one-way) — a crashed or replayed run re-processes the
-- same page and, because aggregation is recompute-from-source, never
-- double-counts. Lease/status/rebuild bookkeeping is mutable. Never deleted.
CREATE OR REPLACE FUNCTION awcms_mini_usage_guard_cursor_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.shard_key <> OLD.shard_key
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'usage_metering: cursor % identity is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.checkpoint_seq < OLD.checkpoint_seq THEN
    RAISE EXCEPTION 'usage_metering: cursor % checkpoint_seq is monotonic forward (a checkpoint is never rewound)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER awcms_mini_usage_cursors_immutability
  BEFORE UPDATE ON awcms_mini_usage_aggregation_cursors
  FOR EACH ROW EXECUTE FUNCTION awcms_mini_usage_guard_cursor_immutability();

CREATE TRIGGER awcms_mini_usage_cursors_no_delete
  BEFORE DELETE ON awcms_mini_usage_aggregation_cursors
  FOR EACH ROW EXECUTE FUNCTION awcms_mini_usage_guard_no_delete();

-- =====================================================================
-- Least-privilege grants (ADR-0022 §12, epic pattern — least privilege)
-- =====================================================================
--
-- The runtime `awcms_mini_app` role auto-inherits SELECT/INSERT/UPDATE/DELETE
-- on every new table (migration 013's ALTER DEFAULT PRIVILEGES). We narrow it:
--   - events / corrections / reconciliation_runs : append-only -> REVOKE
--     UPDATE + DELETE (INSERT + SELECT remain: ingest, correct, reconcile).
--   - aggregates : materialized ONLY by the worker -> the app role reads them
--     (for the API/port) but never writes them -> REVOKE INSERT + UPDATE +
--     DELETE.
--   - cursors : the app role may create a cursor row and flag a rebuild request
--     (partial UPDATE), never delete -> REVOKE DELETE only.
REVOKE UPDATE, DELETE ON awcms_mini_usage_events FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_usage_corrections FROM awcms_mini_app;
REVOKE UPDATE, DELETE ON awcms_mini_usage_reconciliation_runs FROM awcms_mini_app;
REVOKE INSERT, UPDATE, DELETE ON awcms_mini_usage_aggregates FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_usage_aggregation_cursors FROM awcms_mini_app;

-- The app role draws the shared ingest sequence when it INSERTs an event or a
-- correction; the worker never inserts either, so only the app role needs it.
GRANT USAGE ON SEQUENCE awcms_mini_usage_ingest_seq TO awcms_mini_app;

-- The narrower `awcms_mini_worker` role (migration 045) does NOT auto-inherit
-- the default privileges; it needs explicit grants for exactly what the
-- aggregation worker touches: READ the immutable source, WRITE the materialized
-- aggregates + advance the checkpoint, and iterate active tenants. It never
-- writes events/corrections/reconciliation_runs (those are app/route-driven)
-- and never DELETEs anything.
-- The worker also runs the delegated, legal-hold-respecting retention purge
-- (`bun run usage-metering:purge`) -> it needs DELETE on the source tables (the
-- ONLY DELETE path; the app role is REVOKE'd above).
GRANT SELECT, DELETE ON awcms_mini_usage_events TO awcms_mini_worker;
GRANT SELECT, DELETE ON awcms_mini_usage_corrections TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_mini_usage_aggregates TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_mini_usage_aggregation_cursors TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_tenants TO awcms_mini_worker;
