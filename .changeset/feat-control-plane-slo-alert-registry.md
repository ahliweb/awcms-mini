---
"awcms-mini": minor
---

Control plane: add the module-contributed SLO/alert registry, control-plane
metrics, and the operator objective catalog (Issue #930, first wave).

The SaaS control plane is the one subsystem whose stall is invisible to
everybody: the tenants still waiting on a provisioning queue cannot see it, the
tenants already provisioned are unaffected, and no tenant-scoped report covers
it because the tenant does not exist yet. Nothing was watching it, so this adds
something that does.

**Registry.** `ModuleDescriptor.serviceLevelObjectives` (module contract bumped
to `2.1.0`, purely additive) lets a module declare its own objectives and alert
thresholds in its own `module.ts`, aggregated and validated centrally by
`logging/domain/slo-registry.ts` — the same "module declares, central engine
reads `listModules()`" shape `dataLifecycle` and `reportingProjections` already
use. Eight objectives ship across `tenant_provisioning`, `tenant_entitlement`,
`subscription_billing`, `payment_gateway`, and `reporting`.

**The gate** (`bun run slo:registry:check`, wired into `bun run check`) enforces
two rules that carry real weight. `metricName` must be declared in
`METRIC_DEFINITIONS` — an objective measured against a metric nothing emits is
permanently silent, which looks like coverage on a dashboard and pages nobody.
And `dimension` must be one of that metric's own `allowedLabelKeys`, which makes
the "alerts use low-cardinality dimensions" requirement true by construction
rather than by review: an objective cannot introduce a label, so it cannot
smuggle a tenant id or resource id into an alert. The gate additionally verifies
each `runbookPath` exists on disk, because a dead runbook link found at 3am
costs the responder the time they spent trusting it.

It also rejects incoherent thresholds: a critical tier less severe than its
warning tier, a threshold pointing the opposite way from its objective (which
describes the healthy state and would fire permanently), a `below` threshold on
a counter (which can never recover, so the alert latches forever), a ratio
objective written as a percentage, and an unactionable `operatorAction`.

**Metrics.** Eight `control_plane_*` definitions (provisioning backlog and
oldest-pending age, unswept expired entitlements, overdue invoices by dunning
stage, payment DLQ depth, webhook backlog, stale projections, manual-intervention
queue). Every one is unlabeled or labelled only by a fixed code-defined enum —
never per-tenant, per-resource, or per-provider-reference.

**Operator surface.** `GET /api/v1/logs/observability/slo`
(`logging.observability.read`) serves the objective catalog. Its response is
built from an explicit field allow-list in `logging/domain/slo-safe-view.ts`,
never by spreading a descriptor: numeric thresholds, dwell times, and metric
names are withheld, since they are exactly the calibration data needed to stay
just under an alarm. A test asserts a descriptor carrying an unknown extra field
does not leak it, so a future field cannot become public by default.

Live objective state — which objectives are currently in breach — is not served
yet; the fleet-wide collectors that compute those signals land with the
scheduled control-plane jobs in the next wave. `docs/awcms-mini/control-plane-slo-runbook.md`
carries the per-objective response guidance.
