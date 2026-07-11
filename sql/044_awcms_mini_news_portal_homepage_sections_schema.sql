-- Issue #637 (epic news_portal) — configurable editorial homepage section
-- composer for the canonical `/news` route. Six section types, each backed
-- entirely by EXISTING public-safe data (`blog_content` posts + the R2 media
-- registry from Issue #633) — no new content-authoring surface, no raw HTML.
-- `video_block`/`ad_slot`/`custom_widget_block` from the issue's suggested
-- list are deliberately NOT included here: `video_block` needs Issue #639's
-- (not yet built) R2 thumbnail-required video type; `ad_slot` needs Issue
-- #638's (not yet built) R2-only ad image validation — `awcms_mini_blog_ads`
-- today stores a free-form `image_url`, which would violate this issue's own
-- "all images must come from a verified R2 media object" acceptance
-- criterion; `custom_widget_block` is explicitly out of scope per the issue
-- body ("Arbitrary HTML widgets"). A `static_page_block` referencing
-- `awcms_mini_blog_pages` was also considered and dropped — there is no
-- existing public page-detail route/visibility-tested query for pages
-- anywhere in this repo yet (only admin-facing `blog-page-directory.ts`),
-- and building one is its own decision, not a side effect of this issue.
CREATE TABLE IF NOT EXISTS awcms_mini_news_portal_homepage_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  section_key text NOT NULL,
  section_type text NOT NULL,
  title text,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  is_enabled boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_news_portal_homepage_sections_type_check
    CHECK (section_type IN (
      'headline', 'latest_posts', 'featured_posts', 'editor_picks',
      'category_grid', 'gallery_block'
    )),
  CONSTRAINT awcms_mini_news_portal_homepage_sections_schedule_check
    CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_news_portal_homepage_sections_tenant_key_dedup
  ON awcms_mini_news_portal_homepage_sections (tenant_id, section_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_news_portal_homepage_sections_tenant_order_idx
  ON awcms_mini_news_portal_homepage_sections (tenant_id, sort_order)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_mini_news_portal_homepage_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_news_portal_homepage_sections FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_news_portal_homepage_sections_tenant_isolation
  ON awcms_mini_news_portal_homepage_sections
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Permission catalog seed, same "configure" (create/update/reorder/delete)
-- + "read" action pair `blog_content`'s ads/menus/widgets already use
-- (`sql/030_awcms_mini_blog_content_presentation_permissions.sql`) — this
-- table has no separate "reorder" action, per-section `sort_order` is just
-- another field on the same `configure`-guarded update.
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('news_portal', 'homepage_sections', 'read', 'Read editorial homepage section configuration'),
  ('news_portal', 'homepage_sections', 'configure', 'Create, update, reorder, enable/disable, or delete editorial homepage sections')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
