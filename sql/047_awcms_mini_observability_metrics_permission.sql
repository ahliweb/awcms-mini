-- Issue #698 (epic #679, platform-hardening, "operational proof" wave) —
-- permission catalog seed for the new authorized dependency-health endpoint
-- (`GET /api/v1/logs/observability/dependency-health`,
-- src/pages/api/v1/logs/observability/dependency-health.ts). Same shape as
-- migration 011's `('logging', 'audit_trail', 'read', ...)` seed — extends
-- the global ABAC permission catalog only; existing tenants' roles do not
-- retroactively gain this permission (same documented limitation as every
-- prior permission-seed migration in this repo, e.g.
-- sql/042_awcms_mini_news_media_permissions.sql — only tenants created
-- AFTER this migration runs get it automatically via
-- `POST /api/v1/setup/initialize`'s
-- `INSERT INTO awcms_mini_role_permissions ... SELECT ... FROM
-- awcms_mini_permissions`).
--
-- This is a NEW activity code (`observability`), distinct from the existing
-- `logging.audit_trail.read` (audit event log reads) — the dependency
-- health endpoint reads circuit-breaker/work-class-pool aggregate state,
-- not audit events, so it is guarded by its own permission rather than
-- reusing audit_trail's.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('logging', 'observability', 'read', 'Read operational dependency health (database circuit/pool state, optional external provider circuit state by family)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
