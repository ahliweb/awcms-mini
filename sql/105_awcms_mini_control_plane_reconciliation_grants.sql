-- Issue #930 (epic #868) — let the least-privilege worker role run the
-- fleet-wide provisioning reconciliation pass.
--
-- ## Why this migration exists
--
-- `tenant_provisioning`'s job descriptor documented the gap in its own words:
-- a FLEET-WIDE reconciliation "is intentionally DEFERRED to #880 (it needs a
-- purpose-built cross-tenant read-model — a platform operator is not a soft
-- super-tenant, ADR-0022 6b)". Wave 2 of #930 built exactly that read model
-- for the observation sweep: enumerate tenants from the global directory, then
-- read each tenant's rows inside THAT tenant's own RLS context.
-- `scripts/tenant-provisioning-fleet-reconcile.ts` reuses the same shape, and
-- this migration gives the worker role the privileges that pass needs — no
-- more.
--
-- ## Why reconciliation needs WRITE privileges at all
--
-- Reconciliation is non-destructive in the sense that matters (it never
-- auto-fixes drift, ADR-0022 9), but it is not read-only: a pass records
-- itself. `reconcileProvisioning` transitions the request
-- `provisioned -> reconciling -> provisioned`, inserts a reconciliation record
-- holding the drift it observed, and stamps `last_reconciled_at`. Without that
-- evidence trail an operator cannot tell "reconciled, no drift" from "never
-- reconciled", which is the whole point of running it on a schedule.
--
-- Note also that `SELECT ... FOR UPDATE` (`loadRequestForUpdate`) requires the
-- UPDATE privilege in PostgreSQL, not just SELECT — so even the row-locking
-- read below depends on this grant.

-- The request row itself. Migration 103 granted SELECT for the read-only fleet
-- observation sweep; the reconciliation pass also transitions status and
-- stamps `last_reconciled_at`.
--
-- UPDATE only. Deliberately NOT INSERT: creating a provisioning request is an
-- operator/commercial action with its own audited entry point, and a sweep
-- that could conjure one would let a scheduled job enrol tenants nobody asked
-- for. Deliberately NOT DELETE: the request row is the provenance record for
-- what was provisioned and when.
GRANT UPDATE ON awcms_mini_tenant_provisioning_requests TO awcms_mini_worker;

-- The drift evidence the pass produces, and reads back to decide whether a
-- tenant is due.
--
-- INSERT only alongside SELECT — no UPDATE, no DELETE. A reconciliation record
-- is an observation made at a point in time; revising or erasing one would
-- rewrite the operator-facing history of what the fleet looked like.
GRANT SELECT, INSERT ON awcms_mini_tenant_provisioning_reconciliations TO awcms_mini_worker;

-- The desired-vs-actual comparison inputs. Read-only: the pass compares the
-- plan's steps against what was recorded and reports the difference. It must
-- never be able to edit the actual state it is measuring — a reconciler that
-- can write its own inputs cannot detect drift, it can only hide it.
GRANT SELECT ON awcms_mini_tenant_provisioning_steps TO awcms_mini_worker;
GRANT SELECT ON awcms_mini_tenant_provisioning_results TO awcms_mini_worker;
