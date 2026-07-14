-- Issue #752 (epic #738 platform-evolution, Wave 3, ADR-0017) —
-- `data_exchange` module schema: staged import batches, parsed/validated
-- staged rows, export jobs, reconciliation reports, and a self-contained
-- reference fixture table (`awcms_mini_data_exchange_reference_items`)
-- used to prove the mechanism end-to-end without touching any other
-- module's tables (ADR-0017 §10 — "foundation issue ships zero real
-- business integrations", same precedent as `domain_event_runtime`).
-- Five tables, all tenant-scoped (`ENABLE`+`FORCE ROW LEVEL SECURITY`),
-- `tenant_id` first in every composite index (doc 04 §RLS standard/§Index
-- standard).
--
-- 1. `awcms_mini_data_exchange_import_batches` — one row per staged
--    upload. `raw_content` stores the ORIGINAL file bytes (as UTF-8 text —
--    CSV/JSON are always text formats) inline, capped at the same 5 MiB
--    HTTP-layer tier the stage-upload endpoint enforces
--    (`src/lib/security/request-body-limit.ts`'s `large` tier) — no
--    external object storage dependency, so this module works fully
--    offline/LAN (ADR-0017 §5/§6). `checksum_sha256` is computed
--    SERVER-SIDE over `raw_content` at intake (never trusts a
--    client-declared value as the source of truth, matching
--    `news_media`'s established checksum-verification posture).
--    `commit_cursor` is the last successfully committed `row_number` —
--    the mechanism that makes a worker-restart-then-resume never
--    double-apply already-committed rows (Issue #752 acceptance
--    criterion). `paused_at` lets an operator pause a long-running
--    commit between passes; the worker skips a paused batch entirely.
-- 2. `awcms_mini_data_exchange_staged_rows` — one row per parsed source
--    record. `fields` is ALREADY formula-injection-neutralized (Issue
--    #752 security requirement) before this row is ever inserted — see
--    `domain/formula-injection-guard.ts`. `natural_key` is the owning
--    adapter's stable per-row identity, used for per-row commit
--    idempotency tracking.
-- 3. `awcms_mini_data_exchange_export_jobs` — one row per triggered
--    export. `file_content` (the export artifact) and `manifest`
--    (schema/version/filters/row count/checksum/creation metadata, Issue
--    #752 acceptance criterion) are populated once the job completes;
--    `NULL` while `queued`/`running`.
-- 4. `awcms_mini_data_exchange_reconciliation_reports` — append-only
--    (never updated/deleted by application code) source/processed
--    count+checksum comparison, one row per completed import commit pass
--    or export job.
-- 5. `awcms_mini_data_exchange_reference_items` — the self-contained
--    reference fixture (generic tenant-scoped code/label/value/status
--    rows) this module's own reference import/export descriptor pair
--    reads and writes, proving create/update/conflict, partial-failure/
--    resume, and export/reconciliation end-to-end.

CREATE TABLE IF NOT EXISTS awcms_mini_data_exchange_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  import_key text NOT NULL,
  format text NOT NULL,
  status text NOT NULL DEFAULT 'staged',
  original_filename text,
  byte_size integer NOT NULL,
  row_count integer,
  checksum_sha256 text NOT NULL,
  client_checksum_sha256 text,
  schema_version text,
  raw_content text NOT NULL,
  validate_cursor integer NOT NULL DEFAULT 0,
  commit_cursor integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  conflict_count integer NOT NULL DEFAULT 0,
  invalid_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  error_summary text,
  paused_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  committed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  CONSTRAINT awcms_mini_data_exchange_import_batches_format_check
    CHECK (format IN ('csv', 'json')),
  CONSTRAINT awcms_mini_data_exchange_import_batches_status_check
    CHECK (status IN (
      'staged', 'validating', 'previewed', 'committing',
      'committed', 'partially_committed', 'failed', 'cancelled'
    )),
  CONSTRAINT awcms_mini_data_exchange_import_batches_byte_size_check
    CHECK (byte_size > 0)
);

CREATE INDEX IF NOT EXISTS awcms_mini_data_exchange_import_batches_tenant_status_idx
  ON awcms_mini_data_exchange_import_batches (tenant_id, status, created_at);

CREATE INDEX IF NOT EXISTS awcms_mini_data_exchange_import_batches_tenant_key_idx
  ON awcms_mini_data_exchange_import_batches (tenant_id, import_key, created_at);

CREATE INDEX IF NOT EXISTS awcms_mini_data_exchange_import_batches_expiry_idx
  ON awcms_mini_data_exchange_import_batches (tenant_id, expires_at);

ALTER TABLE awcms_mini_data_exchange_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_data_exchange_import_batches FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_data_exchange_import_batches_tenant_isolation
  ON awcms_mini_data_exchange_import_batches
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_data_exchange_staged_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  import_batch_id uuid NOT NULL REFERENCES awcms_mini_data_exchange_import_batches (id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  fields jsonb NOT NULL,
  natural_key text,
  proposed_action text,
  validation_errors jsonb,
  validation_warnings jsonb,
  commit_status text NOT NULL DEFAULT 'pending',
  commit_resource_id text,
  commit_error text,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_data_exchange_staged_rows_row_number_check
    CHECK (row_number > 0),
  CONSTRAINT awcms_mini_data_exchange_staged_rows_proposed_action_check
    CHECK (proposed_action IS NULL OR proposed_action IN ('create', 'update', 'skip', 'conflict', 'invalid')),
  CONSTRAINT awcms_mini_data_exchange_staged_rows_commit_status_check
    CHECK (commit_status IN ('pending', 'committed', 'failed', 'skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_data_exchange_staged_rows_batch_row_key
  ON awcms_mini_data_exchange_staged_rows (tenant_id, import_batch_id, row_number);

-- The commit job's core query shape: "next pending rows for this batch,
-- in order" — covers both the tenant column and the columns the WHERE/
-- ORDER BY clause needs (import_batch_id, commit_status, row_number).
CREATE INDEX IF NOT EXISTS awcms_mini_data_exchange_staged_rows_commit_scan_idx
  ON awcms_mini_data_exchange_staged_rows (tenant_id, import_batch_id, commit_status, row_number);

ALTER TABLE awcms_mini_data_exchange_staged_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_data_exchange_staged_rows FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_data_exchange_staged_rows_tenant_isolation
  ON awcms_mini_data_exchange_staged_rows
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_data_exchange_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  export_key text NOT NULL,
  format text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  filter_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version text,
  row_count integer,
  checksum_sha256 text,
  file_content text,
  manifest jsonb,
  error_summary text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  CONSTRAINT awcms_mini_data_exchange_export_jobs_format_check
    CHECK (format IN ('csv', 'json')),
  CONSTRAINT awcms_mini_data_exchange_export_jobs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_data_exchange_export_jobs_tenant_status_idx
  ON awcms_mini_data_exchange_export_jobs (tenant_id, status, created_at);

CREATE INDEX IF NOT EXISTS awcms_mini_data_exchange_export_jobs_tenant_key_idx
  ON awcms_mini_data_exchange_export_jobs (tenant_id, export_key, created_at);

CREATE INDEX IF NOT EXISTS awcms_mini_data_exchange_export_jobs_expiry_idx
  ON awcms_mini_data_exchange_export_jobs (tenant_id, expires_at);

ALTER TABLE awcms_mini_data_exchange_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_data_exchange_export_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_data_exchange_export_jobs_tenant_isolation
  ON awcms_mini_data_exchange_export_jobs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_data_exchange_reconciliation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  source_count integer NOT NULL,
  processed_count integer NOT NULL,
  source_checksum_sha256 text,
  processed_checksum_sha256 text,
  mismatch boolean NOT NULL,
  details text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_data_exchange_reconciliation_reports_subject_type_check
    CHECK (subject_type IN ('import', 'export'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_data_exchange_reconciliation_reports_subject_idx
  ON awcms_mini_data_exchange_reconciliation_reports (tenant_id, subject_type, subject_id, created_at DESC);

ALTER TABLE awcms_mini_data_exchange_reconciliation_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_data_exchange_reconciliation_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_data_exchange_reconciliation_reports_tenant_isolation
  ON awcms_mini_data_exchange_reconciliation_reports
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_data_exchange_reference_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  code text NOT NULL,
  label text NOT NULL,
  value numeric(18, 4),
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_data_exchange_reference_items_status_check
    CHECK (status IN ('active', 'inactive'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_data_exchange_reference_items_tenant_code_key
  ON awcms_mini_data_exchange_reference_items (tenant_id, code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_data_exchange_reference_items_tenant_idx
  ON awcms_mini_data_exchange_reference_items (tenant_id, deleted_at);

ALTER TABLE awcms_mini_data_exchange_reference_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_data_exchange_reference_items FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_data_exchange_reference_items_tenant_isolation
  ON awcms_mini_data_exchange_reference_items
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `awcms_mini_worker` (Issue #683, migration 045) grants — the asynchronous
-- parse/validate/commit/export pipeline runs entirely on the worker role
-- (`bun run data-exchange:worker`, `WORKER_DATABASE_URL`), distinct from
-- the ordinary `awcms_mini_app` request path (already covered by migration
-- 013's blanket `ALTER DEFAULT PRIVILEGES` grant for every table below).
GRANT SELECT, UPDATE ON awcms_mini_data_exchange_import_batches TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_mini_data_exchange_staged_rows TO awcms_mini_worker;
GRANT SELECT, UPDATE ON awcms_mini_data_exchange_export_jobs TO awcms_mini_worker;
GRANT SELECT, INSERT ON awcms_mini_data_exchange_reconciliation_reports TO awcms_mini_worker;
GRANT SELECT, INSERT, UPDATE ON awcms_mini_data_exchange_reference_items TO awcms_mini_worker;
