-- Issue #537 (epic #536, blog_content) — foundation schema for the first
-- domain module registered directly in this base repo (ADR-0009). Seven
-- tables per doc issue #537 §Database Tables: posts, pages, terms
-- (categories/tags), post-term relations, append-only revisions, redirects,
-- and per-tenant settings. Admin/public API, search population, and
-- scheduled-publishing automation are out of scope here (Issues #538-#543) —
-- this only lays down the tenant-isolated, least-privilege schema they build
-- on.
--
-- No explicit `GRANT` statements are needed for `awcms_mini_app` on the new
-- tables below: migration 013 already set
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE,
-- DELETE ON TABLES TO awcms_mini_app`, so every table the owning role creates
-- from here on is auto-granted (same reasoning migration 025 relied on for
-- module management's new tables).

CREATE TABLE IF NOT EXISTS awcms_mini_blog_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  author_tenant_user_id uuid NOT NULL,
  title text NOT NULL,
  slug text NOT NULL,
  excerpt text,
  content_json jsonb NOT NULL,
  content_text text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  visibility text NOT NULL DEFAULT 'public',
  featured_media_id uuid,
  seo_title text,
  meta_description text,
  canonical_url text,
  locale text NOT NULL DEFAULT 'id',
  published_at timestamptz,
  scheduled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  version integer NOT NULL DEFAULT 1,
  search_vector tsvector,
  CONSTRAINT awcms_mini_blog_posts_status_check
    CHECK (status IN ('draft', 'review', 'scheduled', 'published', 'archived')),
  CONSTRAINT awcms_mini_blog_posts_visibility_check
    CHECK (visibility IN ('public', 'private', 'unlisted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_blog_posts_slug_dedup
  ON awcms_mini_blog_posts (tenant_id, locale, slug)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_blog_posts_tenant_status_published_idx
  ON awcms_mini_blog_posts (tenant_id, status, published_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_blog_posts_tenant_author_idx
  ON awcms_mini_blog_posts (tenant_id, author_tenant_user_id);

CREATE INDEX IF NOT EXISTS awcms_mini_blog_posts_tenant_deleted_idx
  ON awcms_mini_blog_posts (tenant_id, deleted_at);

-- Populated by Issue #539's search-vector maintenance (trigger or
-- application-managed) — the column/index exist now so #539 needs no new
-- migration just to add the index.
CREATE INDEX IF NOT EXISTS awcms_mini_blog_posts_search_vector_idx
  ON awcms_mini_blog_posts USING GIN (search_vector);

ALTER TABLE awcms_mini_blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_blog_posts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_blog_posts_tenant_isolation
  ON awcms_mini_blog_posts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Same core shape as posts, plus page_type/parent_page_id/menu_order (doc
-- issue #537 §Pages).
CREATE TABLE IF NOT EXISTS awcms_mini_blog_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  author_tenant_user_id uuid NOT NULL,
  title text NOT NULL,
  slug text NOT NULL,
  excerpt text,
  content_json jsonb NOT NULL,
  content_text text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  visibility text NOT NULL DEFAULT 'public',
  featured_media_id uuid,
  seo_title text,
  meta_description text,
  canonical_url text,
  locale text NOT NULL DEFAULT 'id',
  published_at timestamptz,
  scheduled_at timestamptz,
  page_type text NOT NULL DEFAULT 'standard',
  parent_page_id uuid REFERENCES awcms_mini_blog_pages (id),
  menu_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restored_at timestamptz,
  restored_by uuid,
  version integer NOT NULL DEFAULT 1,
  search_vector tsvector,
  CONSTRAINT awcms_mini_blog_pages_status_check
    CHECK (status IN ('draft', 'review', 'scheduled', 'published', 'archived')),
  CONSTRAINT awcms_mini_blog_pages_visibility_check
    CHECK (visibility IN ('public', 'private', 'unlisted')),
  CONSTRAINT awcms_mini_blog_pages_page_type_check
    CHECK (page_type IN ('standard', 'landing', 'legal', 'system'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_blog_pages_slug_dedup
  ON awcms_mini_blog_pages (tenant_id, locale, slug)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_blog_pages_tenant_status_published_idx
  ON awcms_mini_blog_pages (tenant_id, status, published_at DESC);

CREATE INDEX IF NOT EXISTS awcms_mini_blog_pages_tenant_author_idx
  ON awcms_mini_blog_pages (tenant_id, author_tenant_user_id);

CREATE INDEX IF NOT EXISTS awcms_mini_blog_pages_tenant_deleted_idx
  ON awcms_mini_blog_pages (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_mini_blog_pages_parent_idx
  ON awcms_mini_blog_pages (parent_page_id);

CREATE INDEX IF NOT EXISTS awcms_mini_blog_pages_search_vector_idx
  ON awcms_mini_blog_pages USING GIN (search_vector);

ALTER TABLE awcms_mini_blog_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_blog_pages FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_blog_pages_tenant_isolation
  ON awcms_mini_blog_pages
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Categories and tags (doc issue #537 §Terms). A tag must never carry a
-- parent_id (also re-checked at the application layer by
-- `domain/taxonomy-policy.ts`'s `validateTermParent` before this constraint
-- is ever reached).
CREATE TABLE IF NOT EXISTS awcms_mini_blog_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  taxonomy_type text NOT NULL,
  parent_id uuid REFERENCES awcms_mini_blog_terms (id),
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_blog_terms_taxonomy_type_check
    CHECK (taxonomy_type IN ('category', 'tag')),
  CONSTRAINT awcms_mini_blog_terms_tag_no_parent_check
    CHECK (taxonomy_type <> 'tag' OR parent_id IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_blog_terms_slug_dedup
  ON awcms_mini_blog_terms (tenant_id, taxonomy_type, slug)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_blog_terms_tenant_idx
  ON awcms_mini_blog_terms (tenant_id, taxonomy_type);

CREATE INDEX IF NOT EXISTS awcms_mini_blog_terms_parent_idx
  ON awcms_mini_blog_terms (parent_id);

ALTER TABLE awcms_mini_blog_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_blog_terms FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_blog_terms_tenant_isolation
  ON awcms_mini_blog_terms
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Post <-> term assignment (doc issue #537 §Post-term relations). Join
-- table still carries its own `tenant_id` (not just derivable through the
-- FKs) so RLS can isolate it directly, same convention as every other
-- tenant-scoped table in this base.
CREATE TABLE IF NOT EXISTS awcms_mini_blog_post_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  post_id uuid NOT NULL REFERENCES awcms_mini_blog_posts (id),
  term_id uuid NOT NULL REFERENCES awcms_mini_blog_terms (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_blog_post_terms_unique UNIQUE (post_id, term_id)
);

CREATE INDEX IF NOT EXISTS awcms_mini_blog_post_terms_tenant_idx
  ON awcms_mini_blog_post_terms (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_mini_blog_post_terms_term_idx
  ON awcms_mini_blog_post_terms (term_id);

ALTER TABLE awcms_mini_blog_post_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_blog_post_terms FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_blog_post_terms_tenant_isolation
  ON awcms_mini_blog_post_terms
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Append-only revision history (doc issue #537 §Revisions: "Revisions are
-- append-only... Restoring a revision must create a new revision"). Same
-- convention as `awcms_mini_workflow_decisions`/`awcms_mini_audit_events`: a
-- single tenant-isolation policy, no UPDATE ever issued by application code.
CREATE TABLE IF NOT EXISTS awcms_mini_blog_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  revision_number integer NOT NULL,
  title text NOT NULL,
  content_json jsonb NOT NULL,
  content_text text NOT NULL,
  excerpt text,
  seo_title text,
  meta_description text,
  canonical_url text,
  status text NOT NULL,
  change_note text,
  created_by_tenant_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_blog_revisions_resource_type_check
    CHECK (resource_type IN ('post', 'page')),
  CONSTRAINT awcms_mini_blog_revisions_unique
    UNIQUE (tenant_id, resource_type, resource_id, revision_number)
);

CREATE INDEX IF NOT EXISTS awcms_mini_blog_revisions_resource_idx
  ON awcms_mini_blog_revisions (tenant_id, resource_type, resource_id, revision_number DESC);

ALTER TABLE awcms_mini_blog_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_blog_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_blog_revisions_tenant_isolation
  ON awcms_mini_blog_revisions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- URL redirects (e.g. slug changes) — soft-deletable like other
-- master/config data (AGENTS.md rule 13), not append-only.
CREATE TABLE IF NOT EXISTS awcms_mini_blog_redirects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  from_path text NOT NULL,
  to_path text NOT NULL,
  status_code integer NOT NULL DEFAULT 301,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_blog_redirects_status_code_check
    CHECK (status_code IN (301, 302, 307, 308))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_blog_redirects_from_path_dedup
  ON awcms_mini_blog_redirects (tenant_id, from_path)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_blog_redirects_tenant_idx
  ON awcms_mini_blog_redirects (tenant_id);

ALTER TABLE awcms_mini_blog_redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_blog_redirects FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_blog_redirects_tenant_isolation
  ON awcms_mini_blog_redirects
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- One row per tenant, same shape/convention as `awcms_mini_tenant_settings`
-- (migration 002): `tenant_id` itself is the primary key, no separate soft
-- delete (a settings row is configured, not deleted).
CREATE TABLE IF NOT EXISTS awcms_mini_blog_settings (
  tenant_id uuid PRIMARY KEY REFERENCES awcms_mini_tenants (id),
  default_locale text NOT NULL DEFAULT 'id',
  default_visibility text NOT NULL DEFAULT 'public',
  posts_per_page integer NOT NULL DEFAULT 10,
  seo_default_title text,
  seo_default_description text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_mini_blog_settings_default_visibility_check
    CHECK (default_visibility IN ('public', 'private', 'unlisted'))
);

ALTER TABLE awcms_mini_blog_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_blog_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_blog_settings_tenant_isolation
  ON awcms_mini_blog_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
