---
"awcms-mini": minor
---

feat(tenant-provisioning): add idempotent provisioning workflow, compensation, reconciliation, and readiness (#872)

The third SaaS control-plane module (epic #868 Wave 1, ADR-0022). Admitted as an
Official Optional Business Foundation, opt-in per tenant, `defaultTenantState:
"disabled"`, tenant-scoped (every table `tenant_id` + `ENABLE` + `FORCE RLS`,
predicate always-and-only `tenant_id` — no soft super-tenant). Provisioning
commands are platform-operator only + default-deny and restricted to the
platform (setup singleton) tenant.

Orchestrates an idempotent, resumable tenant-provisioning run from a versioned
plan/step registry: tenant record/bootstrap, owner identity, default
configuration/locale, optional entitlement assignment (via the #871
`tenant_entitlement` path), optional module preset, optional subdomain,
mandatory readiness, and derived-application contributed steps (via the
`provisioning_step` capability port). Durable checkpoints, bounded retries,
lease/lock ownership, idempotency-key replay, explicit compensation
classification (reversible/manual/forbidden), and non-destructive
desired-vs-actual reconciliation. It REUSES existing tenant/owner/office/config
creation (shared `tenant_admin` onboarding helpers, extracted from the setup
wizard) rather than duplicating it; runs provider/async work OUTSIDE the source
transaction (outbox/domain events); and NEVER deletes tenant data as
compensation. A failed/canceled run leaves the tenant inactive with a visible
blocked/failed status + `readiness=blocked` — never active without mandatory
security controls. Provider secrets are references only, never in step
payloads/logs; the owner password is consumed once at request time and never
stored. Provides the read-only `provisioning_status` capability; consumes the
fail-closed `effective_entitlement` contract. LAN/offline safe: provisions with
all online/provider steps absent or disabled.

Adds migrations 085/086 (six tenant-scoped tables with immutability/write-once/
append-only triggers + least-privilege grants), the `tenant_provisioning`
module, five REST endpoints (+ OpenAPI), four domain events (+ AsyncAPI), an
admin control panel, audit, and metrics-safe observability.
