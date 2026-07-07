/**
 * Read-only query placeholder (Issue #537, foundation only). No admin API
 * exists yet — Issue #538 adds the guarded `/api/v1/blog/posts` endpoints
 * and will call these same functions, the same pattern
 * `tenant-admin/application/tenant-settings-directory.ts` established for
 * sharing a query between an endpoint and an SSR admin page.
 */
export type BlogPostSummary = {
  id: string;
  tenantId: string;
  title: string;
  slug: string;
  status: string;
  visibility: string;
  locale: string;
  publishedAt: Date | null;
  updatedAt: Date;
};

type BlogPostRow = {
  id: string;
  tenant_id: string;
  title: string;
  slug: string;
  status: string;
  visibility: string;
  locale: string;
  published_at: Date | null;
  updated_at: Date;
};

function toBlogPostSummary(row: BlogPostRow): BlogPostSummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    slug: row.slug,
    status: row.status,
    visibility: row.visibility,
    locale: row.locale,
    publishedAt: row.published_at,
    updatedAt: row.updated_at
  };
}

export async function fetchBlogPostById(
  tx: Bun.SQL,
  tenantId: string,
  postId: string
): Promise<BlogPostSummary | null> {
  const rows = (await tx`
    SELECT id, tenant_id, title, slug, status, visibility, locale, published_at, updated_at
    FROM awcms_mini_blog_posts
    WHERE tenant_id = ${tenantId} AND id = ${postId} AND deleted_at IS NULL
  `) as BlogPostRow[];

  const row = rows[0];
  return row ? toBlogPostSummary(row) : null;
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

export async function listBlogPostsByStatus(
  tx: Bun.SQL,
  tenantId: string,
  status: string,
  limit: number = DEFAULT_LIST_LIMIT
): Promise<BlogPostSummary[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);

  const rows = (await tx`
    SELECT id, tenant_id, title, slug, status, visibility, locale, published_at, updated_at
    FROM awcms_mini_blog_posts
    WHERE tenant_id = ${tenantId} AND status = ${status} AND deleted_at IS NULL
    ORDER BY published_at DESC NULLS LAST, updated_at DESC
    LIMIT ${boundedLimit}
  `) as BlogPostRow[];

  return rows.map(toBlogPostSummary);
}
