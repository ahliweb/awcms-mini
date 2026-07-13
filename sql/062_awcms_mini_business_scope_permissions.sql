-- Issue #746 (epic #738 platform-evolution, Wave 2) — permission catalog
-- seed for the business-scope assignment/SoD exception endpoints. Same
-- shape as `sql/037_awcms_mini_tenant_oidc_sso_permissions.sql`: extends
-- the global ABAC permission catalog under the existing `identity_access`
-- module_key, no roles/access-assignments wired here (tenant admins grant
-- these via the existing role management UI).
--
-- `business_scope.exceptions.create`/`.approve` are deliberately separate
-- permissions (never one `.manage`) — this pair is also this issue's own
-- global-within-tenant SoD rule fixture
-- (`identity-access/module.ts`'s `sodRules`): a role holding both is
-- exactly the conflict that registry detects.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('identity_access', 'business_scope_assignments', 'read', 'Read business-scope assignments for the caller''s tenant'),
  ('identity_access', 'business_scope_assignments', 'create', 'Create a business-scope assignment'),
  ('identity_access', 'business_scope_assignments', 'revoke', 'Revoke an active business-scope assignment'),
  ('identity_access', 'business_scope_conflicts', 'read', 'Read segregation-of-duties conflict evaluation history'),
  ('identity_access', 'business_scope_exceptions', 'read', 'Read segregation-of-duties conflict exceptions'),
  ('identity_access', 'business_scope_exceptions', 'create', 'Request a segregation-of-duties conflict exception'),
  ('identity_access', 'business_scope_exceptions', 'approve', 'Approve a segregation-of-duties conflict exception'),
  ('identity_access', 'business_scope_exceptions', 'reject', 'Reject a segregation-of-duties conflict exception'),
  ('identity_access', 'business_scope_exceptions', 'revoke', 'Revoke a previously approved segregation-of-duties conflict exception')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
