-- Issue #877 (epic #868 SaaS control plane, Wave 1, ADR-0022) — permission
-- catalog seed for the `payment_gateway` module. Same additive shape as
-- `sql/092_awcms_mini_subscription_billing_permissions.sql`: new rows under a
-- NEW `module_key`, reusing EXISTING `AccessAction` literals only (`read`/
-- `create`/`update`/`cancel`/`configure`/`retry` are all already declared in
-- `identity-access/domain/access-control.ts`).
--
-- Payment mutations are PLATFORM-OPERATOR actions and default-deny (ADR-0022
-- §5/§8): these permissions are seeded but granted to NO role by this migration
-- — a platform-operator role is provisioned narrowly by the deployment,
-- SEPARATE from any tenant-admin role. The module is
-- `defaultTenantState: "disabled"` besides (ADR-0022 §7), so a tenant that never
-- explicitly enables the control plane has no reachable payment surface at all —
-- doubly inert, fully offline/LAN-safe.
--
-- IMPORTANT (ADR-0022 §4/§6): a platform operator manages a target tenant ONLY
-- inside that tenant's per-tenant context (`SET LOCAL app.current_tenant_id`),
-- each command audited — the operator role is NOT `BYPASSRLS` and the RLS
-- predicate is always and only `tenant_id`. Tenant users may be granted read
-- permissions to view THEIR OWN authorized payment records but can never trust a
-- browser redirect nor force a payment state.
--
-- High-risk mutations — `provider_accounts.configure`, `intents.create`
-- (initiate checkout), `intents.cancel`, `refunds.create` (request refund,
-- mandatory reason + SoD/step-up guidance), `reconciliation.update`, and
-- `outbox.retry` (manual DLQ retry) — all require `Idempotency-Key` + audit at
-- the application layer, regardless of the `HIGH_RISK_ACTIONS` metadata
-- classification. Payment status is NEVER trusted from a browser return URL —
-- only from a signed, freshness/binding/replay-checked webhook or a
-- reconciliation outcome.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('payment_gateway', 'provider_accounts', 'read', 'Read provider account bindings (never the signing secret) and provider health'),
  ('payment_gateway', 'provider_accounts', 'configure', 'Create or update a provider account binding (env: secret pointer only, allow-listed hosts)'),
  ('payment_gateway', 'intents', 'read', 'Read payment intents/sessions and their status history'),
  ('payment_gateway', 'intents', 'create', 'Initiate a hosted checkout/payment session for a payable invoice (dispatched via outbox, outside any DB transaction)'),
  ('payment_gateway', 'intents', 'cancel', 'Cancel/expire a payment session where the provider supports it'),
  ('payment_gateway', 'webhooks', 'read', 'Read the signed webhook inbox, normalized events, and processing attempts'),
  ('payment_gateway', 'refunds', 'read', 'Read refund requests and their write-once results'),
  ('payment_gateway', 'refunds', 'create', 'Request a refund where supported (mandatory reason, idempotency, SoD/step-up)'),
  ('payment_gateway', 'reconciliation', 'read', 'Read reconciliation evidence (local vs provider state)'),
  ('payment_gateway', 'reconciliation', 'update', 'Run/resolve reconciliation, closing local-provider drift with an audited correction'),
  ('payment_gateway', 'outbox', 'retry', 'Manually retry a dead-lettered provider dispatch (DLQ)'),
  ('payment_gateway', 'health', 'read', 'Read provider adapter health/readiness and circuit-breaker state')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
