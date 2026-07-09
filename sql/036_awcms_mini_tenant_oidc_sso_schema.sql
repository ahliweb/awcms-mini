-- Generic tenant OIDC SSO provider (Issue #591, epic: full-online auth
-- hardening #587-#593). Active only when the #587 gate is active AND
-- AUTH_SSO_ENABLED=true (`isSsoRequired`, `src/lib/auth/sso-config.ts`) —
-- these tables exist on every deployment (migrations always run), but stay
-- entirely empty/unused on local/offline/LAN deployments that never enable
-- the feature.
--
-- This issue generalizes Issue #590's Google-specific login into a
-- tenant-configurable OIDC provider model. It deliberately does NOT touch
-- `awcms_mini_identity_provider_accounts` or `awcms_mini_oidc_auth_requests`
-- (migration 035) — both were already designed generic: `provider` is a
-- free-text column there specifically "since Issue #591 ... will add more
-- provider values on top of `google` without needing a schema change here"
-- (035's own comment). Generic SSO reuses both tables verbatim, storing
-- `provider = <provider_key>` for a tenant-configured provider exactly as
-- `google-oidc.ts` stores `provider = 'google'` — this migration only adds
-- the two NEW tables the generic flow needs on top of that reused pair.
--
-- `awcms_mini_auth_providers` — one tenant-configured OIDC identity
-- provider (Okta, Azure AD, Keycloak, etc.). `provider_key` is the stable
-- slug used everywhere else this issue touches `awcms_mini_identity_provider_accounts.provider`
-- /`awcms_mini_oidc_auth_requests.provider`, and in the `/api/v1/auth/sso/{providerKey}/...`
-- URL path itself. Client secret is NEVER stored plaintext (issue's own
-- acceptance criterion): either `client_secret_ciphertext` (AES-256-GCM via
-- `AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY`, same at-rest encryption pattern as
-- Issue #589's `mfa-secret-crypto.ts`) or `client_secret_env_var` (the NAME
-- of an environment variable holding the secret, resolved at OAuth-call
-- time, never persisted) — exactly one of the two must be set, enforced by
-- the CHECK constraint below. `allowed_email_domains` (jsonb array, not a
-- native Postgres array — this repo's established convention for flexible
-- list-shaped columns, see `awcms_mini_module_settings.settings` and doc 04
-- "JSONB per-locale") is this provider's own auto-link-by-email allow-list,
-- mirroring Issue #590's `AUTH_GOOGLE_ALLOWED_DOMAINS` env var but per
-- tenant/provider instead of deployment-wide. Soft delete
-- (`deleted_at`/`deleted_by`/`delete_reason`) since a provider config is
-- tenant master data, not an append-only/posted record.
CREATE TABLE IF NOT EXISTS awcms_mini_auth_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  provider_key text NOT NULL,
  provider_type text NOT NULL DEFAULT 'oidc',
  display_name text NOT NULL,
  issuer_url text NOT NULL,
  client_id text NOT NULL,
  client_secret_ciphertext text,
  client_secret_env_var text,
  scopes text NOT NULL DEFAULT 'openid email profile',
  allowed_email_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_auth_providers_provider_type_check
    CHECK (provider_type IN ('oidc')),
  CONSTRAINT awcms_mini_auth_providers_provider_key_format_check
    CHECK (provider_key ~ '^[a-z0-9][a-z0-9_-]*$'),
  CONSTRAINT awcms_mini_auth_providers_secret_source_check
    CHECK (
      (client_secret_ciphertext IS NOT NULL AND client_secret_env_var IS NULL)
      OR (client_secret_ciphertext IS NULL AND client_secret_env_var IS NOT NULL)
    )
);

-- `provider_key` doubles as the `/api/v1/auth/sso/{providerKey}/...` path
-- segment and the value stored into the reused
-- `awcms_mini_identity_provider_accounts.provider`/
-- `awcms_mini_oidc_auth_requests.provider` columns — must be unique per
-- tenant among non-deleted providers (an archived provider's slug may be
-- reused, same convention as `awcms_mini_tenant_domains`' hostname dedup).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_auth_providers_key_active
  ON awcms_mini_auth_providers (tenant_id, provider_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_awcms_mini_auth_providers_tenant
  ON awcms_mini_auth_providers (tenant_id);
CREATE INDEX IF NOT EXISTS idx_awcms_mini_auth_providers_tenant_created
  ON awcms_mini_auth_providers (tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_mini_auth_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_auth_providers FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_auth_providers_tenant_isolation
  ON awcms_mini_auth_providers
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `awcms_mini_tenant_auth_policies` — one row per tenant (unique index
-- below), same "one row per tenant, upsert, no `id` in the URL" shape as
-- `awcms_mini_blog_settings` (migration 029). `break_glass_identity_ids`
-- (jsonb array of identity ids) is the safe model the issue asks for:
-- "sso_required=true cannot be enabled unless at least one break-glass
-- local owner remains available" is enforced in the application layer
-- (`tenant-auth-policy.ts`'s `saveTenantAuthPolicy`) at the point the
-- policy is SAVED, not merely at login time — a DB CHECK constraint alone
-- cannot express "at least one of these ids is a currently-active identity
-- with an active tenant_user membership," which requires cross-table
-- validation. `mfa_required` is added now (default `false`, never read by
-- any endpoint yet) purely for forward compatibility with Issue #589's
-- per-identity MFA opt-in model, per this issue's own scope note — a
-- future issue may centralize "require MFA tenant-wide" here instead of
-- leaving it purely opt-in per identity; wiring that enforcement is
-- explicitly out of scope for #591.
CREATE TABLE IF NOT EXISTS awcms_mini_tenant_auth_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  password_login_enabled boolean NOT NULL DEFAULT true,
  sso_enabled boolean NOT NULL DEFAULT false,
  sso_required boolean NOT NULL DEFAULT false,
  auto_link_verified_email boolean NOT NULL DEFAULT false,
  allowed_email_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  break_glass_identity_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  mfa_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT awcms_mini_tenant_auth_policies_login_method_check
    CHECK (password_login_enabled OR sso_enabled)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_tenant_auth_policies_tenant_key
  ON awcms_mini_tenant_auth_policies (tenant_id);

ALTER TABLE awcms_mini_tenant_auth_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_tenant_auth_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_tenant_auth_policies_tenant_isolation
  ON awcms_mini_tenant_auth_policies
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
