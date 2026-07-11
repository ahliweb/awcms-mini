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
import { composeHomepageSectionsHtml } from "../../modules/news-portal/application/homepage-section-composer";
import { publicContentPortAdapter } from "../../modules/blog-content/application/public-content-port-adapter";
import { newsMediaPortAdapter } from "../../modules/news-portal/application/news-media-port-adapter";

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
 *
 * Issue #637 — the editorial homepage section composer renders ABOVE the
 * plain chronological listing, page 1 only (sections are a curated
 * "front page", pagination past page 1 is just the chronological archive
 * — mixing the two there would be confusing). A tenant that has never
 * configured any section (`composeHomepageSectionsHtml`'s
 * `hasSections: false`, the overwhelming majority today) sees byte-for-byte
 * the same page as before this issue — purely additive, never a
 * replacement for the plain list.
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

        const composedSections =
          page === 1
            ? await composeHomepageSectionsHtml(
                tx,
                tenant.tenantId,
                basePath,
                publicContentPortAdapter,
                newsMediaPortAdapter
              )
            : { hasSections: false, html: "" };

        const bodyHtml = `<h1>${escapeHtml(tenant.tenantName)} ${escapeHtml(routeSettings.publicLabel)}</h1>
${composedSections.hasSections ? composedSections.html : ""}
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
