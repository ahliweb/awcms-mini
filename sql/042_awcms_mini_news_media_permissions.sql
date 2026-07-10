-- Issue #634 (epic `news_portal` #631-#642/#649) — permission catalog seed
-- for the news media registry, wiring up the constants Issue #633 already
-- froze in `src/modules/news-portal/domain/news-media-permissions.ts`
-- (`NEWS_MEDIA_PERMISSIONS`) and this issue's own `module.ts` `permissions`
-- array declaration. Same shape as `sql/038_awcms_mini_visitor_analytics_permissions.sql`
-- — extends the global ABAC permission catalog only, no roles/access-
-- assignments wired here (every EXISTING tenant's `owner` role does not
-- retroactively gain these — same limitation every prior permission-seed
-- migration in this repo has; only tenants created AFTER this migration
-- runs get them automatically via `POST /api/v1/setup/initialize`'s
-- `INSERT INTO awcms_mini_role_permissions ... SELECT ... FROM
-- awcms_mini_permissions`).
--
-- `cancel` is new relative to #633's original eight-action set — see
-- `news-media-permissions.ts`'s own comment on why "cancel an own
-- not-yet-uploaded session" is a distinct, lower-risk permission from
-- `delete`.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('news_portal', 'media', 'create', 'Create a pending news media object / start a presigned upload session'),
  ('news_portal', 'media', 'read', 'Read news media object metadata'),
  ('news_portal', 'media', 'verify', 'Finalize/verify an uploaded news media object'),
  ('news_portal', 'media', 'attach', 'Attach a verified news media object to an owning resource'),
  ('news_portal', 'media', 'detach', 'Detach a news media object from its owning resource'),
  ('news_portal', 'media', 'delete', 'Soft delete news media object metadata'),
  ('news_portal', 'media', 'restore', 'Restore a soft-deleted news media object'),
  ('news_portal', 'media', 'purge', 'Hard purge an already soft-deleted news media object'),
  ('news_portal', 'media', 'cancel', 'Cancel one''s own not-yet-uploaded news media upload session')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
