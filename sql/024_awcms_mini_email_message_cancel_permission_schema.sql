-- Issue #499 (epic #492, follows #493-#498) — email observability/security/
-- production-readiness. No new tables: adds the one permission needed by
-- the new admin "cancel a still-queued message" endpoint
-- (`POST /api/v1/email/messages/{id}/cancel`).
--
-- This closes a real gap left dangling since migration 020: the
-- `awcms_mini_email_messages_status_check` constraint already allows a
-- `'cancelled'` status value, but no code path ever wrote it — there was no
-- way to stop an accidental bulk send (#497) once enqueued. `message.read`
-- (also seeded in 020, also unused until now) is consumed by the new
-- `GET /api/v1/email/messages` diagnostics list in this same issue.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('email', 'message', 'cancel', 'Cancel a still-queued (queued/retry_wait) email message before it sends')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
