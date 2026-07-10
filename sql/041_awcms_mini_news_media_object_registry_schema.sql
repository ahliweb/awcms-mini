-- Issue #633 (epic `news_portal` #631-#642/#649) — tenant-scoped, R2-only
-- media object metadata registry for news images (used by `blog_content`
-- featured/gallery images, homepage sections, ads, SEO share images, and
-- video thumbnails once #636-#640 wire them up). Metadata only — no binary
-- column exists or will ever be added here (architecture doc §3.2/§5); the
-- actual image bytes live in Cloudflare R2 (bucket configured via
-- `NEWS_MEDIA_R2_*`, Issue #632, `news-portal/domain/news-media-r2-config.ts`
-- — deliberately separate bucket/credentials from `sync-storage`'s own
-- `R2_*`, "Keputusan kunci #1" in the epic skill).
--
-- ## Naming — a deliberate deviation from Issue #633's own body text
--
-- Issue #633's body suggests table name `awcms_mini_media_objects`. This
-- migration uses `awcms_mini_news_media_objects` instead, matching the name
-- ALREADY chosen by `docs/awcms-mini/news-portal/full-online-r2-architecture.md`
-- §5 ("rencana untuk Issue #633" — written during Issue #631, before this
-- issue started). Reasons this is treated as a real conflict, not just a
-- cosmetic rename:
--   1. The architecture doc is the epic's binding source of truth (per the
--      epic skill's own header: "dokumen itu (bukan skill) adalah sumber
--      kebenaran arsitektur") and it already named this table for this
--      specific issue — the issue body's suggestion is a generic strawman,
--      not a decision made with the doc in view.
--   2. A generic `awcms_mini_media_objects` name reads as "the app's one
--      general media library" — but this table is deliberately NOT that: it
--      is hard-constrained to `storage_driver = 'cloudflare_r2'` and to the
--      full-online, opt-in-only news portal preset (Issue #632). Naming it
--      generically would misrepresent scope and collide semantically with
--      any future *actually*-general media system for unrelated features
--      (avatars, product images, etc.) that might reasonably want the
--      unprefixed name for itself.
-- Same reconciliation pattern Issue #632 already used three times for env
-- var/preset naming (see `.claude/skills/awcms-mini-news-portal/SKILL.md`
-- §632, Rekonsiliasi #1-#3) — documented here rather than silently deviating.
--
-- ## Status enum — elaboration of architecture doc §5's simpler model
--
-- Doc §5's conceptual model (written before this issue) sketches a 4-state
-- `pending|confirmed|orphaned|deleted`. This migration instead uses the
-- 7-state enum from Issue #633's own body
-- (`pending_upload|uploaded|verified|attached|orphaned|deleted|failed`) —
-- a strict elaboration, not a contradiction: `pending_upload` = doc's
-- `pending`; `uploaded`+`verified` split doc's single `confirmed` into "R2
-- PUT succeeded" vs "MIME/checksum/dimensions verified server-side"
-- (matching the two-step Jalur A flow in doc §7 — Issue #634 will need both
-- states to represent the gap between R2 HEAD success and full content
-- verification); `attached` is new (media object is actually referenced by
-- an owning resource, not just sitting verified-but-unused); `orphaned` and
-- `deleted` are unchanged; `failed` is new (upload/verification failed,
-- distinct from soft-deleted). Soft delete (`deleted_at`) is intentionally
-- ORTHOGONAL to this `status` column (same as `awcms_mini_blog_posts`):
-- deleting/restoring a row never rewrites `status`, it only toggles
-- `deleted_at`/`deleted_by`/`delete_reason`/`restored_at`/`restored_by`.
--
-- ## `owner_resource_type`/`owner_resource_id` — generic polymorphic
-- reference, no FK
--
-- Deliberately a loose `(text, uuid)` pair with no foreign key, following
-- the same PATTERN (not identical column types) as the existing
-- polymorphic-reference idiom used by
-- `awcms_mini_audit_events.resource_type`/`resource_id` (migration 011) and
-- `awcms_mini_workflow_instances.resource_type`/`resource_id` (migration
-- 012, both `resource_id text`) — NOT a hard FK to `awcms_mini_blog_posts`
-- or any other specific table. `owner_resource_id` here is `uuid` (every
-- resource type this registry serves today already has a uuid primary
-- key) and `owner_resource_type` is CHECK-constrained to a fixed enum
-- (neither of which the two precedent tables do) — a stricter variant of
-- the same loose-FK idiom, not a byte-for-byte match. This lets one
-- registry serve every consumer the objective lists
-- (blog post/page, homepage section, gallery item, ad, video thumbnail, SEO
-- image) without a table-specific FK per consumer, and without this
-- migration depending on `blog_content`'s schema at all (`news_portal`'s own
-- `module.ts` deliberately has no hard dependency on `blog_content` — see
-- the epic skill's "Kenapa modul baru... dependencies HANYA..." section).
-- Both columns are NULL until a row reaches `status='attached'` (enforced
-- by the check constraint below) — a `pending_upload`/`uploaded`/`verified`
-- object is valid, real media not yet bound to any specific resource.
--
-- ## RLS
--
-- `ENABLE`+`FORCE` + the standard `tenant_isolation` policy, same pattern as
-- every tenant-scoped table since migration 013. No explicit `GRANT` needed
-- for `awcms_mini_app` — migration 013's `ALTER DEFAULT PRIVILEGES` already
-- covers it.
--
-- ## `module_key` — plain text, no FK, deliberately restricted to
-- 'news_portal' for now
--
-- Same shape as `awcms_mini_audit_events.module_key` (plain `text NOT NULL`,
-- no `REFERENCES awcms_mini_modules`) — NOT the FK pattern
-- `module_management`'s own catalog tables use for their `module_key`
-- columns (those describe module *state*; this describes which module owns
-- a media registry row, a different concern). Restricted via `CHECK` to the
-- single value `'news_portal'` because that is the only real caller today;
-- widen the check (not a schema rename) if a second, unrelated module ever
-- needs to reuse this exact registry shape.

CREATE TABLE IF NOT EXISTS awcms_mini_news_media_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  module_key text NOT NULL DEFAULT 'news_portal',
  owner_resource_type text,
  owner_resource_id uuid,
  storage_driver text NOT NULL DEFAULT 'cloudflare_r2',
  bucket_name text NOT NULL,
  object_key text NOT NULL,
  original_filename text,
  public_url text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint,
  checksum_sha256 text,
  width integer,
  height integer,
  alt_text text,
  caption text,
  status text NOT NULL DEFAULT 'pending_upload',
  created_by_tenant_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  CONSTRAINT awcms_mini_news_media_objects_module_key_check
    CHECK (module_key = 'news_portal'),
  CONSTRAINT awcms_mini_news_media_objects_storage_driver_check
    CHECK (storage_driver = 'cloudflare_r2'),
  -- Schema-level defense in depth for doc §6's object key convention
  -- (`news-media/{tenantId}/{yyyy}/{mm}/{uuid}.{ext}`) — the application
  -- layer (`news-media-object-key.ts`) is the primary enforcement point
  -- (it's what actually GENERATES the key), but a CHECK constraint means a
  -- row that somehow bypassed that helper (a future direct INSERT, a bug in
  -- a later issue) is rejected by Postgres itself rather than silently
  -- accepted. References this row's own `tenant_id` column, so the prefix
  -- is verified per-row, not just a fixed literal.
  CONSTRAINT awcms_mini_news_media_objects_object_key_format_check
    CHECK (object_key ~ ('^news-media/' || tenant_id::text || '/[0-9]{4}/[0-9]{2}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.[a-z0-9]+$')),
  CONSTRAINT awcms_mini_news_media_objects_status_check
    CHECK (status IN (
      'pending_upload', 'uploaded', 'verified', 'attached',
      'orphaned', 'deleted', 'failed'
    )),
  CONSTRAINT awcms_mini_news_media_objects_owner_resource_type_check
    CHECK (owner_resource_type IS NULL OR owner_resource_type IN (
      'blog_post', 'blog_page', 'homepage_section', 'gallery_item',
      'ad', 'video_thumbnail', 'seo_image'
    )),
  -- Attach requires both owner columns; anything else must leave them NULL.
  CONSTRAINT awcms_mini_news_media_objects_owner_consistency_check
    CHECK (
      (status = 'attached'
        AND owner_resource_type IS NOT NULL AND owner_resource_id IS NOT NULL)
      OR
      (status <> 'attached'
        AND owner_resource_type IS NULL AND owner_resource_id IS NULL)
    ),
  CONSTRAINT awcms_mini_news_media_objects_size_bytes_check
    CHECK (size_bytes IS NULL OR size_bytes > 0),
  CONSTRAINT awcms_mini_news_media_objects_width_check
    CHECK (width IS NULL OR width > 0),
  CONSTRAINT awcms_mini_news_media_objects_height_check
    CHECK (height IS NULL OR height > 0)
);

-- Object key already embeds tenant_id + a random UUID (doc §6), so it can
-- never collide across tenants in practice — the unique index is still
-- scoped `(tenant_id, object_key)` rather than bare `object_key`, matching
-- this repo's tenant-scoped-uniqueness convention everywhere else (e.g.
-- `awcms_mini_blog_posts_slug_dedup`).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_news_media_objects_tenant_key_dedup
  ON awcms_mini_news_media_objects (tenant_id, object_key);

CREATE INDEX IF NOT EXISTS idx_awcms_mini_news_media_objects_tenant
  ON awcms_mini_news_media_objects (tenant_id);

CREATE INDEX IF NOT EXISTS idx_awcms_mini_news_media_objects_tenant_created
  ON awcms_mini_news_media_objects (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_awcms_mini_news_media_objects_active
  ON awcms_mini_news_media_objects (tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_awcms_mini_news_media_objects_tenant_status
  ON awcms_mini_news_media_objects (tenant_id, status)
  WHERE deleted_at IS NULL;

-- Owner lookup ("which media objects are attached to this blog post?").
CREATE INDEX IF NOT EXISTS idx_awcms_mini_news_media_objects_owner
  ON awcms_mini_news_media_objects (tenant_id, owner_resource_type, owner_resource_id)
  WHERE deleted_at IS NULL AND owner_resource_type IS NOT NULL;

ALTER TABLE awcms_mini_news_media_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_news_media_objects FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_news_media_objects_tenant_isolation
  ON awcms_mini_news_media_objects
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
