-- Admin Settings management (PR: Settings). Seeds the two permissions the
-- new session-authenticated settings endpoints guard on: `GET /api/v1/settings`
-- (read) and `PATCH /api/v1/settings` (update). No schema change — the
-- editable fields already exist:
--   * awcms_mini_tenants.tenant_name / legal_name / default_locale / default_theme
--     (migration 002 — the tenant's own identity/preference columns; this
--     table is intentionally RLS-free, see scripts/security-readiness.ts
--     RLS_FREE_TABLES, so the endpoint must scope updates by `WHERE id = <tenantId>`
--     itself rather than relying on a tenant-isolation policy).
--   * awcms_mini_tenant_settings.timezone / feature_flags (migration 002 — RLS
--     tenant-scoped).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('tenant_admin', 'tenant_settings', 'read', 'Read tenant profile and settings'),
  ('tenant_admin', 'tenant_settings', 'update', 'Update tenant profile and settings')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
