/**
 * Public (anonymous) read queries for `awcms_mini_blog_posts` (Issue
 * #540). Every function here enforces tenant scoping via an explicit
 * `tenant_id = $1` predicate (the caller connects via the least-privilege
 * app role with RLS FORCE'd — same defense-in-depth convention as every
 * other tenant-scoped query in this repo) and a public-visibility
 * predicate — never the admin `blog-post-directory.ts` functions, which
 * assume an authenticated+authorized caller.
 *
 * Two distinct predicates, both from doc issue #540:
 * - **Listing** (index/category/tag archive/feed/sitemap):
 *   `status = 'published' AND visibility = 'public' AND deleted_at IS NULL
 *   AND published_at IS NOT NULL AND published_at <= now()` — the exact
 *   predicate #539's `searchPublicBlogContent` already implements.
 * - **Detail** (single post by slug): same, but `visibility IN ('public',
 *   'unlisted')` — doc issue #540's acceptance criteria explicitly scope
 *   the unlisted exclusion to "listing/search/feed/sitemap" only, meaning
 *   an unlisted post *is* reachable by direct link (that is the entire
 *   point of the "unlisted" tier existing separately from "private",
 *   which is never publicly reachable at all).
 */
export type PublicBlogPostDetail = {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  contentJson: Record<string, unknown>;
  contentText: string;
  seoTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  locale: string;
  publishedAt: Date;
};

type PublicBlogPostDetailRow = {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  content_json: Record<string, unknown>;
  content_text: string;
  seo_title: string | null;
  meta_description: string | null;
  canonical_url: string | null;
  locale: string;
  published_at: Date;
};

function toDetail(row: PublicBlogPostDetailRow): PublicBlogPostDetail {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    contentJson: row.content_json,
    contentText: row.content_text,
    seoTitle: row.seo_title,
    metaDescription: row.meta_description,
    canonicalUrl: row.canonical_url,
    locale: row.locale,
    publishedAt: row.published_at
  };
}

export async function fetchPublicBlogPostBySlug(
  tx: Bun.SQL,
  tenantId: string,
  slug: string
): Promise<PublicBlogPostDetail | null> {
  const rows = (await tx`
    SELECT id, title, slug, excerpt, content_json, content_text, seo_title,
      meta_description, canonical_url, locale, published_at
    FROM awcms_mini_blog_posts
    WHERE tenant_id = ${tenantId} AND slug = ${slug}
      AND status = 'published' AND visibility IN ('public', 'unlisted')
      AND deleted_at IS NULL AND published_at IS NOT NULL AND published_at <= now()
    ORDER BY published_at DESC
    LIMIT 1
  `) as PublicBlogPostDetailRow[];

  const row = rows[0];
  return row ? toDetail(row) : null;
}

export type PublicBlogPostSummary = {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  publishedAt: Date;
};

type PublicBlogPostSummaryRow = {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  published_at: Date;
};

function toSummary(row: PublicBlogPostSummaryRow): PublicBlogPostSummary {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    publishedAt: row.published_at
  };
}

export type PublicBlogPostPage = {
  items: PublicBlogPostSummary[];
  hasNextPage: boolean;
};

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

