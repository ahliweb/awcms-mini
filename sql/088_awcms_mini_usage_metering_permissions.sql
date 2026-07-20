-- Issue #875 (epic #868 SaaS control plane, Wave 1, ADR-0022) — permission
-- catalog seed for the `usage_metering` module. Same additive shape as
-- `sql/082_awcms_mini_tenant_entitlement_permissions.sql`: new rows under a NEW
-- `module_key`. `read` and `rebuild` are already declared AccessAction literals;
-- `correct` and `reconcile` are added to `AccessAction` + `HIGH_RISK_ACTIONS` in
-- `identity-access/domain/access-control.ts` by this issue (the same "seed the
-- permission, add the action when a real endpoint needs it" precedent as
-- `verify`/`set_primary`/`release`).
--
-- Usage administration is PLATFORM/BILLING-OPERATOR only and default-deny
-- (ADR-0022 §5) — these permissions are seeded but granted to NO role by this
-- migration; an operator role is provisioned narrowly by the deployment. A
-- regular tenant user never holds any `usage_metering.*` permission, and the
-- module is `defaultTenantState: "disabled"` besides (ADR-0022 §7), so the whole
-- surface is doubly inert for an ordinary tenant.
--
-- IMPORTANT (ADR-0022 §4): these permissions gate who may READ/CORRECT/RECONCILE
-- usage RECORDS and REQUEST an aggregate rebuild. They do NOT grant any business
-- authorization, and a quota decision never bypasses RBAC/ABAC/RLS (a distinct
-- axis). Usage EVENTS are NOT ingested through an authenticated HTTP endpoint —
-- owning modules emit them in their own commit through the transaction-safe
-- append port, so there is no `ingest` permission.
--
-- `corrections.correct` and `reconciliation.reconcile` are the high-risk
-- mutations that change billable amounts / declare the source of truth — both
-- require `Idempotency-Key` (hash includes the resource id, memory
-- `idempotency-hash-missing-resource-id-recurring`) + audit at the application
-- layer. `aggregation.rebuild` requests a full deterministic recompute (audited,
-- idempotent) and is already in `HIGH_RISK_ACTIONS`.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('usage_metering', 'usage', 'read', 'Read a tenant''s usage timeline, meter windows, and aggregate freshness'),
  ('usage_metering', 'quota', 'read', 'Read a tenant''s effective usage quota decisions (limit vs current usage, fail-closed when stale)'),
  ('usage_metering', 'corrections', 'read', 'List a tenant''s usage corrections/reversals'),
  ('usage_metering', 'corrections', 'correct', 'Apply a signed usage correction/reversal linked to an original event (never mutates the source event)'),
  ('usage_metering', 'reconciliation', 'read', 'List a tenant''s usage reconciliation runs'),
  ('usage_metering', 'reconciliation', 'reconcile', 'Run a usage reconciliation that recomputes windows from immutable events and flags drift'),
  ('usage_metering', 'aggregation', 'rebuild', 'Request a full deterministic rebuild of a tenant''s usage aggregate windows from immutable events')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
