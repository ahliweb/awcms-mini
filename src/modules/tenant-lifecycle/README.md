# tenant_lifecycle

The **fourth SaaS control-plane module** of epic #868 (Issue #873, Wave 1,
**ADR-0022**). It records the precise **SaaS lifecycle state** of a tenant,
validates **forward-legal transitions** with an optimistic-concurrency version
guard, keeps an **append-only transition history**, schedules future transitions
(trial/grace expiry) that a worker applies **idempotently under concurrency**,
and **derives — never stores as truth — the fail-closed access restrictions** a
state implies. It exposes the read-only **`tenant_restrictions`** capability and
the **`lifecycle_transition`** write capability (consumed by subscription
billing #876), and consumes the fail-closed **`effective_entitlement`** (#871)
and read-only **`provisioning_status`** (#872) contracts.

Admitted as an **Official Optional Business Foundation**, opt-in per tenant,
`defaultTenantState: "disabled"`. Every table is `tenant_id` + `ENABLE` +
`FORCE ROW LEVEL SECURITY` with a policy whose predicate is **always and only**
`tenant_id` (ADR-0022 §6 — no soft super-tenant). Lifecycle commands are
platform-operator only + default-deny, restricted to the **platform (setup
singleton) tenant**.

## A distinct axis

Lifecycle is **not** entitlement and **not** permission: entitlement (#871)
decides WHICH features a tenant has; permission (identity_access) decides WHO may
act; lifecycle decides WHETHER a tenant may operate and HOW MUCH. A positive
lifecycle state never grants a permission the actor lacks.

## States and transitions (`domain/lifecycle-state.ts`, byte-mirrors `sql/089`)

`provisioning · trial · active · renewal_due · past_due · grace · suspended ·
canceled · restoring · blocked`. Transitions are forward-legal only; `canceled`
may leave ONLY toward `restoring` (an explicit, reconciled reactivate). The DB
`BEFORE UPDATE` trigger rejects an illegal transition, requires `version` to
advance by exactly one per state change, and rejects any hard DELETE.

## Server-derived restriction policy (`_shared/tenant-lifecycle-policy.ts`)

The single source of truth mapping a state to a `RestrictionProfile`
(adminAccess / writes / publicSite / backgroundJobs / providerDispatch /
dataExport / ownerRecovery / entitlementActive). It lives in **neutral ground**
(`_shared`, not under this module) so the base `identity_access` auth chokepoint
can **enforce** it WITHOUT importing this control-plane module (a forbidden
reverse dependency). `readTenantRestrictionSnapshot` (also `_shared`) reads the
current state (a READ only) and applies the policy fail-closed:

- **no lifecycle row** → `governing: false`, `ALLOW_ALL` (offline-safe: a tenant
  that never opted in is unrestricted).
- **a row** → `governing: true`, profile derived from state.
- **an unclassifiable state** → `DENY_ALL`.

## Four-surface enforcement (AC — one helper, never per-route)

- **API + SSR**: `authorizeInTransaction` (the single guard chokepoint) consults
  the neutral policy/reader and denies a suspended tenant entirely, a `past_due`
  tenant's writes only. The `tenant_lifecycle` module's own endpoints are exempt
  so an operator/owner can still read status, restore, and run owner recovery /
  data export while restricted.
- **Public host routing + background workers**: enforce the SAME suspension via
  the projected `awcms_mini_tenants.status` (`active` iff `publicSiteAllowed`),
  which the engine sets **in the same commit** as the transition
  (`deps.projectTenantStatus` → `tenant_admin.setTenantStatus`).

## Commands (`application/lifecycle-transition.ts`)

- **`initialize`** — create the record at an initial state (idempotent).
- **`transition`** — a validated state change (activate/suspend/past_due/grace/
  cancel/block/...). Also the `lifecycle_transition` port #876 calls.
- **`scheduleTransition` / `cancelSchedule`** — a single pending future
  transition on the state row; the scheduler applies it idempotently.
- **`applyDueSchedule`** (via `application/lifecycle-scheduler.ts` +
  `bun run tenant-lifecycle:run-scheduled <tenantId>`) — row-lock + state+version
  predicate make it safe under concurrent workers; the loser is a clean no-op.
- **`downgrade`** — changes the effective entitlement via the #871 assign path
  WITHOUT changing lifecycle state and WITHOUT deleting data.
- **`restore`** — moves a suspended/canceled/blocked tenant `-> restoring ->
active` WITH reconciliation against provisioning readiness (#872); an
  unresolved state must be explicitly confirmed (`confirmUnresolved`).

Every command records an **append-only history** row, emits a **versioned domain
event same-commit** (`.transitioned` / `.downgraded` / `.restored` /
`.scheduled`), and writes an **audit** record with a **mandatory reason**.

## Concurrency + idempotency

Row-lock (`SELECT ... FOR UPDATE`) → app validation → state+version-predicated
`UPDATE` (0 rows → deterministic 409). Route mutations require `Idempotency-Key`
(replay-safe, with `replayConcurrentIdempotentWinner` for a same-key row-lock
race). No `Promise.all` on a single transaction.

## Boundary

`awcms_mini_tenant_lifecycle_*` is written ONLY by this module + its routes
(no-shared-table-write). No other module imports `tenant-lifecycle/application`
or `/domain`; downstream consumers use the `tenant_restrictions` /
`lifecycle_transition` ports wired at their own composition root.
Gated by `tests/unit/module-boundary.test.ts`.
