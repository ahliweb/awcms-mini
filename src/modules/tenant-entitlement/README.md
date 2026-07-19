# tenant_entitlement

The **second SaaS control-plane module and the HEART** of epic #868 (Issue
#871, Wave 1, **ADR-0022**). It derives a tenant's **effective feature/module/
quota entitlement** from published `service_catalog` offers plus platform-
operator overrides, and exposes the single fail-closed **`effective_entitlement`**
contract the tenant-plane and downstream control-plane modules (#872/#873/#875/
#876) consume to gate commercial access.

It is the **first tenant-scoped control-plane module**: every table is
`tenant_id` + `ENABLE` + `FORCE ROW LEVEL SECURITY`, with a policy whose
predicate is **always and only** `tenant_id = current_setting('app.current_tenant_id')::uuid`
(ADR-0022 §6 — no soft super-tenant; the predicate is never extended with an
`OR platform-claim` clause). Admitted as an **Official Optional Business
Foundation**, opt-in per tenant, `defaultTenantState: "disabled"`. Management is
platform-operator only + default-deny.

## The fail-closed contract (ADR-0022 §4 High-2)

`effective_entitlement` (`_shared/ports/effective-entitlement-port.ts`) is
**read-only** and **fail-closed**: anything unknown, absent, indeterminate,
unavailable, or resolved from a disabled/unprovisioned `tenant_entitlement`
returns **DENY** — never grant-all. The gating decision lives in ONE helper
(`domain/resolution.ts` `isFeatureAllowed`/`isModuleEntitled`/`getQuota` + the
port adapter), never per-route.

**Entitlement is not permission.** A positive answer is a COMMERCIAL fact on a
DIFFERENT axis from RBAC/ABAC/RLS — a consumer must ALSO pass its own
permission/module-enabled gates, and a positive entitlement can never grant an
authorization the actor lacks. Module entitlement is also distinct from a
module's enabled-state (`awcms_mini_tenant_modules`), though coordinated:
entitlement loss changes STATE + gates, it never deletes tenant data.

## Resolution (deterministic, explainable, bounded)

`application/entitlement-resolution.ts` loads records in BULK (two record reads

- one published-offer read per distinct subscribed offer, via the
  `service_catalog_read` port) and calls the PURE `resolveEffectiveEntitlement`.
  Query count is CONSTANT with respect to the number of keys resolved — never a
  per-request N+1 catalog query.

Precedence per key: an ACTIVE override REPLACES the offer decision (the DB
guarantees at most one active override per key, so grant/deny is unambiguous);
with no override, an active assignment's offer grant holds; with neither, the
key is absent and the lookup denies. A suspended/expired/canceled assignment
contributes nothing (suspension/lifecycle restriction). Entitled modules whose
declared dependency (that is itself an entitlement decision) is not entitled are
safely downgraded (fixpoint). The resolution's explanation carries a high-level
source (`offer`/`override`/`dependency_not_entitled`/`default_deny`) — never an
operator's free-text reason.

## Records + write paths

- **assignments** (`awcms_mini_tenant_entitlement_assignments`) — a subscription
  to a published offer version; effective-dated (trial/grace) and lifecycle-aware
  (active/suspended/canceled). A newer assignment supersedes the current one.
- **overrides** (`awcms_mini_tenant_entitlement_overrides`) — an operator
  grant/deny of a feature/module/quota; reason-bound, optionally time-bound,
  revocable without restart.
- **evaluation_snapshots** (`awcms_mini_tenant_entitlement_evaluation_snapshots`)
  — append-only immutable record of what the effective entitlement resolved to
  after each change; carries a tenant-facing `snapshot_hash` for reproducibility
  - deterministic cache invalidation.

Every mutation runs the uniform concurrency pattern (row-lock or `ON CONFLICT` +
status-predicated UPDATE → clean 409; idempotency-replay wins a same-key race),
writes the snapshot + emits a versioned domain event (same-commit), and is
audited. Assign/override/revoke require `Idempotency-Key`. Immutability/write-once
is enforced by DB triggers (`sql/081`) beneath the application guards, and no row
is ever hard-deleted (DELETE is REVOKEd).

## API (operator-only, current-tenant context)

- `GET  /api/v1/tenant-entitlement/effective` — resolved entitlement + explanation (`?at=`).
- `GET  /api/v1/tenant-entitlement/assignments` · `POST` assign.
- `PATCH /api/v1/tenant-entitlement/assignments/{assignmentId}` — suspend/resume (`update`) / cancel (`revoke`).
- `GET  /api/v1/tenant-entitlement/overrides` · `POST` create override.
- `POST /api/v1/tenant-entitlement/overrides/{overrideId}/revoke`.

Events: `awcms-mini.tenant-entitlement.assignment.changed`,
`awcms-mini.tenant-entitlement.override.changed` (v1.0). Admin UI:
`/admin/tenant-entitlement`.

See the `awcms-mini-tenant-entitlement` skill and `docs/adr/0022-*.md`.
