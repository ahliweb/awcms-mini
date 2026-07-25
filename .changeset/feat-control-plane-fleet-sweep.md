---
"awcms-mini": minor
---

Control plane: add the fleet-wide observation sweep that feeds the SLO
metrics (Issue #930, second wave).

`tenant-provisioning:reconcile` had documented this gap explicitly — a
fleet-wide batch "would need a purpose-built cross-tenant read-model (ADR-0022
§6b — a platform operator is NOT a soft super-tenant and never scans all
tenants' RLS tables ad hoc)". `bun run control-plane:fleet-sweep` is that read
model, and its shape is the whole point: enumerate tenants from the global
tenant directory, read each tenant's own rows inside that tenant's own RLS
context, then aggregate in application memory. No query ever sees two tenants'
rows at once, and nothing needs `BYPASSRLS` or a platform claim in a policy
predicate.

Each control-plane module contributes its own per-tenant collector
(`<module>/application/control-plane-signals.ts`) reading only its own tables;
the composition-root script is the only place that imports several at once, and
the aggregation itself takes plain data and imports no module, so it stays
unit-testable without a database. The sweep is read-only — it never reconciles,
revokes, retries, or advances anything, because a job that both observes and
mutates makes "the metric moved" ambiguous between "the fleet changed" and "the
sweep changed it".

Two behaviours are deliberate and easy to get wrong. Every gauge is emitted
**even at zero**: a gauge that simply stops being reported is indistinguishable
from a dead collector in any time-series backend, and "no data" usually renders
as a gap rather than an alarm, so writing 0 explicitly is what lets an operator
tell "nothing is wrong" from "nothing is watching". And a sweep cancelled
part-way **publishes nothing**: fleet totals built from a subset of tenants read
as a fleet-wide drop — exactly the shape of a recovery — which would silently
clear alerts that should still be firing.

Migration `103` grants the least-privilege `awcms_mini_worker` role SELECT on
the provisioning, entitlement, and billing tables it now reads (payment-gateway
and reporting were already granted by `093`/`101`), plus three retention-scan
indexes. This was found the hard way: the first smoke run passed against a
superuser `DATABASE_URL`, and a superuser bypasses both grants and RLS — so the
job looked perfect while being unable to read four tables in any real
deployment, and while silently reading every tenant at once. The collector
integration tests therefore run as the real `awcms_mini_worker` role, which was
verified to fail when a grant is revoked.

The billing collector uses a `LATERAL` join to the latest dunning attempt
rather than a plain join: the obvious phrasing multiplies one invoice by its
retry count, so the overdue metric would climb as dunning worked *harder*.
