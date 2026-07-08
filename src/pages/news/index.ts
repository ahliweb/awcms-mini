import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../lib/database/client";
import { escapeHtml } from "../../lib/html/escape";
import {
  notFoundHtmlResponse,
  serverErrorHtmlResponse
} from "../../lib/html/error-responses";
import { log } from "../../lib/logging/logger";
import {
  fetchPublicBlogSettings,
  listPublicBlogPosts
} from "../../modules/blog-content/application/public-blog-directory";
import { withNewsTenant } from "../../modules/blog-content/application/public-news-tenant-resolution";
import {
  renderPaginationNavHtml,
  renderPostSummaryListHtmlAtBasePath,
  renderPublicPageShell
} from "../../modules/blog-content/domain/public-page-rendering";

/**
 * `GET /news` (Issue #560, epic #555) — public blog index, tenant-code-free
 * counterpart of `/blog/{tenantCode}` (Issue #540). Reuses every
 * application/domain service `/blog/{tenantCode}` uses unchanged (same
 * `listPublicBlogPosts`/`fetchPublicBlogSettings`, same public-visibility
 * predicate) — the ONLY difference is how the tenant is resolved:
 * `withNewsTenant()` (`resolvePublicTenantFromRequest`, Issue #559) instead
 * of `resolvePublicTenantByCode` from a path segment, plus the module-
 * disabled gate that function also enforces (an explicit Issue #560
 * acceptance criterion that does not exist yet for the legacy route — see
 * `src/modules/blog-content/README.md` §Rute publik `/news`).
 */
export const GET: APIRoute = async ({ request, url }) => {
  try {
    const sql = getDatabaseClient();
    const pageParam = url.searchParams.get("page");
    const page = pageParam ? Number(pageParam) : 1;

    const result = await withNewsTenant(
      sql,
      request,
      async (tx, tenant, routeSettings) => {
        const settings = await fetchPublicBlogSettings(tx, tenant.tenantId);
        const posts = await listPublicBlogPosts(tx, tenant.tenantId, {
          page,
          pageSize: settings.postsPerPage
        });
        const basePath = routeSettings.publicBasePath;

        const bodyHtml = `<h1>${escapeHtml(tenant.tenantName)} ${escapeHtml(routeSettings.publicLabel)}</h1>
<div class="posts">${renderPostSummaryListHtmlAtBasePath(basePath, posts.items, "No posts yet.")}</div>
${renderPaginationNavHtml(page, posts.hasNextPage, basePath)}`;

        const html = renderPublicPageShell({
          title:
            settings.seoDefaultTitle ??
            `${tenant.tenantName} ${routeSettings.publicLabel}`,
          description:
            settings.seoDefaultDescription ??
            `Latest posts from ${tenant.tenantName}.`,
          canonicalUrl: `${url.origin}${basePath}`,
          bodyHtml,
          locale: tenant.defaultLocale
        });

        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
    );

    return result ?? notFoundHtmlResponse();
  } catch (error) {
    log("error", "public_news.index.failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return serverErrorHtmlResponse();
  }
};
