-- Google OIDC login (Issue #590, epic: full-online auth hardening #587-#593).
-- Active only when the #587 gate is active AND AUTH_GOOGLE_LOGIN_ENABLED=true
-- (`isGoogleLoginRequired`, `src/lib/auth/google-oidc-config.ts`) — these two
-- tables exist on every deployment (migrations always run), but stay
-- entirely empty/unused on local/offline/LAN deployments that never enable
-- the feature.
--
-- `awcms_mini_identity_provider_accounts` — links an identity to an external
-- OIDC provider's stable subject (`sub`), NEVER by email (issue's own
-- security note: "Account linking by provider subject (sub), not email").
-- `provider` is a free column (not yet constrained to a fixed set) since
-- Issue #591 (generic tenant OIDC SSO) will add more provider values on top
-- of `google` without needing a schema change here.
CREATE TABLE IF NOT EXISTS awcms_mini_identity_provider_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  identity_id uuid NOT NULL REFERENCES awcms_mini_identities (id),
  provider text NOT NULL,
  provider_subject text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The lookup path at callback time (WHERE tenant_id = ? AND provider = ?
-- AND provider_subject = ?) and the invariant "one provider account per
-- (tenant, provider, subject)" share this single unique index.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_identity_provider_accounts_subject_key
  ON awcms_mini_identity_provider_accounts (tenant_id, provider, provider_subject);

-- An identity may only link ONE account per provider (re-linking the same
-- provider replaces, never duplicates) — the unlink/link application logic
-- also enforces this, this index is the DB-level backstop.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_identity_provider_accounts_identity_key
  ON awcms_mini_identity_provider_accounts (tenant_id, identity_id, provider);

ALTER TABLE awcms_mini_identity_provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_identity_provider_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_identity_provider_accounts_tenant_isolation
  ON awcms_mini_identity_provider_accounts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `awcms_mini_oidc_auth_requests` — the ephemeral bridge across the OAuth
-- redirect round-trip (browser leaves this app, goes to Google, comes back)
-- — same "ephemeral row, hash-only token, TTL, single-use" shape as
-- `awcms_mini_mfa_challenges` (Issue #589). `state_hash` is the CSRF/replay
-- defense (issue's own acceptance criterion: "OAuth/OIDC callback rejects
-- invalid or missing state"); `nonce` is stored PLAINTEXT (not hashed, unlike
-- `state`) because it must be compared against the value literally embedded
-- in the returned ID token's `nonce` claim — it is not a bearer credential
-- itself (possessing it grants nothing without also completing the OAuth
-- code exchange), unlike `state`/session/reset tokens which ARE bearer
-- credentials and are therefore always hashed at rest. `purpose` distinguishes
-- an unauthenticated login attempt from an authenticated user linking a
-- second (Google) login method to their existing identity; `identity_id` is
-- only ever set for `purpose = 'link'` (the identity requesting the link,
-- captured server-side at `start` time so `callback`/`link` never has to
-- trust a client-supplied identity id).
CREATE TABLE IF NOT EXISTS awcms_mini_oidc_auth_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  provider text NOT NULL,
  state_hash text NOT NULL,
  nonce text NOT NULL,
  purpose text NOT NULL,
  identity_id uuid REFERENCES awcms_mini_identities (id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_oidc_auth_requests_purpose_check
    CHECK (purpose IN ('login', 'link')),
  CONSTRAINT awcms_mini_oidc_auth_requests_link_has_identity_check
    CHECK (purpose <> 'link' OR identity_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_oidc_auth_requests_hash_key
  ON awcms_mini_oidc_auth_requests (state_hash);

ALTER TABLE awcms_mini_oidc_auth_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_oidc_auth_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_oidc_auth_requests_tenant_isolation
  ON awcms_mini_oidc_auth_requests
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
