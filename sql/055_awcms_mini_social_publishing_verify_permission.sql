-- Issue #646 (epic `social_publishing` #643-#647) — the Telegram channel
-- adapter is the first real provider adapter to implement
-- `SocialProviderAdapter.verifyCredentials` (Issue #643's foundation
-- interface already anticipated "a manual 'verify connection' admin
-- action" per its own doc comment). Adds exactly one permission row for the
-- new `POST /api/v1/social-publishing/accounts/{id}/verify` endpoint —
-- reuses the `verify` action already present in
-- `identity-access/domain/access-control.ts`'s `AccessAction` union (added
-- for `tenant_domain.domains.verify` in migration 032) rather than adding a
-- new action to that union. Not added to `HIGH_RISK_ACTIONS` — same
-- reasoning as `tenant_domain.domains.verify`: it only flips
-- `last_verified_at`/`scopes_json` based on a live provider check, never
-- touches `token_reference` or any other credential-bearing field (that
-- stays behind `accounts.connect`/`.disconnect`).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('social_publishing', 'accounts', 'verify', 'Verify a connected social publishing account/channel can be posted to before enabling auto-posting')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