function boundedPageSize(pageSize: number | undefined): number {
  return Math.min(Math.max(pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

function boundedPage(page: number | undefined): number {
  return Math.max(page ?? 1, 1);
}

/** Standard `?page=` (1-indexed) pagination — fetches `pageSize + 1` rows to derive `hasNextPage` without a separate `COUNT(*)` query, same "one extra row" trick used for cursor pagination elsewhere in this repo. */
export async function listPublicBlogPosts(
  tx: Bun.SQL,
  tenantId: string,
  options: { page?: number; pageSize?: number } = {}
): Promise<PublicBlogPostPage> {
  const pageSize = boundedPageSize(options.pageSize);
  const page = boundedPage(options.page);
  const offset = (page - 1) * pageSize;

  const rows = (await tx`
    SELECT id, title, slug, excerpt, published_at
    FROM awcms_mini_blog_posts
    WHERE tenant_id = ${tenantId}
      AND status = 'published' AND visibility = 'public'
      AND deleted_at IS NULL AND published_at IS NOT NULL AND published_at <= now()
    ORDER BY published_at DESC
    LIMIT ${pageSize + 1} OFFSET ${offset}
  `) as PublicBlogPostSummaryRow[];

  const hasNextPage = rows.length > pageSize;

  return {
    items: rows.slice(0, pageSize).map(toSummary),
    hasNextPage
  };
}

export type PublicTermSummary = {
  id: string;
  taxonomyType: string;
  name: string;
  slug: string;
  description: string | null;
};

/** Category/tag lookup for an archive page — 404 if the term doesn't exist or is soft-deleted, same as any other public "not found" case. */
export async function fetchPublicTermBySlug(
  tx: Bun.SQL,
  tenantId: string,
  taxonomyType: string,
  slug: string
): Promise<PublicTermSummary | null> {
  const rows = (await tx`
    SELECT id, taxonomy_type, name, slug, description
    FROM awcms_mini_blog_terms
    WHERE tenant_id = ${tenantId} AND taxonomy_type = ${taxonomyType}
      AND slug = ${slug} AND deleted_at IS NULL
  `) as {
    id: string;
    taxonomy_type: string;
    name: string;
    slug: string;
    description: string | null;
  }[];

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    taxonomyType: row.taxonomy_type,
    name: row.name,
    slug: row.slug,
    description: row.description
  };
}

export async function listPublicBlogPostsByTermId(
  tx: Bun.SQL,
  tenantId: string,
  termId: string,
  options: { page?: number; pageSize?: number } = {}
): Promise<PublicBlogPostPage> {
  const pageSize = boundedPageSize(options.pageSize);
  const page = boundedPage(options.page);
  const offset = (page - 1) * pageSize;

  const rows = (await tx`
    SELECT p.id, p.title, p.slug, p.excerpt, p.published_at
    FROM awcms_mini_blog_posts p
    JOIN awcms_mini_blog_post_terms pt
      ON pt.post_id = p.id AND pt.tenant_id = p.tenant_id
    WHERE p.tenant_id = ${tenantId} AND pt.term_id = ${termId}
      AND p.status = 'published' AND p.visibility = 'public'
      AND p.deleted_at IS NULL AND p.published_at IS NOT NULL AND p.published_at <= now()
    ORDER BY p.published_at DESC
    LIMIT ${pageSize + 1} OFFSET ${offset}
  `) as PublicBlogPostSummaryRow[];

  const hasNextPage = rows.length > pageSize;

  return {
    items: rows.slice(0, pageSize).map(toSummary),
    hasNextPage
  };
}

const FEED_ITEM_LIMIT = 50;

/** RSS/sitemap source — flat, unpaginated (feeds/sitemaps are consumed by machines, not paged by a visitor), bounded to the latest 50 published public posts. */
export async function listPublicBlogPostsForFeed(
  tx: Bun.SQL,
  tenantId: string
): Promise<PublicBlogPostDetail[]> {
  const rows = (await tx`
    SELECT id, title, slug, excerpt, content_json, content_text, seo_title,
      meta_description, canonical_url, locale, published_at
    FROM awcms_mini_blog_posts
    WHERE tenant_id = ${tenantId}
      AND status = 'published' AND visibility = 'public'
      AND deleted_at IS NULL AND published_at IS NOT NULL AND published_at <= now()
    ORDER BY published_at DESC
    LIMIT ${FEED_ITEM_LIMIT}
  `) as PublicBlogPostDetailRow[];

  return rows.map(toDetail);
}

export type PublicBlogSettings = {
  postsPerPage: number;
  seoDefaultTitle: string | null;
  seoDefaultDescription: string | null;
};

const DEFAULT_POSTS_PER_PAGE = 10;

/** Reads `awcms_mini_blog_settings` (Issue #537), falling back to schema defaults when the tenant has never configured a row — same "missing row = default" convention `resolveModuleEnabled` uses for `awcms_mini_tenant_modules`. */
export async function fetchPublicBlogSettings(
  tx: Bun.SQL,
  tenantId: string
): Promise<PublicBlogSettings> {
  const rows = (await tx`
    SELECT posts_per_page, seo_default_title, seo_default_description
    FROM awcms_mini_blog_settings
    WHERE tenant_id = ${tenantId}
  `) as {
    posts_per_page: number;
    seo_default_title: string | null;
    seo_default_description: string | null;
  }[];

  const row = rows[0];

  return {
    postsPerPage: row?.posts_per_page ?? DEFAULT_POSTS_PER_PAGE,
    seoDefaultTitle: row?.seo_default_title ?? null,
    seoDefaultDescription: row?.seo_default_description ?? null
  };
}
