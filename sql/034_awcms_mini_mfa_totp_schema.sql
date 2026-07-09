-- Full-online MFA/TOTP login challenge (Issue #589, epic: full-online auth
-- hardening #587-#593). Active only when the #587 gate is active AND
-- AUTH_MFA_ENABLED=true (`isMfaRequired`, `src/lib/auth/mfa-config.ts`) —
-- these three tables exist on every deployment (migrations always run), but
-- stay entirely empty/unused on local/offline/LAN deployments that never
-- enable the feature.
--
-- `awcms_mini_identity_mfa_factors` — one row per identity per factor type.
-- `secret_ciphertext` is the TOTP shared secret encrypted at rest
-- (`src/lib/auth/mfa-secret-crypto.ts`, AES-256-GCM keyed by
-- `AUTH_MFA_SECRET_ENCRYPTION_KEY`) — never stored plaintext, never
-- returned again after enrollment start. `status`: `pending` (enrolled,
-- not yet confirmed with a valid code — unusable for login) ->
-- `active` (confirmed, used at login) -> `disabled` (turned off; kept as a
-- row, not deleted, for audit/history — mirrors why `awcms_mini_identities`
-- itself uses a `status` column rather than deleting rows). Partial unique
-- index below allows only one non-disabled factor per identity at a time
-- (this issue only implements TOTP; the column still models `factor_type`
-- for a possible future WebAuthn factor type without a schema change, but
-- WebAuthn itself is explicitly out of scope here).
CREATE TABLE IF NOT EXISTS awcms_mini_identity_mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  identity_id uuid NOT NULL REFERENCES awcms_mini_identities (id),
  factor_type text NOT NULL DEFAULT 'totp',
  secret_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  -- Replay prevention: the highest TOTP time-step counter ever accepted for
  -- this factor. A verification is only accepted if its matched step is
  -- strictly greater than this value, so the exact same code (or an older
  -- one within the verification window) can never be replayed even before
  -- it naturally expires.
  last_used_step bigint NOT NULL DEFAULT -1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  disabled_at timestamptz,
  CONSTRAINT awcms_mini_identity_mfa_factors_factor_type_check
    CHECK (factor_type IN ('totp')),
  CONSTRAINT awcms_mini_identity_mfa_factors_status_check
    CHECK (status IN ('pending', 'active', 'disabled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_identity_mfa_factors_active_key
  ON awcms_mini_identity_mfa_factors (tenant_id, identity_id, factor_type)
  WHERE status <> 'disabled';

ALTER TABLE awcms_mini_identity_mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_identity_mfa_factors FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_identity_mfa_factors_tenant_isolation
  ON awcms_mini_identity_mfa_factors
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `awcms_mini_identity_mfa_recovery_codes` — single-use backup codes shown
-- once at enrollment-verify time (and again on regenerate); only `code_hash`
-- (sha256, same construction as `session-token.ts`/`password-reset-token.ts`)
-- is ever persisted. `ON DELETE CASCADE` on `factor_id`: disabling/replacing
-- a factor makes its recovery codes moot, and the application layer deletes
-- them explicitly on disable/regenerate anyway — the cascade is a backstop,
-- not the primary cleanup path.
CREATE TABLE IF NOT EXISTS awcms_mini_identity_mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  identity_id uuid NOT NULL REFERENCES awcms_mini_identities (id),
  factor_id uuid NOT NULL REFERENCES awcms_mini_identity_mfa_factors (id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_identity_mfa_recovery_codes_hash_key
  ON awcms_mini_identity_mfa_recovery_codes (code_hash);

CREATE INDEX IF NOT EXISTS awcms_mini_identity_mfa_recovery_codes_factor_idx
  ON awcms_mini_identity_mfa_recovery_codes (tenant_id, factor_id)
  WHERE used_at IS NULL;

ALTER TABLE awcms_mini_identity_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_identity_mfa_recovery_codes FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_identity_mfa_recovery_codes_tenant_isolation
  ON awcms_mini_identity_mfa_recovery_codes
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `awcms_mini_mfa_challenges` — the ephemeral bridge between "password
-- verified" and "session created" for an identity with an active MFA
-- factor (`login.ts`): password-valid + MFA-active issues a challenge row
-- (no session yet) whose raw token is returned to the client as
-- `mfaChallengeToken`; `POST /auth/mfa/totp/verify` looks it up by
-- `challenge_token_hash`, and only creates the real session once the
-- submitted TOTP code (or recovery code) is valid. `failed_attempts` bounds
-- brute-force guessing against one challenge independently of the
-- source-scoped rate limit at the endpoint (`AUTH_MFA_RATE_LIMIT_MAX`) —
-- a distributed attacker rotating source IPs against the same challenge is
-- still capped by this column.
CREATE TABLE IF NOT EXISTS awcms_mini_mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  identity_id uuid NOT NULL REFERENCES awcms_mini_identities (id),
  challenge_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_mfa_challenges_failed_attempts_check
    CHECK (failed_attempts >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_mfa_challenges_hash_key
  ON awcms_mini_mfa_challenges (challenge_token_hash);

CREATE INDEX IF NOT EXISTS awcms_mini_mfa_challenges_identity_idx
  ON awcms_mini_mfa_challenges (tenant_id, identity_id)
  WHERE consumed_at IS NULL;

ALTER TABLE awcms_mini_mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_mfa_challenges FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_mfa_challenges_tenant_isolation
  ON awcms_mini_mfa_challenges
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
