-- Issue #873 (epic #868 SaaS control plane, Wave 1, ADR-0022) — permission
-- catalog seed for the `tenant_lifecycle` module. Same additive shape as
-- `sql/086_awcms_mini_tenant_provisioning_permissions.sql`: new rows under a NEW
-- `module_key`, reusing EXISTING `AccessAction` literals only (`read`/`update`/
-- `schedule`/`restore`/`configure`/`export` are all already declared in
-- `identity-access/domain/access-control.ts`).
--
-- Lifecycle transitions are PLATFORM-OPERATOR actions and default-deny
-- (ADR-0022 §5) — these permissions are seeded but granted to NO role by this
-- migration; a platform-operator role is provisioned narrowly by the
-- deployment. The module is `defaultTenantState: "disabled"` besides
-- (ADR-0022 §7), so a tenant that never explicitly enables the control plane
-- has no reachable lifecycle surface at all — doubly inert.
--
-- IMPORTANT (ADR-0022 §4/§6): these permissions gate WHO may transition a
-- tenant's lifecycle. A platform operator manages a target tenant ONLY inside
-- that tenant's per-tenant context (`SET LOCAL app.current_tenant_id`), each
-- command audited — the operator role is NOT `BYPASSRLS` and the RLS predicate
-- is always and only `tenant_id` (no soft super-tenant).
--
-- `states.update` (transition), `states.schedule` (schedule a future
-- transition), `states.restore` (restore/reactivate — SEPARATELY authorized,
-- a tenant admin cannot self-reactivate), `entitlement.configure` (downgrade
-- the effective entitlement without deleting data), and `recovery.export`
-- (owner recovery/data export — SEPARATELY authorized) are the high-risk
-- mutations — all require `Idempotency-Key` + audit at the application layer,
-- regardless of the `HIGH_RISK_ACTIONS` metadata classification.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('tenant_lifecycle', 'states', 'read', 'Read tenant lifecycle state, restrictions, scheduled transition, and timeline'),
  ('tenant_lifecycle', 'states', 'update', 'Perform a validated tenant lifecycle transition (activate, suspend, past_due, grace, cancel, block; concurrency-safe)'),
  ('tenant_lifecycle', 'states', 'schedule', 'Schedule or cancel a future tenant lifecycle transition (trial/grace expiry) applied idempotently by the scheduler'),
  ('tenant_lifecycle', 'states', 'restore', 'Restore/reactivate a suspended or canceled tenant with reconciliation (separately authorized; not self-service)'),
  ('tenant_lifecycle', 'entitlement', 'configure', 'Downgrade the tenant effective entitlement via the entitlement contract (never deletes tenant data)'),
  ('tenant_lifecycle', 'recovery', 'export', 'Authorize owner recovery / tenant data export while restricted (separately authorized)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
