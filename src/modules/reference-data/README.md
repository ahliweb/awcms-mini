# `reference_data`

Optional, provider-neutral reference-data foundation (Issue #750, epic
`platform-evolution` #738 Wave 3, `docs/adr/0021-reference-data-module-admission.md`).
Official Optional Business Foundation module (ADR-0013 §1) — opt-in per
tenant, generic across every derived application.

## What this module owns

- **Value sets** (`awcms_mini_reference_value_sets`) — a stable, named
  catalog (e.g. `"currency"`, `"unit_of_measure"`, `"fiscal_calendar"`).
  `scope` distinguishes `module_contributed` (declared statically by
  another module's own `module.ts`, synced by
  `application/contribution-sync.ts`) from `platform_curated` (created
  directly via this module's own API). `overridePolicy` governs what a
  tenant may do in the tenant-scoped tables below.
- **Codes** (`awcms_mini_reference_codes` + `awcms_mini_reference_code_translations`)
  — one row per code within a value set (e.g. `"IDR"` in `"currency"`),
  effective-dated, localized, with provenance and deprecation/
  supersession. Never hard-deleted once referenced by a tenant override/
  extension.
- **Import batches** (`awcms_mini_reference_imports`) — one row per
  dry-run/commit import batch for a value set's baseline codes.
- **Tenant overrides/extensions** (`awcms_mini_reference_tenant_codes` +
  `awcms_mini_reference_tenant_code_translations`) — TENANT-SCOPED (RLS
  FORCE, predicate always and only `tenant_id`). An override
  (`baseCodeId` set) restates an existing baseline code's attributes for
  one tenant only; an extension (`baseCodeId` null) is a wholly new
  tenant-defined code. NEVER writes to the global baseline tables above.

**Global vs tenant-scoped, explicitly.** The first four tables are
GLOBAL — no `tenant_id` column, no RLS — identical for every tenant by
design, the same reviewed-exempt pattern `awcms_mini_permissions`/
`awcms_mini_modules`/`awcms_mini_idn_admin_regions` already establish
(registered in `scripts/security-readiness.ts`'s `RLS_FREE_TABLES` and
`ALLOWED_GLOBAL_TABLE_GRANTS`). Mutating them still requires a normal
tenant-authenticated request with the right `reference_data.*`
permission — **this codebase has no separate "platform superadmin"
concept** — so operators MUST grant `reference_data.value_sets.*`/
`.codes.*`/`.imports.*` narrowly, since those actions affect the
baseline shared by every tenant, not just the caller's own tenant.

## Relationship to `idn_admin_regions`

`idn_admin_regions` (Indonesia administrative-region master data) is
**not** duplicated or migrated into this module (ADR-0021 §4). It has
its own 4-level hierarchical schema that doesn't map cleanly onto this
module's flat value-set/code model. It may, in a future issue of its
own, choose to ALSO register itself as a module-contributed value set
via the mechanism below — a purely optional extension seam, not a
requirement.

## Module-contributed catalogs (no direct table imports)

Another module declares its own reference catalog statically in its own
`module.ts`:

```ts
export const myModule = defineModule({
  // ...
  referenceData: {
    contributesValueSets: [
      {
        key: "my_value_set",
        name: "My Value Set",
        description: "...",
        overridePolicy: "tenant_extend",
        codes: [{ code: "A", labels: [{ locale: "en", label: "A" }] }]
      }
    ]
  }
});
```

Validated by `domain/contribution-registry.ts`
(`bun run reference-data:contributions:check`, wired into
`bun run check` and CI) and synced into this module's own tables by
`application/contribution-sync.ts` (`bun run
reference-data:contributions:sync`) — an explicit operational step,
never invoked automatically by another module's code. This module ships
its OWN example contributions (currency/unit-of-measure/fiscal-calendar,
`application/seed-contributions.ts`) using this exact mechanism, as a
neutral, non-authoritative demonstration — see that file's own header
comment for the "not comprehensive, not regulatory authority" caveat.

## Validated import

`application/import-service.ts`:

1. **Dry-run** (`POST /value-sets/{key}/imports`) — computes a diff
   against the existing `provenance = "import"` baseline codes. Never
   mutates `awcms_mini_reference_codes`. Persists an
   `awcms_mini_reference_imports` row (`status: "validated"` or
   `"rejected"`) with the diff summary and a checksum.
2. **Commit** (`POST /imports/{id}/commit`) — re-validates the checksum
   AND re-runs the full diff computation INSIDE the same transaction as
   the write (never trusts the dry-run alone — data may have changed
   since). Applies creates/updates/deprecations. **Rejects** (whole
   transaction, no partial write) any payload entry requesting
   `replace: true` against a code already referenced by a tenant
   override/extension.
3. **Rollback** (`POST /imports/{id}/rollback`) — reverts a committed
   batch's cumulative effect: deletes codes it created (only if still
   unreferenced — refuses otherwise, a documented recovery-notes
   limitation, not a silent bypass), restores previous attribute
   snapshots for codes it updated, un-deprecates codes it deprecated.

## Capability port

`_shared/ports/reference-data-port.ts` (`ReferenceDataPort`) — resolves a
single code or a value-set snapshot for a tenant, merging baseline +
tenant override with deterministic precedence (`domain/resolution.ts`).
Implemented by `application/reference-data-port-adapter.ts`. No module in
this repo consumes it yet (extension seam, same "provides before a real
consumer exists" precedent `organization_structure`'s
`BusinessScopeHierarchyPort` set).

## Mutation surface — Idempotency-Key + audit on EVERY endpoint

Every create/update/deprecate/restore/import-dry-run/import-commit/
import-rollback endpoint in this module requires `Idempotency-Key` and is
audited (`awcms-mini-audit-log`) — a deliberately blanket rule (not a
named subset) after this epic's prior PRs found gaps from partial
coverage. `commit`/`rollback` (import) are classified `HIGH_RISK_ACTIONS`
in `identity-access/domain/access-control.ts`, alongside the existing
`delete`/`restore`.

## Endpoints

`/api/v1/reference-data/value-sets`, `.../{key}`, `.../{key}/restore`,
`.../{key}/codes`, `.../{key}/codes/{code}`,
`.../{key}/codes/{code}/restore`, `.../{key}/imports`,
`.../{key}/imports/{importId}`, `.../{key}/imports/{importId}/commit`,
`.../{key}/imports/{importId}/rollback`, `/api/v1/reference-data/tenant-codes`,
`.../{id}`, `.../{id}/restore` — see `openapi/awcms-mini-public-api.openapi.yaml`
(tag `Reference Data`).

## Admin UI

`/admin/reference-data/value-sets`, `/admin/reference-data/codes`
(codes + validated import panel, `?valueSet=<key>`),
`/admin/reference-data/tenant-codes` (`?valueSet=<key>`).

## Events

`awcms-mini.reference-data.value-set.{created,updated,deprecated}`,
`.code.{created,updated,deprecated}`, `.import.{committed,rolled-back}`,
`.tenant-code.{created,deprecated}` — see
`asyncapi/awcms-mini-domain-events.asyncapi.yaml` and
`domain-event-runtime/domain/event-type-registry.ts`.

## Out of scope (this issue)

Product/item catalogs, chart of accounts, tax rules, payroll rules, or
any other domain master data; replacing `idn_admin_regions`; real-time
external provider calls during resolution (import is a validated,
operator-submitted payload, not a live external fetch).
