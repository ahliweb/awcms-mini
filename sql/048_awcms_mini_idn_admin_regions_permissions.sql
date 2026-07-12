-- Issue #655 (epic #654, master data wilayah administratif Indonesia dari
-- cahyadsn/wilayah) — permission catalog seed for the new
-- `idn_admin_regions` module descriptor
-- (src/modules/idn-admin-regions/module.ts). Same shape as
-- `sql/038_awcms_mini_visitor_analytics_permissions.sql` /
-- `sql/032_awcms_mini_tenant_domain_permissions.sql` — extends the global
-- ABAC permission catalog only, no roles/access-assignments wired here,
-- no new tables (the dataset/region schema lands in a later issue, #657).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('idn_admin_regions', 'region', 'read', 'Read Indonesia administrative region records'),
  ('idn_admin_regions', 'dataset', 'read', 'Read Indonesia administrative region dataset metadata'),
  ('idn_admin_regions', 'dataset', 'import', 'Import a new Indonesia administrative region dataset'),
  ('idn_admin_regions', 'dataset', 'activate', 'Activate a validated Indonesia administrative region dataset'),
  ('idn_admin_regions', 'dataset', 'rollback', 'Roll back the active Indonesia administrative region dataset to the previously active one')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
