-- Issue #930 (epic #868) — let the least-privilege worker role READ the
-- control-plane tables the fleet sweep observes.
--
-- ## Why this migration exists
--
-- `bun run control-plane:fleet-sweep` walks every active tenant and reads each
-- control-plane module's operational signals. It runs as `awcms_mini_worker`
-- (`getWorkerDatabaseClient()`), which had SELECT on the payment-gateway and
-- reporting tables already — migration 093 granted the outbox/inbox for the
-- dispatcher, and 101 granted the projection sources for the refresh worker —
-- but NOT on the provisioning, entitlement, or billing tables, which no
-- unattended job had needed until now.
--
-- Without these grants the sweep fails with `permission denied for table` on
-- its first tenant. That is easy to miss locally: a developer `DATABASE_URL`
-- is typically a superuser, and a superuser bypasses both grants and RLS, so
-- the job appears to work perfectly right up until it is deployed. The
-- integration test for the collectors therefore runs as the real
-- `awcms_mini_worker` role rather than as the admin connection, so a missing
-- grant fails the suite instead of production.
--
-- ## Read-only, and why that is enough
--
-- SELECT only. The sweep never reconciles, revokes, retries, or advances
-- anything — a job that both observes and mutates would make "the metric
-- moved" ambiguous between "the fleet changed" and "the sweep changed it".
-- Remediation stays in the per-tenant engines behind their own audited entry
-- points, which run as the app role in a request or as their own jobs.
--
-- ## Tenant isolation is unchanged
--
-- These tables keep FORCE RLS and their canonical tenant_id-only policies.
-- The sweep sees one tenant at a time because it enters each tenant's own RLS
-- context via `withTenant`; nothing here grants BYPASSRLS, adds a policy, or
-- widens a predicate, so `bun run rls:platform-claim:check` stays green and
-- ADR-0022 §6b's "a platform operator is NOT a soft super-tenant" still holds
-- at the database level, not merely by convention in application code.

GRANT SELECT ON awcms_mini_tenant_provisioning_requests TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_tenant_entitlement_assignments TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_subscription_billing_invoices TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_subscription_billing_dunning_attempts TO awcms_mini_worker;

-- Retention/backlog scans the sweep runs every few minutes, per tenant.
-- `provisioning_requests` is UNIQUE on tenant_id (provisioning is 1:1 with a
-- tenant), so its per-tenant read is already a single-row lookup and needs no
-- extra index. The other three are genuinely multi-row per tenant.
CREATE INDEX IF NOT EXISTS awcms_mini_tenant_entitlement_assignments_expiry_idx
  ON awcms_mini_tenant_entitlement_assignments (tenant_id, status, effective_to);

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_invoices_overdue_idx
  ON awcms_mini_subscription_billing_invoices (tenant_id, status, due_at);

CREATE INDEX IF NOT EXISTS awcms_mini_subscription_billing_dunning_latest_idx
  ON awcms_mini_subscription_billing_dunning_attempts
     (tenant_id, invoice_id, attempt_no DESC);
