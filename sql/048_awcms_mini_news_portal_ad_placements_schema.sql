-- Issue #638 (epic news_portal) — R2-only advertisement placement presets.
--
-- `blog_content` already ships a generic advertisement system
-- (`awcms_mini_blog_ads`/`awcms_mini_blog_ad_placements`, migration 029,
-- Issue #542) whose `image_url` is a free-form absolute http(s) URL — fine
-- for the general-purpose blog module, but incompatible with this epic's
-- non-negotiable "editorial images must be a verified R2 media object"
-- principle (Keputusan kunci #8, `.claude/skills/awcms-mini-news-portal/
-- SKILL.md`). Rather than retrofit R2-only validation onto the existing
-- generic ads table (which many non-full-online-R2 tenants legitimately
-- keep using with plain external image URLs), this migration adds a
-- SEPARATE, narrower table — same "brand-new table, no legacy shape to stay
-- compatible with" reasoning migration 044 (#637's homepage sections) used
-- for the identical dilemma with `awcms_mini_blog_ads`'s `image_url`. Every
-- row here is R2-only BY CONSTRUCTION (`media_object_id` is a real FK into
-- the media registry, there is no free-text image URL column at all), so
-- there is no need for a full-online-R2-mode runtime gate the way
-- `blog_content`'s Issue #636 gate needed one for its own already-existing
-- free-URL fields.
--
-- `placement_key` is a fixed preset vocabulary (the twelve values below,
-- copied verbatim from the issue body) — deliberately NOT a separate lookup
-- table: `recommended_size`/`allowed_media_types`/`max_items` per placement
-- are static, code-level metadata (`news-portal/domain/ad-placement-
-- policy.ts`'s `AD_PLACEMENT_PRESETS`), same "whitelist lives in code, DB
-- only CHECK-constrains the key itself" convention `homepage-section-
-- policy.ts`'s `HomepageSectionType` established for migration 044. Unlike
-- `sectionType` there, `placement_key` is NOT immutable after creation here
-- — every placement preset shares the exact same row shape (media
-- reference + link + schedule + rotation knobs), so there is no
-- config-shape hazard in letting an admin reassign an existing ad row to a
-- different placement via PATCH (contrast with homepage sections, where
-- each `sectionType` has a structurally different `config_json`).
--
-- `max_items` is enforced at RENDER-selection time only (how many ads
-- `ad-placement-rotation.ts`'s `selectAdsForRotation` picks from the
-- eligible-active pool for one placement) — NOT as a write-time cap on how
-- many rows an admin may configure for a given `placement_key` bucket. An
-- admin may legitimately configure more candidate ads than `max_items`
-- (e.g. ten `header_banner` ads scheduled across different date ranges);
-- rotation selects the visible subset at read time.
-- Residual/latent risk (documented, not exploitable today): `media_object_id`
-- is a REAL foreign key (unlike the polymorphic, FK-less `owner_resource_id`
-- on `awcms_mini_news_media_objects` itself, migration 041) -- a deliberate
-- choice since this table lives inside the SAME module as the registry it
-- references, and gets a stronger DB-level guarantee for it. Consequence: a
-- future `purgeNewsMediaObject` (hard DELETE, application function already
-- exists, Issue #633) call against a media object still referenced by a row
-- here will fail with a raw Postgres foreign-key-violation error, not a
-- graceful application-level 409/422 -- there is NO route calling
-- `purgeNewsMediaObject`/`softDeleteNewsMediaObject` yet as of this issue
-- (verified: `src/pages/api/v1/media/news-images/` only has upload-session
-- create/finalize/cancel), so this cannot be triggered via any existing
-- endpoint today. Whichever issue adds a real purge endpoint MUST catch this
-- FK violation (or, better, pre-check for referencing rows here) and return
-- a clear error rather than letting it surface as an unhandled 500 -- same
-- "documented residual, not a regression, wait for the endpoint that makes
-- it live" pattern Issue #633's own attach/retention residual risks use.
CREATE TABLE IF NOT EXISTS awcms_mini_news_portal_ad_placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  placement_key text NOT NULL,
  name text NOT NULL,
  media_object_id uuid NOT NULL REFERENCES awcms_mini_news_media_objects (id),
  link_url text,
  rotation_mode text NOT NULL DEFAULT 'latest',
  priority integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_news_portal_ad_placements_placement_key_check
    CHECK (placement_key IN (
      'header_banner', 'below_headline', 'homepage_middle', 'homepage_bottom',
      'article_top', 'article_middle', 'article_bottom',
      'sidebar_top', 'sidebar_middle', 'sidebar_bottom',
      'category_archive_top', 'search_result_top'
    )),
  CONSTRAINT awcms_mini_news_portal_ad_placements_rotation_mode_check
    CHECK (rotation_mode IN ('latest', 'priority', 'random_safe', 'weighted')),
  CONSTRAINT awcms_mini_news_portal_ad_placements_priority_check
    CHECK (priority >= 0),
  CONSTRAINT awcms_mini_news_portal_ad_placements_schedule_check
    CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

-- Supports both the admin listing (filter/group by placement) and the
-- render-time "active ads for this placement" query — same "index the
-- tenant + the column render queries actually filter on" convention
-- migration 044's `..._tenant_order_idx` uses.
CREATE INDEX IF NOT EXISTS awcms_mini_news_portal_ad_placements_tenant_key_idx
  ON awcms_mini_news_portal_ad_placements (tenant_id, placement_key)
  WHERE deleted_at IS NULL;

-- FK lookup index (doc 10 convention: every foreign key gets an index).
CREATE INDEX IF NOT EXISTS awcms_mini_news_portal_ad_placements_media_object_id_idx
  ON awcms_mini_news_portal_ad_placements (media_object_id);

ALTER TABLE awcms_mini_news_portal_ad_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_news_portal_ad_placements FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_news_portal_ad_placements_tenant_isolation
  ON awcms_mini_news_portal_ad_placements
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Permission catalog seed — same "read" + "configure" action pair every
-- other admin-configured-master-data resource in this epic uses
-- (`homepage_sections` migration 044, `blog_content`'s ads/menus/widgets
-- migration 030).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('news_portal', 'ad_placements', 'read', 'Read news portal advertisement placement configuration'),
  ('news_portal', 'ad_placements', 'configure', 'Create, update, enable/disable, or delete news portal advertisement placements')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
