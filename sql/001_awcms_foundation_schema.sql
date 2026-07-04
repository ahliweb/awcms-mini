-- 001 — Foundation schema AWCMS-Mini (doc 04/11/16).
-- Catatan: runner (scripts/db-migrate.ts) membungkus tiap file dalam satu
-- transaction — jangan menulis BEGIN/COMMIT di dalam file migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Ledger migration (runner juga membuat tabel ini saat bootstrap).
CREATE TABLE IF NOT EXISTS awcms_schema_migrations (
  id bigserial PRIMARY KEY,
  migration_name text NOT NULL UNIQUE,
  checksum text,
  executed_at timestamptz NOT NULL DEFAULT now()
);

-- Registry modul modular monolith (module contract doc 10).
CREATE TABLE IF NOT EXISTS awcms_modules (
  module_key text PRIMARY KEY,
  module_name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'experimental', 'deprecated')),
  version text NOT NULL DEFAULT '0.1.0',
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Event sistem level aplikasi (bukan domain event antar modul).
CREATE TABLE IF NOT EXISTS awcms_system_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'warning', 'critical')),
  message text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_awcms_system_events_created
  ON awcms_system_events (created_at DESC);

-- Idempotency store lintas modul (doc 10/16; retention 7-30 hari, doc 04).
CREATE TABLE IF NOT EXISTS awcms_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_awcms_idempotency_keys_tenant_created
  ON awcms_idempotency_keys (tenant_id, created_at DESC);

ALTER TABLE awcms_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_idempotency_keys_tenant_isolation ON awcms_idempotency_keys;
CREATE POLICY awcms_idempotency_keys_tenant_isolation
  ON awcms_idempotency_keys
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
