-- Issue #876 (epic #868 SaaS control plane, Wave 1, ADR-0022) — permission
-- catalog seed for the `subscription_billing` module. Same additive shape as
-- `sql/090_awcms_mini_tenant_lifecycle_permissions.sql`: new rows under a NEW
-- `module_key`, reusing EXISTING `AccessAction` literals only (`read`/`create`/
-- `update`/`issue`/`void`/`configure` are all already declared in
-- `identity-access/domain/access-control.ts`).
--
-- Billing mutations are PLATFORM-OPERATOR actions and default-deny (ADR-0022
-- §5): these permissions are seeded but granted to NO role by this migration —
-- a platform-operator role is provisioned narrowly by the deployment, SEPARATE
-- from any tenant-admin role (ADR-0022 §8 "platform billing permissions are
-- separate from tenant administration"). The module is
-- `defaultTenantState: "disabled"` besides (ADR-0022 §7), so a tenant that never
-- explicitly enables the control plane has no reachable billing surface at all —
-- doubly inert.
--
-- IMPORTANT (ADR-0022 §4/§6): a platform operator manages a target tenant ONLY
-- inside that tenant's per-tenant context (`SET LOCAL app.current_tenant_id`),
-- each command audited — the operator role is NOT `BYPASSRLS` and the RLS
-- predicate is always and only `tenant_id`. Tenant users may be granted
-- `subscriptions.read` / `invoices.read` to view THEIR OWN authorized
-- commercial records but can never mutate an issued invoice (§8 AC).
--
-- High-risk mutations — `subscriptions.create`/`update`, `invoices.create`
-- (generate draft), `invoices.issue`, `invoices.void`, `credits.create`,
-- `payments.update` (record allocation), `changes.update` (schedule upgrade/
-- downgrade/cancel), and `dunning.update` — all require `Idempotency-Key` +
-- audit at the application layer, regardless of the `HIGH_RISK_ACTIONS`
-- metadata classification.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('subscription_billing', 'subscriptions', 'read', 'Read subscriptions, billing periods, and commercial state'),
  ('subscription_billing', 'subscriptions', 'create', 'Create a subscription bound to an immutable published offer version'),
  ('subscription_billing', 'subscriptions', 'update', 'Perform a validated subscription state transition (activate, past_due, cancel, expire; concurrency-safe)'),
  ('subscription_billing', 'invoices', 'read', 'Read invoices, line items, status history, and download metadata'),
  ('subscription_billing', 'invoices', 'create', 'Generate an idempotent invoice draft from catalog prices and usage aggregates'),
  ('subscription_billing', 'invoices', 'issue', 'Issue a draft invoice (issued invoices become immutable)'),
  ('subscription_billing', 'invoices', 'void', 'Void an invoice with a mandatory reason (correction, never edit/delete)'),
  ('subscription_billing', 'credits', 'create', 'Issue a credit note against an original issued invoice/line (never edits the invoice)'),
  ('subscription_billing', 'payments', 'update', 'Record a validated manual/provider payment allocation reference (no accounting ledger)'),
  ('subscription_billing', 'changes', 'update', 'Schedule/cancel a deterministic subscription upgrade/downgrade/cancel preserving historical terms'),
  ('subscription_billing', 'dunning', 'update', 'Run/schedule dunning attempts that request lifecycle transitions through the #873 contract')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
