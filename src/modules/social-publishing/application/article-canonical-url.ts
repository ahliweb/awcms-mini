/**
 * Canonical `/news/...` URL resolution for social publish job snapshots
 * (Issue #643 §Integration with news content: "Use canonical `/news/...`
 * URL"). A direct raw-SQL read of `awcms_mini_tenant_domains` (owned by the
 * `tenant_domain` module) — same "read another module's table directly by
 * SQL, no cross-module TS import" precedent
 * `blog-content/application/public-news-tenant-resolution.ts` already
 * established for this exact table (see that file's own header); the
 * structural module-boundary test (`tests/unit/module-boundary.test.ts`,
 * Issue #681) only governs the `blog_content`<->`news_portal` pair, so this
 * is not even a boundary exception, just an ordinary same-conventions read.
 *
 * Every other canonical-URL construction site in this repo
 * (`/news/[slug].ts`, `sitemap-news.xml.ts`) uses the LIVE request's
 * `url.origin` — not available here, since job creation happens from a
 * composition root that may have no incoming request at all (the
 * `blog:publish:scheduled` worker). The tenant's PRIMARY, VERIFIED
 * (`status = 'active'`) custom domain is the next best stable source of
 * truth for "this tenant's public hostname" — if a tenant has none
 * configured, this deliberately returns `null` rather than fabricate a
 * guessed URL; `create-social-publish-jobs.ts` skips job creation for that
 * tenant/article with a documented reason rather than publish a
 * wrong/broken canonical URL to an external platform.
 */
export async function resolvePrimaryVerifiedDomainHostname(
  tx: Bun.SQL,
  tenantId: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT hostname FROM awcms_mini_tenant_domains
    WHERE tenant_id = ${tenantId} AND is_primary = true AND status = 'active'
      AND deleted_at IS NULL
    LIMIT 1
  `) as { hostname: string }[];

  return rows[0]?.hostname ?? null;
}

/** `publicBasePath` must be an absolute path (e.g. `/news`) — resolved by the caller via `blog_content`'s own `fetchEffectivePublicRouteSettings` (same-module call at the composition root, not a cross-module import from here). */
export function buildArticleCanonicalUrl(
  hostname: string,
  publicBasePath: string,
  slug: string
): string {
  return `https://${hostname}${publicBasePath}/${slug}`;
}
