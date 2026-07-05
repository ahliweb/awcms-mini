-- Issue 10.1 — Add Structured Logging and Audit Trail.
--
-- Adds the generic, cross-module audit trail table (`awcms_mini_audit_events`)
-- referenced by doc 10 §Audit helper and skill `awcms-mini-audit-log`. This is
-- separate from and complements the existing narrower audit tables
-- (`awcms_mini_profile_audit_logs` from migration 003, scoped to profile
-- lifecycle only, and `awcms_mini_abac_decision_logs` from migration 005,
-- scoped to ABAC allow/deny decisions only) — this table is the
-- general-purpose sink for any high-risk action across any module
-- (soft delete/restore/purge, login, price change, transaction posted/
-- cancel/return, stock adjustment, transfer, Coretax export, sync conflict
-- resolution, AI tool call, security readiness decision), per
-- `docs/awcms-mini/03_srs_detail_per_modul.md` and skill `awcms-mini-audit-log`.
--
-- Structured JSON logging (`src/lib/logging/logger.ts`) and correlation ID
-- propagation (`src/middleware.ts`) are code-only additions with no schema
-- footprint — audit *melengkapi, bukan menggantikan* domain event/structured
-- log (doc 10).
CREATE TABLE IF NOT EXISTS awcms_mini_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  actor_tenant_user_id uuid,
  module_key text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  severity text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  attributes jsonb,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_audit_events_severity_check
    CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_audit_events_tenant_created_idx
  ON awcms_mini_audit_events (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_audit_events_tenant_resource_idx
  ON awcms_mini_audit_events (tenant_id, resource_type, resource_id);

ALTER TABLE awcms_mini_audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_audit_events_tenant_isolation
  ON awcms_mini_audit_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Guards `GET /api/v1/logs/audit`. `profile_identity.profile_management.delete`
-- and `.restore` were already seeded in migration 005 ahead of any endpoint
-- ever being built against them — only `.purge` is new here, needed by the
-- new `POST /api/v1/profiles/{id}/purge` lifecycle endpoint.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('logging', 'audit_trail', 'read', 'Read audit trail events'),
  ('profile_identity', 'profile_management', 'purge', 'Permanently purge a soft-deleted profile record')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
