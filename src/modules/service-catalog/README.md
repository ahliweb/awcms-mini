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
version, AND DB `BEFORE` triggers (sql/079) reject any edit of a published
version's content or its feature/quota/price rows. The mutation-guard tests
(`tests/unit/service-catalog-domain.test.ts`,
`tests/integration/service-catalog.integration.test.ts`) prove this is real.

## Static key registry (fail-closed)

`domain/key-registry.ts` builds the allowed-key registry from `listModules()`:
module-entitlement keys are the live module registry's keys; feature/meter keys
are the union of every module's `ModuleDescriptor.serviceCatalog`
contributions. An **unknown key fails closed** (rejected at
draft-edit/validate/publish). A derived application contributes its own keys
through `application-registry.ts` — never a base-registry edit. #874 formalizes
conformance gates on top of this seam.

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

## Default-disabled mechanism (ADR-0022 §7)

This module introduced `ModuleDescriptor.defaultTenantState` +
`isModuleTenantEnabledByDefault` (`_shared/module-contract.ts`), read by every
runtime resolver (`resolveModuleEnabled`, the SSR permission gate, the nav
registry, the tenant-module matrix). A control-plane module with no explicit
`awcms_mini_tenant_modules` row resolves **disabled** — so a LAN/offline
deployment that never activates the control plane keeps it fully inert. The
platform operator's tenant explicitly enables it to use the admin UI/API.
Gated by `tests/unit/module-governance-default-disabled.test.ts`.
