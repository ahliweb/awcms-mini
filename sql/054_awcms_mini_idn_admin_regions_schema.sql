-- Issue #657 (epic #654, master data wilayah administratif Indonesia) —
-- versioned PostgreSQL schema for the `idn_admin_regions` module (scaffolded
-- by #655, source data vendored by #656). Two tables:
--
--   1. `awcms_mini_idn_region_datasets` — one row per IMPORTED dataset
--      (an import "batch"/version). Records upstream provenance (repository,
--      source path, commit SHA, license — the same facts
--      `src/modules/idn-admin-regions/domain/source-provenance.ts` and
--      `data/idn-admin-regions/manifest.json` already carry) plus lifecycle
--      status and validation summary.
--   2. `awcms_mini_idn_admin_regions` — one row per normalized administrative
--      region (province/regency/district/village), belonging to exactly one
--      dataset via `dataset_id`. A region's identity (`code`) is only unique
--      WITHIN a dataset — re-importing a new dataset version creates an
--      entirely new set of region rows, never overwrites the previous
--      dataset's rows in place (this is what makes rollback in #661 possible:
--      the previous dataset's rows are still there, untouched).
--
-- This issue is SCHEMA ONLY (see the issue body's own scope) — no parser
-- (#658), no validation gate (#659), no import pipeline (#660), no
-- activation/rollback/diff (#661), no lookup API (#662). Nothing in this
-- migration writes a row; it only creates the tables/constraints/indexes
-- future issues will read and write.
--
-- GLOBAL REFERENCE DATA, NOT TENANT-SCOPED (deliberate, matches
-- `src/modules/idn-admin-regions/README.md`'s own "Not rebuilt" section and
-- `.claude/skills/awcms-mini-idn-admin-regions/SKILL.md`): administrative
-- region data is identical for every tenant, the same way
-- `awcms_mini_modules`/`awcms_mini_permissions` are global rather than
-- per-tenant. Neither table below has a `tenant_id` column, RLS, or a
-- tenant-isolation policy — that is intentional, not an oversight. Per
-- `.claude/skills/awcms-mini-new-migration/SKILL.md`'s "Tabel BARU tanpa
-- tenant_id/RLS" section, both tables are added to `RLS_FREE_TABLES` in
-- `scripts/security-readiness.ts` (so `checkRlsEnabled` does not flag them
-- as unenforced tenant-scoped tables) and to `ALLOWED_GLOBAL_TABLE_GRANTS`
-- (so `checkRuntimeRoleGlobalTableGrants` — Issue #683, epic #679 — has an
-- explicit allowlist entry for them).
--
-- LEAST-PRIVILEGE GRANTS (same convention as
-- `sql/045_awcms_mini_db_role_separation.sql`): migration 013's
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE,
-- DELETE ON TABLES TO awcms_mini_app` fires automatically for these two
-- BRAND NEW tables the moment `CREATE TABLE` runs, exactly like it did for
-- the 9 existing global tables before migration 045 narrowed them. As of
-- THIS issue, no runtime code path reads or writes either table yet
-- (`awcms_mini_worker`/`awcms_mini_setup` never had a rule granting them
-- anything on new tables to begin with, so they already have zero access).
-- Both `REVOKE ALL ... FROM awcms_mini_app` below immediately follow the
-- `CREATE TABLE`, in the same transaction, so `awcms_mini_app` ends this
-- migration with ZERO grants on either table — future issues that add real
-- code (Issue #660's import pipeline needs INSERT on both tables and UPDATE
-- on the dataset row; Issue #661's activate/rollback needs UPDATE on
-- `awcms_mini_idn_region_datasets.status`/`activated_at`/`activated_by`;
-- Issue #662's read-only lookup API needs SELECT on both) each add exactly
-- the grant their own new code path needs, in their own migration, rather
-- than this schema-only issue guessing ahead of time which rights will
-- actually be exercised.

CREATE TABLE IF NOT EXISTS awcms_mini_idn_region_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_code text NOT NULL,
  source_type text NOT NULL DEFAULT 'third_party_github_repository',
  source_repository text NOT NULL,
  source_path text NOT NULL,
  source_commit_sha text NOT NULL,
  source_license text NOT NULL DEFAULT 'MIT',
  source_reference text,
  source_file_sha256 text NOT NULL,
  row_count integer NOT NULL,
  status text NOT NULL,
  validation_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  activated_at timestamptz,
  activated_by uuid,
  CONSTRAINT awcms_mini_idn_region_datasets_dataset_code_key UNIQUE (dataset_code),
  CONSTRAINT awcms_mini_idn_region_datasets_row_count_check CHECK (row_count >= 0),
  -- Lifecycle values implied by the epic's own issue bodies: #660 ("Leave
  -- dataset as `validated`, not `active`" after a committed import), #661
  -- ("Only one dataset can be active at a time" / rollback reactivates the
  -- previously active dataset). `superseded` covers a dataset that WAS
  -- active and was replaced by activation of a different dataset or rolled
  -- back away from (its `activated_at`/`activated_by` stay populated as a
  -- historical record — see the "Dataset source metadata remains immutable
  -- after activation" note in #661 — only `status` changes).
  -- `rejected` is reserved for a future issue that may want to persist a
  -- failed-validation import attempt for audit purposes. This list is NOT
  -- necessarily final: if #659/#660/#661 need an additional lifecycle
  -- state this schema-only issue did not anticipate, a later migration can
  -- `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT ...` — schema
  -- migrations are additive/sequential in this repo (see
  -- `.claude/skills/awcms-mini-new-migration/SKILL.md`), never edited in
  -- place once released.
  CONSTRAINT awcms_mini_idn_region_datasets_status_check
    CHECK (status IN ('validated', 'active', 'superseded', 'rejected'))
);

COMMENT ON TABLE awcms_mini_idn_region_datasets IS
  'Global reference data (Issue #657, epic #654) — one row per imported Indonesia administrative region dataset version (cahyadsn/wilayah, MIT). NOT tenant-scoped, no RLS — see sql/054''s header and scripts/security-readiness.ts''s RLS_FREE_TABLES.';

-- Enforces "only one dataset can be active at a time" (#657/#661 acceptance
-- criteria) at the database level: a partial unique index over the rows
-- matching `status = 'active'`, indexed on the `status` column itself. Every
-- indexed row necessarily has the same value ('active'), so a second such
-- row would collide on that value and be rejected by Postgres as a unique
-- violation — i.e. at most one row can ever satisfy `status = 'active'`.
-- This also doubles as the fastest possible index for the #662 lookup API's
-- default "active dataset" query (`WHERE status = 'active'`).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_idn_region_datasets_single_active
  ON awcms_mini_idn_region_datasets (status)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS awcms_mini_idn_admin_regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES awcms_mini_idn_region_datasets (id),
  code text NOT NULL,
  code_compact text,
  parent_code text,
  level smallint NOT NULL,
  region_type text NOT NULL,
  local_term text,
  official_name text NOT NULL,
  normalized_name text NOT NULL,
  full_path_code text,
  full_path_name text,
  province_code text,
  regency_code text,
  district_code text,
  village_code text,
  source_row_hash text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Four-tier Indonesia administrative hierarchy (province / regency-or-city
  -- / district / village-or-urban-village), matching the terminology
  -- `src/modules/idn-admin-regions/README.md` already uses. `level` mirrors
  -- `region_type` numerically (1=province .. 4=village) purely so ORDER
  -- BY/comparisons don't need a CASE over `region_type` — both are kept in
  -- sync by whatever writes the row (#658's normalizer / #660's importer),
  -- not by a generated column, since the mapping is a stable domain fact,
  -- not a computation over other columns in this same row.
  CONSTRAINT awcms_mini_idn_admin_regions_level_check CHECK (level BETWEEN 1 AND 4),
  CONSTRAINT awcms_mini_idn_admin_regions_region_type_check
    CHECK (region_type IN ('province', 'regency', 'district', 'village'))
);

COMMENT ON TABLE awcms_mini_idn_admin_regions IS
  'Global reference data (Issue #657, epic #654) — normalized Indonesia administrative regions for one dataset version. NOT tenant-scoped, no RLS — see sql/054''s header and scripts/security-readiness.ts''s RLS_FREE_TABLES. No personal data.';

-- Acceptance criteria: "Unique index exists on (dataset_id, code)" — a
-- region's code is only guaranteed unique WITHIN its own dataset (two
-- different dataset versions may legitimately both contain the same
-- upstream code).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_idn_admin_regions_dataset_code_key
  ON awcms_mini_idn_admin_regions (dataset_id, code);

-- Acceptance criteria: "Parent lookup index exists on (dataset_id,
-- parent_code)" — the child-lookup path a hierarchy browser (#662 lookup
-- API, #663 admin UI) needs ("list children of this region").
CREATE INDEX IF NOT EXISTS awcms_mini_idn_admin_regions_dataset_parent_idx
  ON awcms_mini_idn_admin_regions (dataset_id, parent_code);

-- Acceptance criteria: "Search index exists for normalized_name" — scoped by
-- dataset_id first since every real query is dataset-scoped (#662's own
-- documented default: query the active dataset unless a specific
-- dataset/version is requested via `dataset=<code>`).
CREATE INDEX IF NOT EXISTS awcms_mini_idn_admin_regions_dataset_name_idx
  ON awcms_mini_idn_admin_regions (dataset_id, normalized_name);

-- Least-privilege: see this file's header. Nothing reads or writes these
-- tables yet, so `awcms_mini_app` ends this migration with zero grants —
-- future issues add exactly the grant their own new code path needs.
REVOKE ALL ON awcms_mini_idn_region_datasets FROM awcms_mini_app;
REVOKE ALL ON awcms_mini_idn_admin_regions FROM awcms_mini_app;
