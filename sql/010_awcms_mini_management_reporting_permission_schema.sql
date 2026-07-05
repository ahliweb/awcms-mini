-- Issue 9.1 — Add Management Reporting Views.
--
-- No new tables: the four reporting views (tenant activity summary,
-- access/audit summary, sync health, module usage) are live read-aggregations
-- over tables already created by migrations 002-009. This migration only
-- seeds one shared permission into the global `awcms_mini_permissions`
-- catalog (migration 005) that guards all four `GET /reports/*` endpoints —
-- one dashboard feature, not four fragmented permissions.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('reporting', 'dashboard', 'read', 'Read management reporting dashboard views')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
