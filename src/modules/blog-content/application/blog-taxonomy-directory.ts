/**
 * Read-only query placeholder (Issue #537, foundation only). No admin API
 * exists yet — Issue #539 adds the guarded `/api/v1/blog/terms` endpoints
 * and will call these same functions, same reasoning as
 * `blog-post-directory.ts`.
 */
export type BlogTermSummary = {
  id: string;
  tenantId: string;
  taxonomyType: string;
  parentId: string | null;
  name: string;
  slug: string;
};

type BlogTermRow = {
  id: string;
  tenant_id: string;
  taxonomy_type: string;
  parent_id: string | null;
  name: string;
  slug: string;
};

function toBlogTermSummary(row: BlogTermRow): BlogTermSummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taxonomyType: row.taxonomy_type,
    parentId: row.parent_id,
    name: row.name,
    slug: row.slug
  };
}

export async function fetchBlogTermsByTaxonomyType(
  tx: Bun.SQL,
  tenantId: string,
  taxonomyType: string
): Promise<BlogTermSummary[]> {
  const rows = (await tx`
    SELECT id, tenant_id, taxonomy_type, parent_id, name, slug
    FROM awcms_mini_blog_terms
    WHERE tenant_id = ${tenantId}
      AND taxonomy_type = ${taxonomyType}
      AND deleted_at IS NULL
    ORDER BY name ASC
  `) as BlogTermRow[];

  return rows.map(toBlogTermSummary);
}
