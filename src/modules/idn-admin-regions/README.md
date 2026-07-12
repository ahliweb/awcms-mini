# Indonesia Administrative Regions (`idn_admin_regions`)

Epic: master data wilayah administratif Indonesia dari `cahyadsn/wilayah`
(Issue #655-#664, epic #654). Reusable Indonesia administrative region
(province/regency/district/village) master data for derived applications.
See `.claude/skills/awcms-mini-idn-admin-regions/SKILL.md` for the full
cross-issue plan and status.

## Source and license (read this before touching this module)

- **Repository**: <https://github.com/cahyadsn/wilayah>
- **Source folder**: <https://github.com/cahyadsn/wilayah/tree/master/db>
- **License**: MIT
- **Upstream statement**: "Kode dan Data Wilayah Administrasi Pemerintahan
  dan Kode Pulau Indonesia sesuai Kepmendagri No. 300.2.2-2430 Tahun
  2025."

### Official-reference caveat

**This is a third-party, community-packaged dataset, not an official
Kementerian Dalam Negeri (Kemendagri) API or export.** `cahyadsn/wilayah`
is an independent, MIT-licensed GitHub repository that packages
administrative region data following the Kepmendagri decree cited above —
AWCMS-Mini vendors selected files from it (Issue #656) as a convenience for
derived applications that need region lookups, but never claims to be an
official Kemendagri publisher, feed, or export, and this data is not a
substitute for an operator's own legal/compliance reference to the actual
government decree when that matters (e.g. legal filings, tax
jurisdiction determinations). See
`src/modules/idn-admin-regions/domain/source-provenance.ts` for these
same facts as trusted code constants (single source of truth — later
issues should import them rather than re-typing the URL/license/caveat).

## Why a separate module (not folded into an existing one)

Indonesia administrative region data is:

- **Reference/master data, not tenant data** — the same dataset applies
  identically to every tenant (a region hierarchy doesn't vary per
  tenant), unlike `blog_content`/`news_portal` which are tenant-owned
  content. This is why the module is `type: "base"` rather than
  `"domain"`.
- **Third-party sourced with its own provenance/license obligations** —
  distinct enough (vendored files, commit SHA tracking, checksum
  validation, MIT attribution) to warrant its own module boundary rather
  than being bolted onto `reporting` or `tenant-admin`.
- **Versioned and re-importable** — the epic's design supports importing
  a new upstream release as a new, independently activatable dataset
  (with rollback), a lifecycle no existing module has.

## Scope per issue (epic #654)

Issue #655 (this module — `module.ts`, `domain/source-provenance.ts`):
registers `idn_admin_regions` in the trusted code module catalog
(`src/modules/index.ts`) so it syncs into `awcms_mini_modules` via
`bun run modules:sync`, and declares the five permissions seeded by
migration `sql/048_awcms_mini_idn_admin_regions_permissions.sql` (see
§Permission seed below). Issue #656 then vendored the upstream
`cahyadsn/wilayah` source files and provenance metadata under
`data/idn-admin-regions/` (outside `src/`, since they are not TypeScript
source) — see that directory's own `README.md`/`NOTICE.md` and
`.claude/skills/awcms-mini-idn-admin-regions/SKILL.md` §656 for details.
**Still no dataset schema, no parser/normalizer, no import pipeline, no
activation/rollback, no lookup API, and no admin UI yet** — every one of
those is a later issue, listed below. `application/` is currently empty
(`.gitkeep` only) — there is no application-layer logic to write until a
later issue gives this module its first real database table or endpoint
to orchestrate.

| Issue | Scope                                                                                          | Status      |
| ----- | ---------------------------------------------------------------------------------------------- | ----------- |
| #655  | Scaffold `idn_admin_regions` module (this issue)                                               | **Done**    |
| #656  | Vendor `cahyadsn/wilayah` source metadata + license under `data/idn-admin-regions/`            | **Done**    |
| #657  | Versioned PostgreSQL schema (`awcms_mini_idn_region_datasets`, `awcms_mini_idn_admin_regions`) | Not started |
| #658  | SQL parser/normalizer for upstream MySQL-style dump files                                      | Not started |
| #659  | Repository validation gate for vendored/normalized dataset files                               | Not started |
| #660  | PostgreSQL import pipeline (dry-run/commit)                                                    | Not started |
| #661  | Dataset activation, rollback, and diff                                                         | Not started |
| #662  | Read-only Indonesia region lookup API                                                          | Not started |
| #663  | Admin UI for browsing datasets and validation status                                           | Not started |
| #664  | SOP, docs, and security review                                                                 | Not started |

## Permission seed (migration `048_awcms_mini_idn_admin_regions_permissions.sql`, Issue #655)

`module_key = 'idn_admin_regions'`:

- `region.read` — read Indonesia administrative region records.
- `dataset.read` — read Indonesia administrative region dataset metadata.
- `dataset.import` — import a new Indonesia administrative region
  dataset.
- `dataset.activate` — activate a validated Indonesia administrative
  region dataset.
- `dataset.rollback` — roll back the active Indonesia administrative
  region dataset to the previously active one.

No endpoints or roles are wired to these yet — `dataset.import` is
exercised starting at Issue #660, `dataset.activate`/`dataset.rollback`
at Issue #661, and `region.read`/`dataset.read` at Issue #662's lookup
API.

## Not rebuilt (reuse what already exists)

Per this issue's own architecture notes: no new tenant, auth, RBAC/ABAC,
audit, or sync subsystem is introduced here. Region data is treated as
**global reference data**, not tenant-owned (Issue #657's own security
note) — later issues that add write paths (import/activate/rollback)
still reuse the existing ABAC guard (`authorizeInTransaction`) and audit
log (`recordAuditEvent`) exactly as every other module does; they do not
invent a parallel mechanism.

## Out of scope for the whole epic (per #654)

- Scraping Kemendagri websites directly.
- Claiming the vendored dataset is a direct official Kemendagri export.
- Replacing an operator's official legal/compliance reference.
- Storing personal data.
- Boundary polygons or geospatial shapes (MVP is code/name/hierarchy
  only).
- Building new auth, tenant, audit, or sync systems.
