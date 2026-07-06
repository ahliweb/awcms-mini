-- Issue #496 (epic #492, follows email module Issues #493-#495/#498) —
-- secure email-based password reset. First real caller that actually
-- enqueues a row into `awcms_mini_email_messages` (`sql/020`'s own comment
-- already anticipated this: "the reset token itself is hashed at rest in
-- its own auth table (Issue #496), never persisted here").
--
-- `awcms_mini_password_reset_tokens` mirrors `awcms_mini_sessions`'s shape
-- (`sql/004`) — `token_hash` (never the raw token), `expires_at`, plus
-- `used_at` for single-use enforcement (sessions don't need this; a
-- session is valid until it expires or is explicitly revoked, but a reset
-- token must never be usable twice even before it expires). FORCE RLS
-- applied inline (post-013 convention every table since has followed;
-- `awcms_mini_sessions` itself predates 013 and was force'd retroactively
-- there).
CREATE TABLE IF NOT EXISTS awcms_mini_password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  identity_id uuid NOT NULL REFERENCES awcms_mini_identities (id),
  token_hash text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Lookup path at reset-completion time: WHERE token_hash = ?. Unique
-- because a hash collision would otherwise let one raw token match two
-- rows (astronomically unlikely with sha256 of 32 random bytes, but the
-- constraint costs nothing and documents the invariant).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_password_reset_tokens_hash_key
  ON awcms_mini_password_reset_tokens (token_hash);

-- Supersede-prior-tokens path at request time: WHERE tenant_id = ? AND
-- identity_id = ? AND used_at IS NULL.
CREATE INDEX IF NOT EXISTS awcms_mini_password_reset_tokens_identity_idx
  ON awcms_mini_password_reset_tokens (tenant_id, identity_id)
  WHERE used_at IS NULL;

ALTER TABLE awcms_mini_password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_password_reset_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_password_reset_tokens_tenant_isolation
  ON awcms_mini_password_reset_tokens
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
