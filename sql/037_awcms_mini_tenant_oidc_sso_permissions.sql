-- Issue #591 (epic: full-online auth hardening #587-#593) — permission
-- catalog seed for the admin CRUD endpoints over the new
-- `awcms_mini_auth_providers`/`awcms_mini_tenant_auth_policies` tables
-- (migration 036). Same shape as `sql/032_awcms_mini_tenant_domain_permissions.sql` —
-- extends the global ABAC permission catalog only under the existing
-- `identity_access` module_key (already used by migration 005's
-- `user_management`/`access_control` activity codes), no
-- roles/access-assignments wired here (tenant admins grant these via the
-- existing role management UI, out of scope for this migration).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('identity_access', 'sso_providers', 'read', 'Read tenant OIDC SSO provider configuration'),
  ('identity_access', 'sso_providers', 'create', 'Add a tenant OIDC SSO provider'),
  ('identity_access', 'sso_providers', 'update', 'Update a tenant OIDC SSO provider'),
  ('identity_access', 'sso_providers', 'delete', 'Soft delete a tenant OIDC SSO provider'),
  ('identity_access', 'sso_policy', 'read', 'Read tenant authentication policy (password/SSO/break-glass)'),
  ('identity_access', 'sso_policy', 'update', 'Update tenant authentication policy (password/SSO/break-glass)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
