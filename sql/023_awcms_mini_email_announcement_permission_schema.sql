-- Issue #497 (epic #492, follows #493-#496/#498) — announcement/notification
-- email workflows. No new tables: targeting/enqueue logic reads existing
-- tables (`awcms_mini_tenant_users`, `awcms_mini_access_assignments`,
-- `awcms_mini_identities`, `awcms_mini_profiles`, `awcms_mini_email_
-- suppression_list`) and writes existing `awcms_mini_email_messages`
-- (`sql/020`) — one row per resolved recipient, sharing a correlation_id,
-- per the "no fan-out shape" decision already documented there.
--
-- Two permissions, not one — issue's own acceptance criteria: "Bulk
-- announcement should require stronger permission than ordinary
-- notification enqueue." `email.notification.create` gates sending to an
-- explicit, caller-chosen list of users (bounded, lower risk);
-- `email.announcement.create` is REQUIRED IN ADDITION when targeting a
-- role or the whole tenant (unbounded, higher risk) — a role granted only
-- `notification.create` can message specific people it already knows
-- about, but cannot blast every user in a role/tenant.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('email', 'notification', 'create', 'Enqueue an email notification to an explicit set of users'),
  ('email', 'announcement', 'create', 'Enqueue a bulk email announcement to a role or the whole tenant')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
