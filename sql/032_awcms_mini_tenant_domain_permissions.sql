-- Issue #557 (epic #555) — permission catalog seed for the new
-- `awcms_mini_tenant_domains` table (migration 031). Exactly the six
-- permissions from the issue's own §Seed permissions list. `module_key`
-- 'tenant_domain' and `activity_code` 'domains' are new — not used by any
-- other module's permission seed in this repo (checked against every
-- existing `INSERT INTO awcms_mini_permissions` migration). No
-- endpoints/roles are wired to these yet (that is Issue #562's admin API
-- and whatever role/access-assignment work follows it); this migration
-- only extends the global ABAC permission catalog, same shape as
-- `sql/027_awcms_mini_blog_content_permissions.sql`.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('tenant_domain', 'domains', 'read', 'Read tenant domain/subdomain mappings'),
  ('tenant_domain', 'domains', 'create', 'Add a tenant domain/subdomain mapping'),
  ('tenant_domain', 'domains', 'update', 'Update a tenant domain/subdomain mapping'),
  ('tenant_domain', 'domains', 'delete', 'Soft delete a tenant domain/subdomain mapping'),
  ('tenant_domain', 'domains', 'verify', 'Verify ownership of a tenant domain/subdomain'),
  ('tenant_domain', 'domains', 'set_primary', 'Set a tenant domain as the active primary domain')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
