CREATE TABLE IF NOT EXISTS awcms_mini_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  profile_type text NOT NULL,
  display_name text NOT NULL,
  legal_name text,
  status text NOT NULL DEFAULT 'active',
  verification_status text NOT NULL DEFAULT 'unverified',
  risk_level text NOT NULL DEFAULT 'normal',
  merged_into_profile_id uuid REFERENCES awcms_mini_profiles (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  CONSTRAINT awcms_mini_profiles_profile_type_check
    CHECK (profile_type IN ('person', 'organization')),
  CONSTRAINT awcms_mini_profiles_status_check
    CHECK (status IN ('active', 'inactive', 'merged')),
  CONSTRAINT awcms_mini_profiles_verification_status_check
    CHECK (verification_status IN ('unverified', 'pending', 'verified')),
  CONSTRAINT awcms_mini_profiles_risk_level_check
    CHECK (risk_level IN ('low', 'normal', 'high'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_profiles_tenant_idx
  ON awcms_mini_profiles (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profiles_tenant_deleted_idx
  ON awcms_mini_profiles (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_mini_profiles_merged_into_idx
  ON awcms_mini_profiles (merged_into_profile_id);

ALTER TABLE awcms_mini_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_profiles_tenant_isolation
  ON awcms_mini_profiles
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_profile_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  profile_id uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  identifier_type text NOT NULL,
  normalized_value text NOT NULL,
  value_hash text NOT NULL,
  masked_value text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'unverified',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  CONSTRAINT awcms_mini_profile_identifiers_type_check
    CHECK (identifier_type IN (
      'email', 'phone', 'whatsapp', 'national_id', 'tax_id', 'external_code', 'other'
    )),
  CONSTRAINT awcms_mini_profile_identifiers_verification_status_check
    CHECK (verification_status IN ('unverified', 'pending', 'verified'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_profile_identifiers_dedup_key
  ON awcms_mini_profile_identifiers (tenant_id, identifier_type, value_hash)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_profile_identifiers_tenant_idx
  ON awcms_mini_profile_identifiers (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_identifiers_profile_idx
  ON awcms_mini_profile_identifiers (profile_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_identifiers_tenant_deleted_idx
  ON awcms_mini_profile_identifiers (tenant_id, deleted_at);

ALTER TABLE awcms_mini_profile_identifiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_profile_identifiers_tenant_isolation
  ON awcms_mini_profile_identifiers
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_profile_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  profile_id uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  profile_identifier_id uuid NOT NULL REFERENCES awcms_mini_profile_identifiers (id),
  channel_type text NOT NULL,
  is_opt_in boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  CONSTRAINT awcms_mini_profile_channels_channel_type_check
    CHECK (channel_type IN ('email', 'phone', 'whatsapp', 'other'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_channels_tenant_profile_idx
  ON awcms_mini_profile_channels (tenant_id, profile_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_channels_identifier_idx
  ON awcms_mini_profile_channels (profile_identifier_id);

ALTER TABLE awcms_mini_profile_channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_profile_channels_tenant_isolation
  ON awcms_mini_profile_channels
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_profile_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  profile_id uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  address_type text NOT NULL DEFAULT 'primary',
  address_line text,
  city text,
  province text,
  postal_code text,
  country_code text NOT NULL DEFAULT 'ID',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  CONSTRAINT awcms_mini_profile_addresses_address_type_check
    CHECK (address_type IN ('primary', 'billing', 'shipping', 'other'))
);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_addresses_tenant_profile_idx
  ON awcms_mini_profile_addresses (tenant_id, profile_id);

ALTER TABLE awcms_mini_profile_addresses ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_profile_addresses_tenant_isolation
  ON awcms_mini_profile_addresses
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_profile_entity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  profile_id uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  module_key text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  link_role text NOT NULL DEFAULT 'related',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_profile_entity_links_entity_key
  ON awcms_mini_profile_entity_links (tenant_id, module_key, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_entity_links_profile_idx
  ON awcms_mini_profile_entity_links (profile_id);

ALTER TABLE awcms_mini_profile_entity_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_profile_entity_links_tenant_isolation
  ON awcms_mini_profile_entity_links
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_profile_merge_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  source_profile_id uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  target_profile_id uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  status text NOT NULL DEFAULT 'pending',
  reason text,
  requested_by uuid,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_profile_merge_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
  CONSTRAINT awcms_mini_profile_merge_requests_source_ne_target_check
    CHECK (source_profile_id <> target_profile_id)
);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_merge_requests_tenant_idx
  ON awcms_mini_profile_merge_requests (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_merge_requests_source_idx
  ON awcms_mini_profile_merge_requests (source_profile_id);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_merge_requests_target_idx
  ON awcms_mini_profile_merge_requests (target_profile_id);

ALTER TABLE awcms_mini_profile_merge_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_profile_merge_requests_tenant_isolation
  ON awcms_mini_profile_merge_requests
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_mini_profile_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  profile_id uuid NOT NULL REFERENCES awcms_mini_profiles (id),
  actor_user_id uuid,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_profile_audit_logs_action_check
    CHECK (action IN (
      'created', 'updated', 'identifier_added', 'identifier_masked_reveal',
      'merge_requested', 'merge_decided', 'soft_deleted', 'restored'
    ))
);

CREATE INDEX IF NOT EXISTS awcms_mini_profile_audit_logs_tenant_profile_idx
  ON awcms_mini_profile_audit_logs (tenant_id, profile_id, created_at DESC);

ALTER TABLE awcms_mini_profile_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_profile_audit_logs_tenant_isolation
  ON awcms_mini_profile_audit_logs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
