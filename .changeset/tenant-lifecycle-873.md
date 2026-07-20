---
"awcms-mini": minor
---

feat(tenant-lifecycle): enforce trial, active, grace, suspended, canceled, restore, and downgrade semantics (#873)

The FOURTH SaaS control-plane module (epic #868 Wave 1, ADR-0022) — an Official
Optional Business Foundation, opt-in per tenant, `defaultTenantState: "disabled"`,
tenant-scoped (every table `tenant_id` + `ENABLE` + `FORCE RLS`, predicate always
and only `tenant_id` — no soft super-tenant). Lifecycle is a DISTINCT axis from
entitlement (#871) and permission (identity_access): it decides WHETHER a tenant
may operate and HOW MUCH.

- **State machine** (migration `sql/089`): 10 states (provisioning/trial/active/
  renewal_due/past_due/grace/suspended/canceled/restoring/blocked) with a
  forward-legal transition whitelist enforced by a DB `BEFORE UPDATE` trigger
  that byte-mirrors `domain/lifecycle-state.ts`, an optimistic-concurrency
  `version` that advances by exactly one per transition, an append-only history
  table, and `REVOKE DELETE`/append-only guards. `canceled` may only leave toward
  `restoring`. A suspend/cancel/downgrade changes STATE (+ entitlement), NEVER
  deletes tenant data.
- **Server-derived, fail-closed restrictions** (`_shared/tenant-lifecycle-policy.ts`
  + `_shared/tenant-lifecycle-restriction-read.ts`, neutral ground): a state maps
  deterministically to a `RestrictionProfile`. Enforced at the SINGLE API+SSR auth
  chokepoint (`authorizeInTransaction`) — a suspended tenant is denied entirely, a
  `past_due` tenant's writes only; the module's own endpoints are exempt so owner
  recovery/export stay reachable. Public host routing + background workers enforce
  the SAME suspension via the projected `awcms_mini_tenants.status`, set in the
  same commit — the four-surface parity. A tenant with no lifecycle row is
  UNRESTRICTED (offline/LAN-safe); a governing read error is `DENY_ALL`.
- **Concurrency-safe transitions**: row-lock + state+version-predicated UPDATE
  (invalid transition / stale version → deterministic 409). Idempotent scheduled
  transitions (trial/grace expiry) applied safely under concurrent workers
  (`bun run tenant-lifecycle:run-scheduled`). Every mutation requires
  `Idempotency-Key` + a mandatory audited reason and emits a versioned domain
  event same-commit (`.transitioned`/`.downgraded`/`.restored`/`.scheduled`).
- **Downgrade** changes the effective entitlement via the #871 contract without
  deleting data; **restore** runs reconciliation against provisioning readiness
  (#872) and refuses to silently overlook an unresolved state.
- PROVIDES the `tenant_restrictions` (read) and `lifecycle_transition` (write,
  consumed by billing #876) capabilities; CONSUMES `effective_entitlement` (#871)
  and `provisioning_status` (#872) at its composition root.
- Migrations `sql/089` (schema/RLS/triggers) + `sql/090` (permission seed),
  operator admin UI, OpenAPI/AsyncAPI, i18n, module README + skill, and the
  registry blast-radius (28 modules) all synchronized.
