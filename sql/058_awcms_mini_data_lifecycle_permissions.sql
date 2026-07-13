-- Issue #745 (epic #738 platform-evolution, Wave 1) — permission catalog
-- seed for `data_lifecycle`, verbatim match to
-- `src/modules/data-lifecycle/domain/data-lifecycle-permissions.ts`'s
-- `DATA_LIFECYCLE_PERMISSIONS` (single source of truth reused by
-- `module.ts`'s `permissions` array and every route handler's
-- `authorizeInTransaction` guard). `legal_hold.create` and
-- `legal_hold.release` are deliberately separate permissions — see that
-- file's own header comment for why ("default-deny release").
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('data_lifecycle', 'registry', 'read', 'Read the high-volume table lifecycle registry (code-declared metadata only, never row contents)'),
  ('data_lifecycle', 'legal_hold', 'read', 'Read legal hold records'),
  ('data_lifecycle', 'legal_hold', 'create', 'Create a legal hold'),
  ('data_lifecycle', 'legal_hold', 'release', 'Release (end) an active legal hold'),
  ('data_lifecycle', 'plan', 'analyze', 'Trigger an on-demand, read-only dry-run lifecycle plan'),
  ('data_lifecycle', 'runs', 'read', 'Read lifecycle run history (aggregated counts only)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
