-- Issue #539 (epic #536, blog_content) — "Search vector is maintained for
-- posts and pages." Migration 026 scaffolded `search_vector tsvector` as a
-- plain nullable column (populated by nothing) plus its GIN index; this
-- migration converts it to a `GENERATED ALWAYS ... STORED` column so
-- PostgreSQL itself keeps it in sync on every INSERT/UPDATE — no
-- application code, trigger function, or risk of insert/update drift.
-- Safe to DROP+ADD here (not ALTER COLUMN ... SET GENERATED, which only
-- applies to identity columns): the module is `status: "experimental"`
-- (Issue #537) with no real tenant data yet, and dropping a column drops
-- its index too, so the GIN index is re-created after.
--
-- `simple` text search config (language-agnostic stemming) is used rather
-- than a per-locale config (`english`/`indonesian`) — posts/pages mix
-- locales per tenant (`locale` column, doc issue #537) and PostgreSQL has
-- no built-in Indonesian config; `simple` gives consistent,
-- locale-agnostic tokenization now. Locale-aware ranking is a documented
-- future enhancement (see module README), not required by this issue's
-- acceptance criteria.
--
-- Weighted: title ('A', highest), excerpt ('B'), content_text ('C') — lets
-- `ts_rank`/`ts_rank_cd` rank a title match above a body match if a future
-- issue wants relevance ordering; this issue's admin search only orders by
-- `created_at DESC` (bounded/keyset, doc issue #539), so weighting has no
-- observable effect yet but costs nothing to set up correctly now.

ALTER TABLE awcms_mini_blog_posts DROP COLUMN IF EXISTS search_vector;

ALTER TABLE awcms_mini_blog_posts
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(excerpt, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(content_text, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS awcms_mini_blog_posts_search_vector_idx
  ON awcms_mini_blog_posts USING GIN (search_vector);

ALTER TABLE awcms_mini_blog_pages DROP COLUMN IF EXISTS search_vector;

ALTER TABLE awcms_mini_blog_pages
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(excerpt, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(content_text, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS awcms_mini_blog_pages_search_vector_idx
  ON awcms_mini_blog_pages USING GIN (search_vector);
