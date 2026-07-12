---
"awcms-mini": minor
---

Add the versioned PostgreSQL schema for Indonesia administrative region
datasets (Issue #657, epic #654 — master data wilayah administratif
Indonesia dari `cahyadsn/wilayah`, following #655's module scaffold and
#656's vendored source data). Migration `sql/054` adds two GLOBAL
reference tables (no `tenant_id`, no RLS — identical for every tenant):

- `awcms_mini_idn_region_datasets` — one row per imported dataset
  version, recording upstream provenance (repository, source path,
  commit SHA, license, file checksum), row count, lifecycle `status`
  (`validated`/`active`/`superseded`/`rejected`), and validation summary.
  "Only one dataset can be active at a time" is enforced with a partial
  unique index on `status` `WHERE status = 'active'`.
- `awcms_mini_idn_admin_regions` — one row per normalized administrative
  region (province/regency/district/village) belonging to a dataset.
  Unique `(dataset_id, code)`, a `(dataset_id, parent_code)` parent-lookup
  index, and a `(dataset_id, normalized_name)` search index.

Both tables are added to `RLS_FREE_TABLES`/`ALLOWED_GLOBAL_TABLE_GRANTS`
in `scripts/security-readiness.ts` and to `RLS_EXEMPT_TABLES` in
`scripts/repo-inventory-generate.ts`. `awcms_mini_app` is granted ZERO
access on either table in this migration (no runtime code path reads or
writes them yet — schema only) — future issues (#660 import, #661
activate/rollback, #662 lookup API) each add exactly the grant their own
new code path needs.

No parser/normalizer (#658), validation gate (#659), import pipeline
(#660), activation/rollback (#661), lookup API (#662), or admin UI (#663)
yet — those land in later issues of the same epic (see
`.claude/skills/awcms-mini-idn-admin-regions/SKILL.md`).
