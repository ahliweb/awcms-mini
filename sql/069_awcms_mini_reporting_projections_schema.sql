-- Issue #753 (epic #738 platform-evolution, Wave 3) — reporting module
-- extension: module-contributed read-model projections, incremental
-- updates, idempotent rebuild, freshness/staleness, source reconciliation,
-- and scheduled exports. Seven tables, ALL tenant-scoped
-- (`ENABLE`+`FORCE ROW LEVEL SECURITY`) — `reporting` NEVER writes another
-- module's transactional table; every projection descriptor (source
-- table/cursor column/metric rules) lives in CODE
-- (`ModuleDescriptor.reportingProjections`, `src/modules/_shared/
-- module-contract.ts`), declared by each owning module's own `module.ts` —
-- never mirrored into a database table here (same "do not duplicate
-- immutable descriptor facts in mutable settings" rule Issue #745
-- established for `data_lifecycle`).
--
-- 1. `awcms_mini_reporting_projection_state` — per (tenant, projection)
--    freshness bookkeeping: last attempt/success timestamps, consecutive
--    failure count, last error. Read-time-computed freshness status
--    (`reporting/domain/freshness.ts`) is derived from these raw facts,
--    never stored as a cached enum (a stalled/broken worker must silently
--    age this projection's reported status toward "stale", not freeze a
--    stale "current" value forever).
-- 2. `awcms_mini_reporting_projection_cursors` — per (tenant, projection,
--    stream) bounded-scan resume position, shared by BOTH the steady-state
--    incremental worker and a rebuild-in-progress (mutually exclusive by
--    construction — see `awcms_mini_reporting_rebuild_runs`' partial
--    unique index below and `application/projection-incremental-
--    worker.ts`'s rebuild-in-progress guard).
-- 3. `awcms_mini_reporting_projection_metrics` — the actual materialized
--    read-model values: one non-negative counter per (tenant, projection,
--    metric).
-- 4. `awcms_mini_reporting_rebuild_runs` — rebuild execution/progress
--    state. Only ONE `status = 'running'` row may exist per (tenant,
--    projection) at a time (enforced by the partial unique index below,
--    not application code alone) — this is what makes "trigger rebuild
--    while one is already running" resume the SAME run instead of
--    resetting progress, and is the core mechanism behind this issue's
--    crash-mid-rebuild idempotency guarantee (see that file's own header
--    comment for the full design rationale).
-- 5. `awcms_mini_reporting_reconciliation_runs` — on-demand comparisons of
--    a projection's metric value against a freshly computed control total
--    from its source table(s).
-- 6. `awcms_mini_reporting_scheduled_exports` — tenant-configured periodic
--    export descriptors (soft-deletable config, doc 04/AGENTS.md rule 13).
-- 7. `awcms_mini_reporting_export_runs` — manifest/checksum/expiry evidence
--    for each executed export (manual or scheduled).
CREATE TABLE IF NOT EXISTS awcms_mini_reporting_projection_state (
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  projection_key text NOT NULL,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_error_message text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, projection_key),
  CONSTRAINT awcms_mini_reporting_projection_state_key_format_check
    CHECK (projection_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_reporting_projection_state_failures_check
    CHECK (consecutive_failures >= 0)
);

ALTER TABLE awcms_mini_reporting_projection_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_reporting_projection_state FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_reporting_projection_state_tenant_isolation
  ON awcms_mini_reporting_projection_state
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_reporting_projection_cursors (
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  projection_key text NOT NULL,
  stream_key text NOT NULL,
  cursor_value timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, projection_key, stream_key),
  CONSTRAINT awcms_mini_reporting_projection_cursors_key_format_check
    CHECK (projection_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')
);

ALTER TABLE awcms_mini_reporting_projection_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_reporting_projection_cursors FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_reporting_projection_cursors_tenant_isolation
  ON awcms_mini_reporting_projection_cursors
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_reporting_projection_metrics (
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  projection_key text NOT NULL,
  metric_key text NOT NULL,
  metric_value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, projection_key, metric_key),
  CONSTRAINT awcms_mini_reporting_projection_metrics_key_format_check
    CHECK (projection_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_reporting_projection_metrics_value_check
    CHECK (metric_value >= 0)
);

ALTER TABLE awcms_mini_reporting_projection_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_reporting_projection_metrics FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_reporting_projection_metrics_tenant_isolation
  ON awcms_mini_reporting_projection_metrics
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_reporting_rebuild_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  projection_key text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  rows_processed bigint NOT NULL DEFAULT 0,
  cancel_requested boolean NOT NULL DEFAULT false,
  requested_by uuid,
  reason text,
  error_message text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_reporting_rebuild_runs_key_format_check
    CHECK (projection_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_reporting_rebuild_runs_status_check
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT awcms_mini_reporting_rebuild_runs_rows_processed_check
    CHECK (rows_processed >= 0)
);

-- The single most important constraint in this migration: guarantees, at
-- the database level (not merely application-code discipline), that at
-- most one rebuild of a given (tenant, projection) can ever be
-- `'running'` at a time. A concurrent second "trigger rebuild" call
-- (double HTTP submit racing past the Idempotency-Key check, or a retried
-- request with a DIFFERENT Idempotency-Key) fails this unique index
-- instead of starting a second reset that would race the first run's
-- cursor/metric writes and risk double-counting.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_reporting_rebuild_runs_running_unique
  ON awcms_mini_reporting_rebuild_runs (tenant_id, projection_key)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS awcms_mini_reporting_rebuild_runs_history_idx
  ON awcms_mini_reporting_rebuild_runs (tenant_id, projection_key, created_at DESC);

ALTER TABLE awcms_mini_reporting_rebuild_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_reporting_rebuild_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_reporting_rebuild_runs_tenant_isolation
  ON awcms_mini_reporting_rebuild_runs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_reporting_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  projection_key text NOT NULL,
  mismatch boolean NOT NULL,
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by uuid,
  correlation_id text,
  executed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_reporting_reconciliation_runs_key_format_check
    CHECK (projection_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')
);

CREATE INDEX IF NOT EXISTS awcms_mini_reporting_reconciliation_runs_history_idx
  ON awcms_mini_reporting_reconciliation_runs (tenant_id, projection_key, executed_at DESC);

ALTER TABLE awcms_mini_reporting_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_reporting_reconciliation_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_reporting_reconciliation_runs_tenant_isolation
  ON awcms_mini_reporting_reconciliation_runs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_reporting_scheduled_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  projection_key text NOT NULL,
  format text NOT NULL,
  schedule_interval_minutes integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_reporting_scheduled_exports_key_format_check
    CHECK (projection_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_reporting_scheduled_exports_format_check
    CHECK (format IN ('csv', 'json')),
  CONSTRAINT awcms_mini_reporting_scheduled_exports_interval_check
    CHECK (schedule_interval_minutes > 0)
);

CREATE INDEX IF NOT EXISTS awcms_mini_reporting_scheduled_exports_active_idx
  ON awcms_mini_reporting_scheduled_exports (tenant_id, enabled)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_mini_reporting_scheduled_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_reporting_scheduled_exports FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_reporting_scheduled_exports_tenant_isolation
  ON awcms_mini_reporting_scheduled_exports
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_reporting_export_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  scheduled_export_id uuid REFERENCES awcms_mini_reporting_scheduled_exports (id),
  projection_key text NOT NULL,
  format text NOT NULL,
  status text NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  checksum_sha256 text,
  storage_path text,
  error_message text,
  expires_at timestamptz,
  requested_by uuid,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT awcms_mini_reporting_export_runs_key_format_check
    CHECK (projection_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_reporting_export_runs_format_check
    CHECK (format IN ('csv', 'json')),
  CONSTRAINT awcms_mini_reporting_export_runs_status_check
    CHECK (status IN ('completed', 'failed')),
  CONSTRAINT awcms_mini_reporting_export_runs_row_count_check
    CHECK (row_count >= 0)
);

CREATE INDEX IF NOT EXISTS awcms_mini_reporting_export_runs_history_idx
  ON awcms_mini_reporting_export_runs (tenant_id, projection_key, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_reporting_export_runs_expiry_idx
  ON awcms_mini_reporting_export_runs (tenant_id, expires_at);

ALTER TABLE awcms_mini_reporting_export_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_reporting_export_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_reporting_export_runs_tenant_isolation
  ON awcms_mini_reporting_export_runs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `awcms_mini_worker` least-privilege role (migration 045) — extends its
-- grant matrix for the scheduled `bun run reporting:projections:refresh`
-- and `bun run reporting:exports:dispatch` jobs (Issue #753). Migration
-- 013's `ALTER DEFAULT PRIVILEGES` only grants the ordinary runtime
-- `awcms_mini_app` role automatically (see that migration's own header) —
-- the narrower `awcms_mini_worker` role always needs an explicit per-table
-- grant here, exactly the DML these two scripts issue when they run
-- against `WORKER_DATABASE_URL` (doc 18's hardened deployment path):
--   - `awcms_mini_reporting_projection_state`/`_cursors`/`_metrics`:
--     SELECT + INSERT + UPDATE — the incremental worker's own bounded
--     cursor passes and freshness bookkeeping upserts.
--   - `awcms_mini_reporting_rebuild_runs`: SELECT + UPDATE only, never
--     INSERT — a NEW rebuild run row is created exclusively by the API
--     route (`awcms_mini_app`, the caller's own request), which also
--     performs the reset step in the SAME transaction; the worker script
--     only CONTINUES an already-`'running'` row's bounded passes across
--     scheduled invocations.
--   - `awcms_mini_reporting_scheduled_exports`: SELECT only — the export
--     dispatch job reads config to decide what/when to export; creating,
--     enabling, or disabling a scheduled export stays an `awcms_mini_app`
--     admin API action.
--   - `awcms_mini_reporting_export_runs`: SELECT + INSERT + UPDATE — the
--     dispatch job writes its own new export-run manifests.
--   - `awcms_mini_reporting_reconciliation_runs` is deliberately NOT
--     granted here — reconciliation is on-demand-only via the API
--     (`awcms_mini_app`), no scheduled job touches this table.
--   - `awcms_mini_abac_decision_logs`/`awcms_mini_identities`/
--     `awcms_mini_sync_nodes`: SELECT only — the two representative
--     `cursor_table` projections' own incremental/rebuild source scans.
--     None of these three were previously granted to `awcms_mini_worker`
--     (verified against migration 045's own grant list) — a real,
--     previously-latent gap this issue's `provisionWorkerRole()`
--     integration test exists specifically to catch (see
--     `tests/integration/reporting-projections.integration.test.ts`).
--     `awcms_mini_domain_events` (SELECT, for the event-driven
--     projection's rebuild re-scan) is already granted by migration 056 —
--     not repeated here. `awcms_mini_tenants` (SELECT, tenant iteration)
--     is likewise already granted by migration 045.
GRANT SELECT, INSERT, UPDATE ON awcms_mini_reporting_projection_state TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_mini_reporting_projection_cursors TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_mini_reporting_projection_metrics TO awcms_mini_worker;
GRANT SELECT, UPDATE ON awcms_mini_reporting_rebuild_runs TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_reporting_scheduled_exports TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_mini_reporting_export_runs TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_abac_decision_logs TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_identities TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_sync_nodes TO awcms_mini_worker;
