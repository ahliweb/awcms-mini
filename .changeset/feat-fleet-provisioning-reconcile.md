---
"awcms-mini": minor
---

feat(tenant-provisioning): add the fleet-wide reconciliation pass (#930)

`tenant_provisioning`'s own job descriptor documented this gap in its own
words: a fleet-wide batch "is intentionally DEFERRED to #880 (it needs a
purpose-built cross-tenant read-model — a platform operator is not a soft
super-tenant, ADR-0022 §6b); until then reconcile on-demand, one tenant at a
time". So reconciliation existed, but nothing ran it unless a human remembered
to — per tenant, by id. Wave 2 of #930 built the cross-tenant read model that
deferral was waiting on, and `bun run tenant-provisioning:fleet-reconcile`
reuses its exact shape: enumerate tenants from the global directory, then read
and write each tenant's rows inside THAT tenant's own RLS context. No query
ever sees two tenants at once and nothing needs `BYPASSRLS`.

It reports drift and never auto-fixes (ADR-0022 §9) — remediation stays a
deliberate, audited operator action, because a scheduled job that silently
repaired provisioning drift would erase the evidence anything was ever wrong.
It is not, however, read-only: each pass records itself (status transition,
reconciliation row, `last_reconciled_at`), without which an operator cannot
tell "reconciled, no drift" from "never reconciled".

**A design bug the tests caught before merge.** The first version selected
tenants by walking the enumeration and stopping at a per-run budget. That
starves the tail permanently: tenants enumerate in a stable order, and with a
20h freshness interval on a daily schedule every tenant the previous pass
touched is due again by the next tick — so the same head wins the budget
forever and everything after it is never reconciled. Not "reconciled late";
never. The pass now probes every tenant first, then spends its budget on the
STALEST due tenants (never-reconciled first), so the bound can only delay a
tenant, never strand one. The unit test reproduces the failure against the
rejected shape rather than merely asserting the fix.

Migration 105 grants the worker exactly what the pass needs and stops there:
`UPDATE` on requests (also what `SELECT ... FOR UPDATE` requires), `SELECT` +
`INSERT` on reconciliations, `SELECT` on steps/results. Deliberately absent:
INSERT/DELETE on requests — a scheduled job must not be able to enrol tenants
nobody asked for, nor destroy the provenance of what was provisioned — and any
write at all on steps/results, since a reconciler that can edit its own inputs
can only hide drift, not detect it. Reconciliation records are append-only to
it for the same reason.

The integration tests write as the real `awcms_mini_worker` role, and revoking
any one of the three grants turns the suite red — the grants are proven
load-bearing rather than assumed.
