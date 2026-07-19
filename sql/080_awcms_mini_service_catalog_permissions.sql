-- Issue #870 (epic #868 SaaS control plane, Wave 1, ADR-0022) — permission
-- catalog seed for the `service_catalog` module. Same additive shape as
-- `sql/076_awcms_mini_reference_data_permissions.sql`: new rows under a NEW
-- `module_key`, reusing EXISTING `AccessAction` literals only (`read`/
-- `create`/`update`/`publish`/`retire` are all already declared in
-- `identity-access/domain/access-control.ts`).
--
-- Catalog mutation is PLATFORM-OPERATOR only and default-deny (ADR-0022 §5) —
-- these permissions are seeded but granted to NO role by this migration; an
-- operator role is provisioned narrowly by the deployment/operator, never
-- implicitly. A regular tenant user never holds any `service_catalog.*`
-- permission, and the module is `defaultTenantState: "disabled"` besides
-- (ADR-0022 §7), so the whole surface is doubly inert for an ordinary tenant.
--
-- `offers.publish`/`offers.retire` are the two lifecycle mutations that
-- create/close an IMMUTABLE offer version — both require `Idempotency-Key`
-- (hash includes the resource id, memory `idempotency-hash-missing-resource-
-- id-recurring`) + audit at the application layer regardless of the
-- `HIGH_RISK_ACTIONS` classification (`retire` is classified high-risk;
-- `publish` is not globally high-risk but this module's route enforces
-- idempotency + audit unconditionally — the established "isHighRiskAction is
-- metadata, not the sole gate" pattern).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('service_catalog', 'plans', 'read', 'Read/list service catalog plans, versions, and published offers'),
  ('service_catalog', 'plans', 'create', 'Create a draft service catalog plan and its first draft version'),
  ('service_catalog', 'plans', 'update', 'Edit a draft plan/version (features, quotas, prices, availability) or draft a new version'),
  ('service_catalog', 'offers', 'publish', 'Validate and publish a draft version into an immutable offer'),
  ('service_catalog', 'offers', 'retire', 'Retire a published offer version')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
