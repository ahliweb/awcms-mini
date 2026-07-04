-- 002 — Tenant, office, central profile, identity (doc 04, base layer).
-- Tanpa BEGIN/COMMIT — runner membungkus dalam transaction.

-- ============ Tenant Admin ============

-- Root multi-tenant: tabel ini sendiri TIDAK tenant-scoped.
CREATE TABLE IF NOT EXISTS awcms_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_code text NOT NULL UNIQUE,
  tenant_name text NOT NULL,
  legal_name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'suspended')),
  default_locale text NOT NULL DEFAULT 'id'
    CHECK (default_locale IN ('id', 'en', 'ms', 'ar')),
  default_theme text NOT NULL DEFAULT 'system'
    CHECK (default_theme IN ('light', 'dark', 'system')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS awcms_offices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  office_code text NOT NULL,
  office_name text NOT NULL,
  office_type text NOT NULL DEFAULT 'head_office'
    CHECK (office_type IN ('head_office', 'branch', 'store', 'warehouse', 'other')),
  parent_office_id uuid REFERENCES awcms_offices (id),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  UNIQUE (tenant_id, office_code)
);

CREATE INDEX IF NOT EXISTS idx_awcms_offices_tenant_type
  ON awcms_offices (tenant_id, office_type);
CREATE INDEX IF NOT EXISTS idx_awcms_offices_parent
  ON awcms_offices (parent_office_id);

-- Preferensi per tenant (presedensi konfigurasi doc 18).
CREATE TABLE IF NOT EXISTS awcms_tenant_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  setting_key text NOT NULL,
  setting_value jsonb NOT NULL DEFAULT 'null'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE (tenant_id, setting_key)
);

-- ============ Profile Identity (central profile) ============

CREATE TABLE IF NOT EXISTS awcms_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  profile_type text NOT NULL
    CHECK (profile_type IN ('user', 'customer', 'supplier', 'contact', 'other')),
  display_name text NOT NULL,
  legal_name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'merged')),
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified')),
  risk_level text NOT NULL DEFAULT 'normal'
    CHECK (risk_level IN ('normal', 'watch', 'high')),
  merged_into_profile_id uuid REFERENCES awcms_profiles (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);

CREATE INDEX IF NOT EXISTS idx_awcms_profiles_tenant_type
  ON awcms_profiles (tenant_id, profile_type);
CREATE INDEX IF NOT EXISTS idx_awcms_profiles_merged_into
  ON awcms_profiles (merged_into_profile_id);

-- Identifier sensitif: simpan hash (lookup/dedup) + masked (tampilan).
-- Nilai mentah TIDAK pernah keluar response/log/audit (doc 04).
CREATE TABLE IF NOT EXISTS awcms_profile_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  profile_id uuid NOT NULL REFERENCES awcms_profiles (id),
  identifier_type text NOT NULL
    CHECK (identifier_type IN ('email', 'phone', 'whatsapp', 'npwp', 'nik', 'other')),
  value_hash text NOT NULL,
  masked_value text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, identifier_type, value_hash)
);

CREATE INDEX IF NOT EXISTS idx_awcms_profile_identifiers_profile
  ON awcms_profile_identifiers (profile_id);

CREATE TABLE IF NOT EXISTS awcms_profile_entity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  profile_id uuid NOT NULL REFERENCES awcms_profiles (id),
  entity_module text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, entity_module, entity_type, entity_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_awcms_profile_entity_links_profile
  ON awcms_profile_entity_links (profile_id);

CREATE TABLE IF NOT EXISTS awcms_profile_merge_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  source_profile_id uuid NOT NULL REFERENCES awcms_profiles (id),
  target_profile_id uuid NOT NULL REFERENCES awcms_profiles (id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
  reason text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  decided_at timestamptz,
  decided_by uuid,
  CHECK (source_profile_id <> target_profile_id)
);

CREATE INDEX IF NOT EXISTS idx_awcms_profile_merge_requests_tenant_status
  ON awcms_profile_merge_requests (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_awcms_profile_merge_requests_source
  ON awcms_profile_merge_requests (source_profile_id);
CREATE INDEX IF NOT EXISTS idx_awcms_profile_merge_requests_target
  ON awcms_profile_merge_requests (target_profile_id);

-- ============ Identity & tenant membership ============

-- Login identity global (bisa menjadi anggota lebih dari satu tenant).
-- password_hash tidak pernah keluar response/API/log.
CREATE TABLE IF NOT EXISTS awcms_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_identifier text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'locked')),
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS awcms_tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  identity_id uuid NOT NULL REFERENCES awcms_identities (id),
  profile_id uuid REFERENCES awcms_profiles (id),
  default_office_id uuid REFERENCES awcms_offices (id),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  UNIQUE (tenant_id, identity_id)
);

CREATE INDEX IF NOT EXISTS idx_awcms_tenant_users_identity
  ON awcms_tenant_users (identity_id);
CREATE INDEX IF NOT EXISTS idx_awcms_tenant_users_profile
  ON awcms_tenant_users (profile_id);
CREATE INDEX IF NOT EXISTS idx_awcms_tenant_users_office
  ON awcms_tenant_users (default_office_id);

-- ============ RLS tenant isolation (doc 04/16) ============
-- awcms_tenants & awcms_identities global — tidak diberi policy tenant.

ALTER TABLE awcms_offices ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_offices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_offices_tenant_isolation ON awcms_offices;
CREATE POLICY awcms_offices_tenant_isolation ON awcms_offices
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE awcms_tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_tenant_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_tenant_settings_tenant_isolation ON awcms_tenant_settings;
CREATE POLICY awcms_tenant_settings_tenant_isolation ON awcms_tenant_settings
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE awcms_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_profiles_tenant_isolation ON awcms_profiles;
CREATE POLICY awcms_profiles_tenant_isolation ON awcms_profiles
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE awcms_profile_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_profile_identifiers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_profile_identifiers_tenant_isolation ON awcms_profile_identifiers;
CREATE POLICY awcms_profile_identifiers_tenant_isolation ON awcms_profile_identifiers
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE awcms_profile_entity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_profile_entity_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_profile_entity_links_tenant_isolation ON awcms_profile_entity_links;
CREATE POLICY awcms_profile_entity_links_tenant_isolation ON awcms_profile_entity_links
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE awcms_profile_merge_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_profile_merge_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_profile_merge_requests_tenant_isolation ON awcms_profile_merge_requests;
CREATE POLICY awcms_profile_merge_requests_tenant_isolation ON awcms_profile_merge_requests
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE awcms_tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_tenant_users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS awcms_tenant_users_tenant_isolation ON awcms_tenant_users;
CREATE POLICY awcms_tenant_users_tenant_isolation ON awcms_tenant_users
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
