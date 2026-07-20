# tenant_provisioning

The **third SaaS control-plane module** of epic #868 (Issue #872, Wave 1,
**ADR-0022**). It orchestrates an **idempotent, resumable** tenant-provisioning
run — tenant bootstrap, owner identity, default configuration, optional
entitlement assignment (#871), optional module preset, optional subdomain, and
mandatory readiness — with durable checkpoints, bounded retries, lease/lock
ownership, explicit compensation classification, and **non-destructive**
reconciliation. It exposes the read-only **`provisioning_status`** capability and
consumes the fail-closed **`effective_entitlement`** contract.

Admitted as an **Official Optional Business Foundation**, opt-in per tenant,
`defaultTenantState: "disabled"`. Every table is `tenant_id` + `ENABLE` +
`FORCE ROW LEVEL SECURITY` with a policy whose predicate is **always and only**
`tenant_id` (ADR-0022 §6 — no soft super-tenant). Provisioning commands are
platform-operator only + default-deny, and the API further restricts them to the
**platform (setup singleton) tenant**.

## Reuse, not duplicate (AC)

Tenant/owner/office/config creation is the **shared `tenant_admin` onboarding
helpers** (`tenant-onboarding.ts`) — the SAME building blocks the platform setup
wizard composes, so there is one implementation of "create a tenant + owner", not
two. Entitlement assignment reuses the `tenant_entitlement` assign/cancel path
(#871). No creation logic is duplicated.

## The engine (ADR-0022 §9/§11.1)

- **`request`** — one transaction: create the tenant (ACID anti-duplicate on the
  global `awcms_mini_tenants.tenant_code` unique index), owner, office, settings,
  and the run + step rows, then emit `requested` — all same-commit. The two
  secret-bearing steps (tenant bootstrap + owner) run here (they need the
  request-time owner password, which is **never stored** — only its fingerprint
  feeds the idempotency hash) and are recorded pre-completed. A same-key replay
  returns the existing run; a different request for a taken tenant code is a
  deterministic 409.
- **`start`/`resume`/`retry`** — acquire an exclusive **lease** (row-lock +
  state-predicate → clean 409 on a concurrent run; an expired lease is
  reclaimable → worker-restart safe), then run each remaining step in its **own
  transaction** so a completed step's checkpoint is durable before the next step
  starts. A retryable failure re-runs within the step's **bounded attempt
  budget**. A `provider` step returns `waiting` (event out via the outbox,
  OUTSIDE any provider call) and the run pauses until resumed.
- **`cancel`** — refuses if a worker holds a live lease; runs classified
  compensation; leaves the tenant inactive.
- **`reconcile`** — a **non-destructive** desired-vs-actual pass that reports
  drift + safe operator actions, **never** an auto-fix.

## Compensation classification (explicit, ADR-0022 §9)

Every plan step declares a class:

- **reversible** — `compensate` runs an idempotent undo (entitlement cancel,
  module disable, domain deactivate, config reset) — all STATE changes.
- **manual** — recorded `manual_required` for an operator; never auto-reversed
  (an owner identity is never silently deleted).
- **forbidden** — never reversed: the tenant record itself (never deleted as
  compensation) and readiness (nothing to undo) are `skipped_forbidden`.

A failed/canceled run **never leaves the tenant active** — it stays inactive with
a visible `failed`/`blocked` status + `readiness = blocked` (AC).

## Records (all tenant-scoped, RLS FORCE)

`requests`, `steps`, `step_attempts` (append-only), `results` (append-only),
`compensations`, `reconciliations` (append-only). Immutability/write-once is
enforced by DB triggers (`sql/085`): a completed step's `checkpoint` is
write-once; attempts/results/reconciliations reject UPDATE/DELETE; no row is ever
hard-deleted (DELETE is REVOKEd).

## Versioned plan/step registry + derived steps

`domain/provisioning-plan.ts` holds versioned plans (base ships `standard_tenant`
v1). A derived application contributes its own plans (`registerProvisioningPlan`)
and step handlers (`registerProvisioningStep`, `infrastructure/step-handler-
registry.ts`) from its composition root — a static, reviewed-source seam, no
runtime discovery/`eval`. A step with no resolvable handler FAILS CLOSED (blocks).

## LAN/offline (AC)

Optional steps (entitlement, module preset, subdomain) **skip** when their
capability is absent/disabled — a LAN/offline run with every provider step absent
still provisions. The module is default-disabled, so a deployment that never
enables the control plane is fully inert.

## API (operator-only, platform tenant)

- `POST /api/v1/tenant-provisioning/requests` — request a run (creates the tenant).
- `GET  /api/v1/tenant-provisioning/tenants/{tenantId}` — the run timeline.
- `POST /api/v1/tenant-provisioning/tenants/{tenantId}/start` · `/cancel` · `/reconcile`.

Events: `awcms-mini.tenant-provisioning.requested` / `.completed` / `.failed` /
`.reconciled` (v1.0). Admin UI: `/admin/tenant-provisioning`.

See the `awcms-mini-tenant-provisioning` skill and `docs/adr/0022-*.md`.
