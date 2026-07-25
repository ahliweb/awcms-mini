-- Issue #880 (epic #868 SaaS control plane, Wave 3 operations) — make the
-- seven control-plane modules' own append-only tables usable as `reporting`
-- projection SOURCES by the unattended refresh worker.
--
-- ## Why
--
-- Until now the control plane's operational state existed only in its
-- transactional tables: an operator could read one tenant's provisioning run,
-- one tenant's invoice history, one tenant's webhook processing attempts — one
-- REST call at a time — but had no freshness/backlog/failure signal at all
-- (issue #880: "a control plane is not production-ready when state exists only
-- in transactional tables and provider dashboards"). Each module now declares
-- its own `ProjectionDescriptor` (`ModuleDescriptor.reportingProjections`,
-- `src/modules/_shared/module-contract.ts`) over ONE append-only table it owns,
-- so `reporting`'s existing incremental/rebuild/reconciliation engine (issue
-- #753) materializes it — no new engine, no new projection table, and no
-- cross-module shared-table WRITE (the engine only ever READS the source and
-- writes `reporting`'s own `awcms_mini_reporting_projection_*` tables).
--
-- Two things that engine needs are missing today, and this migration is
-- exactly those two things — no new table, column, policy, or trigger.
--
-- ## 1. `awcms_mini_worker` SELECT on each declared source table
--
-- `bun run reporting:projections:refresh` (`scripts/reporting-projections-
-- refresh.ts`) runs as the least-privilege `awcms_mini_worker` role
-- (migration 045), which is granted DML on EXACTLY the tables each unattended
-- script touches — the blanket `ALTER DEFAULT PRIVILEGES` of migrations
-- 013/045 covers `awcms_mini_app` only, never this role. Migration 069 already
-- established the precedent for `reporting`'s own three projections
-- (`GRANT SELECT ON awcms_mini_abac_decision_logs / _identities / _sync_nodes
-- TO awcms_mini_worker`); these are the same grant for the newly declared
-- control-plane sources. SELECT only — the worker never writes a source table,
-- and RLS (`FORCE`d, `tenant_id`-only predicate on every one of these) remains
-- the real boundary exactly as it is for the app role (ADR-0003, ADR-0022 §6:
-- no soft super-tenant, the worker reads one tenant at a time under
-- `withTenant`).
--
-- `awcms_mini_tenant_modules` is granted for the SAME refresh worker: a
-- control-plane module is `defaultTenantState: "disabled"` (ADR-0022 §7), and a
-- disabled module must be INERT for that tenant — including its background
-- work. `runIncrementalUpdateForTenant` therefore resolves the owning module's
-- tenant state (`resolveModuleEnabled`) and skips without advancing any cursor
-- (see that function's own comment: skipping never loses rows, because a
-- cursor that does not advance is re-scanned once the module is enabled).
--
-- ## 2. A `(tenant_id, created_at)` index per declared source table
--
-- The cursor engine's bounded pass is
--   WHERE tenant_id = $1 AND <cursorColumn> >= $2 ORDER BY <cursorColumn> LIMIT n
-- and every descriptor added by this issue uses `created_at` (the insert-time,
-- never-updated column on these append-only tables) as its cursor. The
-- existing indexes on these tables lead with `tenant_id` but continue with a
-- different second column (`step_id`, `invoice_id`, `intent_id`, `resolved_at`,
-- `started_at`), so none of them can serve that ordered range read from the
-- index. `awcms_mini_tenant_lifecycle_history` already has exactly the right
-- index (`..._tenant_created_idx`, `(tenant_id, created_at DESC)` — a DESC
-- index serves the ascending scan by a backward index scan) and is
-- deliberately NOT duplicated here.
--
-- DESC is used for consistency with that existing index and with every other
-- `(tenant_id, <time>)` index in this schema; direction is irrelevant to the
-- planner for a single-column-order scan, which reads either index backward as
-- cheaply as forward.

-- 1. Refresh-worker read access to each declared projection source.
GRANT SELECT ON awcms_mini_tenant_provisioning_step_attempts TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_tenant_entitlement_evaluation_snapshots TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_tenant_lifecycle_history TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_usage_reconciliation_runs TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_subscription_billing_invoice_status_history TO awcms_mini_worker;
-- `awcms_mini_payment_gateway_processing_attempts` is already granted to this
-- role by migration 093 (the outbox dispatcher writes it) — not repeated here.

-- The tenant module-state lookup the worker's per-tenant inert-when-disabled
-- skip reads. SELECT only; the worker never toggles a module.
GRANT SELECT ON awcms_mini_tenant_modules TO awcms_mini_worker;

-- 2. Cursor-scan indexes: (tenant_id, created_at) on each declared source.
CREATE INDEX IF NOT EXISTS
  awcms_mini_tenant_provisioning_step_attempts_tenant_created_idx
  ON awcms_mini_tenant_provisioning_step_attempts (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS
  awcms_mini_tenant_entitlement_eval_snapshots_tenant_created_idx
  ON awcms_mini_tenant_entitlement_evaluation_snapshots (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS
  awcms_mini_usage_reconciliation_runs_tenant_created_idx
  ON awcms_mini_usage_reconciliation_runs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS
  awcms_mini_subscription_billing_invoice_status_tenant_created_idx
  ON awcms_mini_subscription_billing_invoice_status_history (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS
  awcms_mini_payment_gateway_processing_attempts_tenant_created_idx
  ON awcms_mini_payment_gateway_processing_attempts (tenant_id, created_at DESC);
