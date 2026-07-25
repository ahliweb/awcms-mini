---
"awcms-mini": minor
---

SaaS control-plane observability (Issue #880, epic #868 Wave 3): the six
tenant-scoped control-plane modules now contribute their own `reporting`
read-model projections, so operational state is visible without opening each
transactional table one REST call at a time.

Each owning module declares one `ProjectionDescriptor` in its own `module.ts`
over an append-only source it owns, materialized by the existing generic
cursor engine (no new engine, no new projection table):
`tenant_provisioning.provisioning_outcomes` (step-attempt outcomes — is
provisioning progressing, retrying, or waiting on manual intervention?),
`tenant_lifecycle.lifecycle_transitions` (lifecycle churn by event kind and
destination state), `tenant_entitlement.entitlement_evaluations` (did
entitlement propagation run, and why), `usage_metering.usage_reconciliation_outcomes`
(drift/failed reconciliation runs), `subscription_billing.invoice_lifecycle`
(invoice transition counts — issued versus paid backlog, void churn), and
`payment_gateway.payment_processing_outcomes` (webhook pipeline health —
applied versus ignored provider events). Counts only: no money amount,
provider reference, webhook envelope, or PII is ever projected.
`service_catalog` owns no tenant-scoped append-only table and contributes
none — a decision now gated, with its rationale, by
`tests/unit/control-plane-observability-coverage.test.ts`, which fails if any
control-plane module has neither a projection nor a written reason.

Projection accessibility is now decided in ONE place
(`reporting/application/projection-access.ts`): the owning module's per-tenant
enabled state first, then the descriptor's own `requiredPermission`. Every
control-plane module is default-disabled (ADR-0022 §7) while
`fetchGrantedPermissionKeys` keeps a disabled module's permission keys, so
without this a tenant that never opted into the control plane would still see
`subscription_billing`/`payment_gateway` projections listed with live counts.
The gate covers the list, detail, reconcile, rebuild/cancel, export
create/trigger, the admin screen, and both unattended workers — a disabled
module's projection is now omitted from the list, answers 403 on direct
access, produces no scheduled export artifact, and is skipped by the refresh
worker without advancing any cursor (so enabling the module later loses
nothing). A structural test fails if a future call site reaches past that
chokepoint. Export create/trigger additionally now require the descriptor's
own read permission, which the coarse `reporting.exports.*` gate did not
imply once projections stopped being `reporting`-owned.

Also: a projection's reported metrics now always include every DECLARED
metric, defaulting to 0 (previously a discriminator that had never occurred
was absent before a rebuild and present-as-0 after one).

Migration `101_awcms_mini_control_plane_projection_sources.sql` grants the
least-privilege `awcms_mini_worker` role SELECT on the newly declared source
tables plus `awcms_mini_tenant_modules`, and adds the `(tenant_id, created_at)`
index each cursor scan needs. No table, column, policy, or trigger changes.
