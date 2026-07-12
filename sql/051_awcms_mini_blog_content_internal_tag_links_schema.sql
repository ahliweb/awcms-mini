-- Issue #641 (epic `news_portal`, but the feature lives in `blog_content` —
-- see `.claude/skills/awcms-mini-news-portal/SKILL.md` §641: "Tidak terkait
-- R2/media... implementor wajib tetap memakai whitelist renderer yang sama").
-- Automatic internal tag linking for post/news content.
--
-- Two independent additions:
--
-- 1. `awcms_mini_blog_posts.auto_internal_tag_links_disabled` — per-post
--    manual opt-out (acceptance criterion "Admin can disable automatic
--    links per post"). A plain column, not a new table, same convention as
--    every other per-post boolean flag on this table (`status`/
--    `visibility`).
--
-- 2. `awcms_mini_blog_internal_tag_link_settings` — per-tenant policy
--    override (tenant on/off switch, case-insensitive matching toggle,
--    disabled tag id list). Deliberately a DEDICATED table, same one-row-
--    per-tenant shape as `awcms_mini_blog_theme_settings` (migration 029)
--    — NOT folded into `awcms_mini_blog_settings.settings` jsonb the way
--    Issue #640's `contentQualityChecklistPolicy` was. Reason: `settings`
--    is a catch-all column `blog-settings-directory.ts`'s `upsertBlogSettings`
--    rewrites WHOLESALE from an explicit key allowlist (`extras` object) on
--    every `PATCH /api/v1/blog/settings` call — a key not included in that
--    allowlist would be SILENTLY DROPPED the next time an admin updates any
--    other blog setting, unless that file is also touched to know about the
--    new key. A dedicated table avoids this entanglement entirely, and
--    matches this issue's own suggested permission set
--    (`blog_content.internal_links.{read,configure,preview}`, distinct from
--    `blog_content.settings.*`) — separate storage for a separately-
--    permissioned concern, read/written ONLY through its own directory
--    (`internal-tag-link-settings-directory.ts`) and its own endpoints
--    (`/api/v1/blog/internal-tag-links/settings`), never through the
--    generic settings endpoint.
--
-- `disabled_tag_ids` is a plain `uuid[]` (no join table) — validated at the
-- application layer against `awcms_mini_blog_terms` (must exist, same
-- tenant, `taxonomy_type = 'tag'`, not soft-deleted) before every write,
-- same pattern `syncPostTermAssignments`/`countExistingTerms` already use
-- for `awcms_mini_blog_post_terms`. A stale id left behind after a tag is
-- later deleted is harmless (deleted tags are already excluded from the
-- render-time candidate list regardless of this array).

ALTER TABLE awcms_mini_blog_posts
  ADD COLUMN IF NOT EXISTS auto_internal_tag_links_disabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS awcms_mini_blog_internal_tag_link_settings (
  tenant_id uuid PRIMARY KEY REFERENCES awcms_mini_tenants (id),
  enabled boolean NOT NULL DEFAULT true,
  case_insensitive boolean NOT NULL DEFAULT false,
  disabled_tag_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE awcms_mini_blog_internal_tag_link_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_blog_internal_tag_link_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_blog_internal_tag_link_settings_tenant_isolation
  ON awcms_mini_blog_internal_tag_link_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
