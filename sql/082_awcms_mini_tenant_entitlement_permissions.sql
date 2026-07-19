-- Issue #871 (epic #868 SaaS control plane, Wave 1, ADR-0022) — permission
-- catalog seed for the `tenant_entitlement` module. Same additive shape as
-- `sql/080_awcms_mini_service_catalog_permissions.sql`: new rows under a NEW
-- `module_key`, reusing EXISTING `AccessAction` literals only (`read`/`assign`/
-- `update`/`revoke`/`override` are all already declared in
-- `identity-access/domain/access-control.ts`).
--
-- Entitlement management is PLATFORM-OPERATOR only and default-deny
-- (ADR-0022 §5) — these permissions are seeded but granted to NO role by this
-- migration; an operator role is provisioned narrowly by the deployment, never
-- implicitly. A regular tenant user never holds any `tenant_entitlement.*`
-- permission, and the module is `defaultTenantState: "disabled"` besides
-- (ADR-0022 §7), so the whole surface is doubly inert for an ordinary tenant.
--
-- IMPORTANT (ADR-0022 §4): these permissions gate who may READ/CHANGE
-- entitlement RECORDS. They do NOT grant any business authorization — a
-- positive commercial entitlement can never bypass RBAC/ABAC/RLS, which remain
-- the sole authorization authority. `entitlement`/`assignments`/`overrides` are
-- the entitlement management surface, on a DIFFERENT axis from the permission
-- system itself.
--
-- `assignments.assign`, `assignments.revoke`, `overrides.override`, and
-- `overrides.revoke` are the high-risk mutations that grant/withhold commercial
-- access — all require `Idempotency-Key` (hash includes the resource id, memory
-- `idempotency-hash-missing-resource-id-recurring`) + audit at the application
-- layer. `assign`/`revoke`/`override` are already in `HIGH_RISK_ACTIONS`;
-- `update` (suspend/resume) is not globally high-risk but the route still
-- enforces idempotency + audit unconditionally.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('tenant_entitlement', 'entitlement', 'read', 'Read a tenant''s resolved effective entitlement (features/modules/quotas) with source explanation'),
  ('tenant_entitlement', 'assignments', 'read', 'List a tenant''s entitlement assignments (subscriptions to published offers)'),
  ('tenant_entitlement', 'assignments', 'assign', 'Assign (subscribe) a tenant to a published service catalog offer version'),
  ('tenant_entitlement', 'assignments', 'update', 'Suspend or resume a tenant entitlement assignment (lifecycle restriction; data preserved)'),
  ('tenant_entitlement', 'assignments', 'revoke', 'Cancel a tenant entitlement assignment (entitlement loss; tenant data is never deleted)'),
  ('tenant_entitlement', 'overrides', 'read', 'List a tenant''s entitlement overrides (operator grants/denies)'),
  ('tenant_entitlement', 'overrides', 'override', 'Create a platform-operator entitlement override (grant/deny a feature, module, or quota; reason required, optionally time-bound)'),
  ('tenant_entitlement', 'overrides', 'revoke', 'Revoke a tenant entitlement override (stops applying immediately, without restart)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
