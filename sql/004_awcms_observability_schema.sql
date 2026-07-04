-- 004 — Observability: log, audit, security event (doc 04, modul observability-logging).
-- Tanpa BEGIN/COMMIT — runner membungkus dalam transaction.
-- Attributes SELALU sudah di-redact di application layer sebelum insert.

CREATE TABLE IF NOT EXISTS awcms_log_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  level text NOT NULL DEFAULT 'info'
    CHECK (level IN ('debug', 'info', 'warn', 'error')),
  module_key text,
  message text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_awcms_log_events_tenant_created
  ON awcms_log_events (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS awcms_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  actor_tenant_user_id uuid REFERENCES awcms_tenant_users (id),
  module_key text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  severity text NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'warning', 'critical')),
  message text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_awcms_audit_events_tenant_created
  ON awcms_audit_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_awcms_audit_events_actor
  ON awcms_audit_events (actor_tenant_user_id);
CREATE INDEX IF NOT EXISTS idx_awcms_audit_events_resource
  ON awcms_audit_events (tenant_id, resource_type, resource_id);

CREATE TABLE IF NOT EXISTS awcms_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'critical')),
  message text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_awcms_security_events_tenant_created
  ON awcms_security_events (tenant_id, created_at DESC);

-- ============ RLS tenant isolation ============

ALTER TABLE awcms_log_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_log_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_log_events_tenant_isolation ON awcms_log_events;
CREATE POLICY awcms_log_events_tenant_isolation ON awcms_log_events
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE awcms_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_audit_events_tenant_isolation ON awcms_audit_events;
CREATE POLICY awcms_audit_events_tenant_isolation ON awcms_audit_events
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE awcms_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_security_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_security_events_tenant_isolation ON awcms_security_events;
CREATE POLICY awcms_security_events_tenant_isolation ON awcms_security_events
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
