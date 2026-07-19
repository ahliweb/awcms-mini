# service_catalog

The **first SaaS control-plane module** (Issue #870, epic #868, ADR-0022).
Admitted as an **Official Optional Business Foundation** module: in-repo
reviewed code, **opt-in per tenant, `defaultTenantState: "disabled"`**. A
provider-neutral, versioned commercial **plan/offer catalog** — not an ERP
item/product master (ADR-0013 §3).

## What it does

- **Plans** (`awcms_mini_service_catalog_plans`) — a stable, named commercial
  identity an operator sells (`plan_key` immutable; plan-level status
  `active`/`archived`).
- **Offer versions** (`awcms_mini_service_catalog_plan_versions`) — each plan
  has versioned offers with a lifecycle `draft -> published -> retired ->
archived`. A **published version is IMMUTABLE**; corrections create a NEW
  version.
- **Feature/module grants** (`..._version_features`) — a fine-grained
  `feature` key OR a whole-`module` entitlement key.
- **Quotas** (`..._version_quotas`) — `meter_key` + unit + reset policy;
  `is_unlimited` XOR an exact integer `limit_value`.
- **Prices** (`..._version_prices`) — `amount_minor` is EXACT minor currency
  units (`bigint`, **never a float**). `visibility` = `public` | `internal`.
- **Published projection** (`..._published_offers`) — the tenant-readable
  snapshot; see below.

## The two-tier data model (ADR-0022 §3 Medium-1)

All catalog tables are **GLOBAL** (no `tenant_id`, reviewed RLS-exempt in
`scripts/security-readiness.ts`). RLS-free does **not** mean the whole catalog
is tenant-readable:

- **Tier A — operator authoring/lifecycle** (plans + versions +
  features/quotas/prices). Holds every lifecycle state and `internal` prices.
  Mutated only by the platform-operator-only, default-deny `service_catalog.*`
  endpoints. Tenant-plane code never queries these (enforced by
  `tests/unit/module-boundary.test.ts`).
- **Tier B — the published projection** (`..._published_offers`). Written only
  at publish time; it **physically cannot** contain a draft/retired-authoring
  row or an internal price (only the published version + the `public` price
  subset). It is the single surface the `service_catalog_read` capability
  reads.

## Immutability

Enforced in two layers: the application service rejects editing a non-draft
version, AND DB `BEFORE` triggers (sql/079) enforce a DEFENCE-IN-DEPTH freeze
that must cover EVERY table, column, and edge (not just content) — the pattern
#871-#877 copy:

- **plan_versions**: no backward status transition; content frozen once out of
  draft; publish/retire **provenance** (`published_at`/`published_by`,
  `retired_at`/`retired_by`) frozen after their own transition.
- **features/quotas/prices**: frozen once the parent leaves draft, AND a row may
  not be **reparented** (`version_id` change forbidden; both OLD and NEW parents
  must be draft) — otherwise a row could be moved out of a frozen version.
- **plans.plan_key**: immutable (renaming orphans published offers).
- **published_offers**: an immutable projection with ALL THREE DML closed —
  **INSERT** is guarded (the source version must be `published` AND
  plan_key/version must match the source, so a tenant-readable offer can never
  be inserted for a draft or a mismatched identity); **UPDATE** freezes every
  column except `retired_at`, which is **write-once one-way** (`NULL ->
non-null` only; a retired offer can never be re-activated or re-dated);
  **DELETE** is revoked at the grant level. (Grant-level revokes are not enough
  for INSERT/UPDATE because publish/retire need write access, so triggers
  enforce the row/column integrity.)

The mutation-guard tests (`service-catalog-domain.test.ts`,
`service-catalog.integration.test.ts`) prove each is real.

## Tenant-facing fingerprint (offer hash)

The `offerHash` is stored on the projection AND returned to the tenant-plane by
`service_catalog_read`, so it is computed over EXACTLY the tenant-visible
projection shape and nothing else. Two invariants, both gated by tests:

- **Covers every tenant-visible column** (`OFFER_HASH_FIELDS` /
  `PROJECTION_COLUMN_TO_HASH_FIELD`): plan_key, **plan_name, plan_type**,
  version, currency, market, trial_*, availability, features, quotas, and the
  PUBLIC prices. An integration test asserts the map's keys equal the real
  projection columns, so a new column forces a decision — no tenant-visible
  field can ever be left unhashed.
- **Never over operator-only data**: internal price amounts are excluded, so
  the exposed hash can't be a brute-force ORACLE for them.

Lesson for #871-#877: any fingerprint exposed to the tenant must be derived from
the tenant-visible projection shape ONLY, and its coverage must be gated against
the real projection columns (not assumed).

## Static key registry (fail-closed)

`domain/key-registry.ts` resolves the allowed-key registry from `listModules()`:
module-entitlement keys are the live module registry's keys; feature/meter keys
are the union of every module's `ModuleDescriptor.serviceCatalog` contributions.
An **unknown key fails closed** (rejected at draft-edit/validate/publish). A
derived application contributes its own keys through `application-registry.ts` —
never a base-registry edit. Since **Issue #874** this file **re-exports** the
single source of truth `src/modules/_shared/saas-contract-registry.ts` (shared by
`tenant_entitlement` and usage metering) rather than aggregating privately; the
richer descriptor contract (quota/meter/commercial-event, fail-closed validation,
`bun run saas-contracts:registry:check`) is documented in
[`docs/awcms-mini/saas-contract-registry.md`](../../../docs/awcms-mini/saas-contract-registry.md).

## Capability port

`service_catalog` **PROVIDES** `service_catalog_read`
(`_shared/ports/service-catalog-read-port.ts`) — read-only, published-only. The
adapter (`application/service-catalog-read-port-adapter.ts`) reads exclusively
the published projection. `tenant_entitlement` (#871) consumes it; consumers
wire the adapter at their own route/composition root, never a direct import.

## API (`/api/v1/service-catalog`)

`GET/POST /plans`, `GET/PATCH /plans/{planKey}`, `POST
/plans/{planKey}/versions`, and `POST .../versions/{version}/{validate,publish,
retire}`. `create`/`versions`/`publish`/`retire` require `Idempotency-Key`;
`publish`/`retire` emit versioned domain events
(`awcms-mini.service-catalog.offer.{published,retired}`) and are audited.

## Events

`awcms-mini.service-catalog.offer.published` / `.offer.retired` (v1.0), via
`domain_event_runtime`'s `appendDomainEvent` in the same transaction as the
state change. Payload carries plan key/version/offer hash — never internal
prices.

## Concurrency template (uniform across every operator write path)

Every mutation in `application/plan-directory.ts` follows ONE pattern so a
concurrent operation never produces a raw 500 or a stale projection — the
template #871-#877 should copy:

1. **Row-lock before check-then-write.** Lock the row you are about to
   transition/validate with `SELECT ... FOR UPDATE` FIRST:
   - `publishVersion`/`retireVersion` lock the **version** row
     (`loadVersionByPlanKeyForUpdate`).
   - `updatePlanDraft` locks the **draft version** (`loadDraftVersionForUpdate`)
     BEFORE touching the plan header — so a racing publish can't leave the
     projection carrying an old `plan_name`/`plan_type` (Codex-D).
   - `createDraftVersion` locks the **plan** row (`loadPlanIdForUpdate`) before
     the `draft_exists` check (Codex-E).
2. **Status-predicated UPDATE.** Transition with `UPDATE ... WHERE id = ? AND
status = <expected>`; a 0-row result is a clean idempotent conflict → the
   caller returns a deterministic **409**, never a second event/audit.
3. **INSERT-with-uniqueness → `ON CONFLICT DO NOTHING RETURNING`.** When there
   is no row to lock yet (`createPlan`), a concurrent same-key insert returns 0
   rows → clean `duplicate_key` (409), never a raw 23505 (500).

There is no check-then-write left without a lock. Each path has a concurrency
test in `tests/integration/service-catalog.integration.test.ts` proving one
winner + one clean 409 (and, for publish/retire, exactly one event + one audit).

## Default-disabled mechanism (ADR-0022 §7)

This module introduced `ModuleDescriptor.defaultTenantState` +
`isModuleTenantEnabledByDefault` (`_shared/module-contract.ts`), read by every
runtime resolver (`resolveModuleEnabled`, the SSR permission gate, the nav
registry, the tenant-module matrix). A control-plane module with no explicit
`awcms_mini_tenant_modules` row resolves **disabled** — so a LAN/offline
deployment that never activates the control plane keeps it fully inert. The
platform operator's tenant explicitly enables it to use the admin UI/API.
Gated by `tests/unit/module-governance-default-disabled.test.ts`.
