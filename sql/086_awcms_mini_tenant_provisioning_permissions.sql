-- Issue #872 (epic #868 SaaS control plane, Wave 1, ADR-0022) — permission
-- catalog seed for the `tenant_provisioning` module. Same additive shape as
-- `sql/082_awcms_mini_tenant_entitlement_permissions.sql`: new rows under a NEW
-- `module_key`, reusing EXISTING `AccessAction` literals only (`read`/`create`/
-- `retry`/`cancel`/`check` are all already declared in
-- `identity-access/domain/access-control.ts`).
--
-- Provisioning commands are PLATFORM-OPERATOR only and default-deny
-- (ADR-0022 §5) — these permissions are seeded but granted to NO role by this
-- migration; a platform-operator role is provisioned narrowly by the
-- deployment. The module is `defaultTenantState: "disabled"` besides
-- (ADR-0022 §7), so a tenant that never explicitly enables the control plane
-- has no reachable provisioning surface at all — doubly inert.
--
-- IMPORTANT (ADR-0022 §4/§6): these permissions gate WHO may run provisioning
-- COMMANDS. A platform operator manages a target tenant ONLY inside that
-- tenant's per-tenant context (`SET LOCAL app.current_tenant_id`), each command
-- audited — the operator role is NOT `BYPASSRLS` and the RLS predicate is
-- always and only `tenant_id` (no soft super-tenant).
--
-- `create` (request a run, which creates a tenant), `retry` (start/resume/retry
-- the orchestration), `cancel` (cancel-when-safe), and `check` (reconcile) are
-- the high-risk mutations — all require `Idempotency-Key` (hash binds tenant /
-- request identity + immutable inputs, memory
-- `idempotency-hash-missing-resource-id-recurring`) + audit at the application
-- layer, regardless of the `HIGH_RISK_ACTIONS` metadata classification.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('tenant_provisioning', 'requests', 'read', 'Read tenant provisioning runs, steps, attempts, results, and timeline'),
  ('tenant_provisioning', 'requests', 'create', 'Request an idempotent tenant provisioning run (bootstraps the target tenant record)'),
  ('tenant_provisioning', 'requests', 'retry', 'Start, resume, or retry a tenant provisioning run from its durable checkpoint'),
  ('tenant_provisioning', 'requests', 'cancel', 'Cancel a tenant provisioning run when safe (records classified compensation; never deletes tenant data)'),
  ('tenant_provisioning', 'reconciliation', 'check', 'Run a non-destructive desired-vs-actual reconciliation of a provisioned tenant')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
