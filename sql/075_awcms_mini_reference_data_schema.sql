-- Issue #750 (epic #738 platform-evolution, Wave 3, ADR-0021) —
-- `reference_data` module schema: effective-dated, localized value sets
-- and codes with provenance, deprecation/supersession, a validated
-- import pipeline, and a tenant-override/extension layer that never
-- mutates the global baseline.
--
-- Six tables. FOUR are GLOBAL (no `tenant_id`, no RLS) — identical for
-- every tenant by design, same reviewed-exempt reasoning as
-- `awcms_mini_permissions`/`awcms_mini_modules`/`awcms_mini_idn_admin_
-- regions` (doc 04 §RLS standard, ADR-0021 §8): `awcms_mini_reference_
-- value_sets`, `awcms_mini_reference_codes`, `awcms_mini_reference_code_
-- translations`, `awcms_mini_reference_imports`. Registered explicitly in
-- `scripts/security-readiness.ts`'s `RLS_FREE_TABLES` and
-- `ALLOWED_GLOBAL_TABLE_GRANTS` (this migration). TWO are TENANT-SCOPED
-- (`ENABLE`+`FORCE ROW LEVEL SECURITY`, predicate always and only
-- `tenant_id`, ADR-0013 §2/§9): `awcms_mini_reference_tenant_codes`,
-- `awcms_mini_reference_tenant_code_translations` — a tenant override/
-- extension NEVER writes to a global baseline table; the two layers are
-- physically separate tables, not a shared row with a tenant filter.
--
-- 1. `awcms_mini_reference_value_sets` — a stable, named catalog (e.g.
--    "currency", "unit_of_measure", "fiscal_calendar"). `scope`
--    distinguishes `module_contributed` (declared by a module's own
--    `module.ts` `referenceData.contributesValueSets`, synced by
--    `application/contribution-sync.ts`, `managed_by_descriptor = true`
--    rows only) from `platform_curated` (created directly via this
--    module's own API by an operator with the right permission).
--    `override_policy` governs what a tenant may do in the tenant-scoped
--    tables below: `none` (baseline only), `tenant_extend` (tenant may add
--    NEW codes, never override an existing one), `tenant_override` (tenant
--    may override attributes of an EXISTING baseline code for itself,
--    never add new ones), `tenant_extend_and_override` (both). Enforced
--    server-side in `application/tenant-code-directory.ts` — never trusted
--    from request input (issue #750 security requirement).
-- 2. `awcms_mini_reference_imports` — one row per dry-run/commit import
--    batch for a value set's GLOBAL baseline codes. `payload`/`checksum`
--    are the exact validated dry-run content; `commit` re-validates the
--    checksum AND re-runs full validation inside the SAME transaction as
--    the write (`application/import-service.ts`) — never trusts the
--    earlier dry-run alone. Referenced by `awcms_mini_reference_codes.
--    import_batch_id` below for provenance + bounded rollback.
-- 3. `awcms_mini_reference_codes` — one row per code within a value set
--    (e.g. "IDR" in "currency"). Never hard-deleted once referenced by a
--    tenant override/extension (`awcms_mini_reference_tenant_codes.
--    base_code_id`) — deprecate/supersede only (issue #750: "A code
--    already referenced by business data is never silently deleted or
--    repurposed in place"). `managed_by_descriptor = true` rows are
--    upserted ONLY by `contribution-sync.ts` (never by the manual CRUD
--    API) so a module's own declared codes and an operator's manually
--    added codes never collide.
-- 4. `awcms_mini_reference_code_translations` — localized label/
--    description per code per locale (doc 04 §Tabel translasi terpisah
--    convention), GLOBAL like its parent.
-- 5. `awcms_mini_reference_tenant_codes` — tenant-scoped override
--    (`base_code_id` set, mirrors an existing baseline code's `code` for
--    this tenant) OR extension (`base_code_id` NULL, a wholly new
--    tenant-defined code) — resolution precedence (baseline vs this row)
--    is a pure read-side merge (`domain/resolution.ts`), never a write to
--    table 3.
-- 6. `awcms_mini_reference_tenant_code_translations` — localized label/
--    description per tenant code per locale, tenant-scoped like its
--    parent.
--
-- `legal_entity_id`/`organization_unit_id`-style cross-table composite FKs
-- are deliberately not used anywhere here (same documented precedent
-- `sql/063`/`sql/061` established) — `value_set_id`/`base_code_id`/
-- `import_batch_id` are ordinary foreign keys, re-validated for tenant
-- ownership (where applicable) at the APPLICATION layer on every write.

CREATE TABLE IF NOT EXISTS awcms_mini_reference_value_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  owner_module text NOT NULL,
  name text NOT NULL,
  description text,
  scope text NOT NULL,
  override_policy text NOT NULL,
  validation_schema jsonb,
  managed_by_descriptor boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  deprecated_at timestamptz,
  deprecated_by uuid,
  deprecate_reason text,
  restored_at timestamptz,
  restored_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_reference_value_sets_key_key UNIQUE (key),
  CONSTRAINT awcms_mini_reference_value_sets_key_format_check
    CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT awcms_mini_reference_value_sets_scope_check
    CHECK (scope IN ('module_contributed', 'platform_curated')),
  CONSTRAINT awcms_mini_reference_value_sets_override_policy_check
    CHECK (override_policy IN ('none', 'tenant_extend', 'tenant_override', 'tenant_extend_and_override')),
  CONSTRAINT awcms_mini_reference_value_sets_status_check
    CHECK (status IN ('active', 'deprecated')),
  CONSTRAINT awcms_mini_reference_value_sets_validation_schema_size_check
    CHECK (validation_schema IS NULL OR length(validation_schema::text) <= 8000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_reference_value_sets_status_idx
  ON awcms_mini_reference_value_sets (status);

CREATE INDEX IF NOT EXISTS awcms_mini_reference_value_sets_owner_module_idx
  ON awcms_mini_reference_value_sets (owner_module);

CREATE TABLE IF NOT EXISTS awcms_mini_reference_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  value_set_id uuid NOT NULL REFERENCES awcms_mini_reference_value_sets (id),
  status text NOT NULL DEFAULT 'validated',
  source_provenance text,
  payload jsonb NOT NULL,
  checksum text NOT NULL,
  diff_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  rejection_reason text,
  committed_at timestamptz,
  committed_by uuid,
  rolled_back_at timestamptz,
  rolled_back_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT awcms_mini_reference_imports_status_check
    CHECK (status IN ('validated', 'rejected', 'committed', 'rolled_back')),
  CONSTRAINT awcms_mini_reference_imports_payload_size_check
    CHECK (length(payload::text) <= 2000000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_reference_imports_value_set_idx
  ON awcms_mini_reference_imports (value_set_id, created_at DESC);

CREATE TABLE IF NOT EXISTS awcms_mini_reference_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  value_set_id uuid NOT NULL REFERENCES awcms_mini_reference_value_sets (id),
  code text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  deprecated_at timestamptz,
  deprecated_by uuid,
  deprecate_reason text,
  restored_at timestamptz,
  restored_by uuid,
  superseded_by_code_id uuid REFERENCES awcms_mini_reference_codes (id),
  provenance text NOT NULL DEFAULT 'manual',
  managed_by_descriptor boolean NOT NULL DEFAULT false,
  import_batch_id uuid REFERENCES awcms_mini_reference_imports (id),
  checksum text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_reference_codes_value_set_code_key UNIQUE (value_set_id, code),
  CONSTRAINT awcms_mini_reference_codes_code_format_check
    CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$'),
  CONSTRAINT awcms_mini_reference_codes_valid_range_check
    CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT awcms_mini_reference_codes_provenance_check
    CHECK (provenance IN ('manual', 'module', 'import', 'seed')),
  CONSTRAINT awcms_mini_reference_codes_metadata_size_check
    CHECK (length(metadata::text) <= 4000),
  CONSTRAINT awcms_mini_reference_codes_not_self_superseding_check
    CHECK (superseded_by_code_id IS NULL OR superseded_by_code_id <> id)
);

CREATE INDEX IF NOT EXISTS awcms_mini_reference_codes_value_set_idx
  ON awcms_mini_reference_codes (value_set_id, deprecated_at);

CREATE INDEX IF NOT EXISTS awcms_mini_reference_codes_value_set_active_idx
  ON awcms_mini_reference_codes (value_set_id, code)
  WHERE deprecated_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_reference_codes_import_batch_idx
  ON awcms_mini_reference_codes (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS awcms_mini_reference_code_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id uuid NOT NULL REFERENCES awcms_mini_reference_codes (id) ON DELETE CASCADE,
  locale text NOT NULL,
  label text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_reference_code_translations_code_locale_key UNIQUE (code_id, locale),
  CONSTRAINT awcms_mini_reference_code_translations_locale_format_check
    CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  CONSTRAINT awcms_mini_reference_code_translations_label_length_check
    CHECK (length(label) BETWEEN 1 AND 300)
);

CREATE INDEX IF NOT EXISTS awcms_mini_reference_code_translations_code_idx
  ON awcms_mini_reference_code_translations (code_id);

CREATE TABLE IF NOT EXISTS awcms_mini_reference_tenant_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  value_set_id uuid NOT NULL REFERENCES awcms_mini_reference_value_sets (id),
  base_code_id uuid REFERENCES awcms_mini_reference_codes (id),
  code text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  deprecated_at timestamptz,
  deprecated_by uuid,
  deprecate_reason text,
  restored_at timestamptz,
  restored_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT awcms_mini_reference_tenant_codes_tenant_value_set_code_key
    UNIQUE (tenant_id, value_set_id, code),
  CONSTRAINT awcms_mini_reference_tenant_codes_code_format_check
    CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$'),
  CONSTRAINT awcms_mini_reference_tenant_codes_valid_range_check
    CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT awcms_mini_reference_tenant_codes_metadata_size_check
    CHECK (length(metadata::text) <= 4000)
);

CREATE INDEX IF NOT EXISTS awcms_mini_reference_tenant_codes_tenant_idx
  ON awcms_mini_reference_tenant_codes (tenant_id, value_set_id, deprecated_at);

CREATE INDEX IF NOT EXISTS awcms_mini_reference_tenant_codes_tenant_active_idx
  ON awcms_mini_reference_tenant_codes (tenant_id, value_set_id, code)
  WHERE deprecated_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_reference_tenant_codes_base_code_idx
  ON awcms_mini_reference_tenant_codes (base_code_id)
  WHERE base_code_id IS NOT NULL;

ALTER TABLE awcms_mini_reference_tenant_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_reference_tenant_codes FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_reference_tenant_codes_tenant_isolation
  ON awcms_mini_reference_tenant_codes
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_reference_tenant_code_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  tenant_code_id uuid NOT NULL REFERENCES awcms_mini_reference_tenant_codes (id) ON DELETE CASCADE,
  locale text NOT NULL,
  label text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_reference_tenant_code_translations_key
    UNIQUE (tenant_id, tenant_code_id, locale),
  CONSTRAINT awcms_mini_reference_tenant_code_translations_locale_format_check
    CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  CONSTRAINT awcms_mini_reference_tenant_code_translations_label_length_check
    CHECK (length(label) BETWEEN 1 AND 300)
);

CREATE INDEX IF NOT EXISTS awcms_mini_reference_tenant_code_translations_tenant_idx
  ON awcms_mini_reference_tenant_code_translations (tenant_id, tenant_code_id);

ALTER TABLE awcms_mini_reference_tenant_code_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_reference_tenant_code_translations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_reference_tenant_code_translations_tenant_isolation
  ON awcms_mini_reference_tenant_code_translations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
