-- Issue #753 (epic #738 platform-evolution, Wave 3) — permission catalog
-- seed for the reporting projection/export surface, verbatim match to
-- `src/modules/reporting/domain/projection-permissions.ts`'s
-- `REPORTING_PROJECTION_PERMISSIONS` (single source of truth reused by
-- `module.ts`'s `permissions` array and every route handler's
-- `authorizeInTransaction` guard). Additive to the pre-existing
-- `reporting.dashboard.read` permission (migration 010) — that permission
-- keeps gating the five live `/api/v1/reports/*` aggregation views
-- unchanged; these six gate ONLY the new projection/rebuild/export
-- surface.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('reporting', 'projections', 'read', 'Read a projection''s registry metadata, current snapshot value, and freshness status'),
  ('reporting', 'projections', 'rebuild', 'Trigger or resume a full projection rebuild'),
  ('reporting', 'projections', 'analyze', 'Trigger an on-demand reconciliation of a projection against its source control total'),
  ('reporting', 'exports', 'read', 'Read scheduled export configs, export run history, and download a completed export'),
  ('reporting', 'exports', 'configure', 'Create or disable a scheduled export config'),
  ('reporting', 'exports', 'export', 'Manually trigger an export run for a projection')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
