import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../lib/database/client";
import { escapeHtml } from "../../../lib/html/escape";
import {
  notFoundHtmlResponse,
  serverErrorHtmlResponse
} from "../../../lib/html/error-responses";
import { log } from "../../../lib/logging/logger";
import {
  fetchPublicTermBySlug,
  listPublicBlogPostsByTermId
} from "../../../modules/blog-content/application/public-blog-directory";
import { withNewsTenant } from "../../../modules/blog-content/application/public-news-tenant-resolution";
import {
  renderPaginationNavHtml,
  renderPostSummaryListHtmlAtBasePath,
  renderPublicPageShell
} from "../../../modules/blog-content/domain/public-page-rendering";

/**
 * `GET /news/tag/{slug}` (Issue #560) — same as the category archive above,
 * scoped to `taxonomy_type = 'tag'`; tenant-code-free counterpart of
 * `/blog/{tenantCode}/tag/{slug}` (Issue #540).
 */
export const GET: APIRoute = async ({ params, request, url }) => {
  const slug = params.slug;

  if (!slug) {
    return notFoundHtmlResponse();
  }

  try {
    const sql = getDatabaseClient();
    const pageParam = url.searchParams.get("page");
    const page = pageParam ? Number(pageParam) : 1;

    const result = await withNewsTenant(
      sql,
      request,
      async (tx, tenant, routeSettings) => {
        const term = await fetchPublicTermBySlug(
          tx,
          tenant.tenantId,
          "tag",
          slug
        );

        if (!term) {
          return null;
        }

        const posts = await listPublicBlogPostsByTermId(
          tx,
          tenant.tenantId,
          term.id,
          { page }
        );
        const basePath = routeSettings.publicBasePath;
        const tagPath = `${basePath}/tag/${term.slug}`;

        const bodyHtml = `<h1>Tag: ${escapeHtml(term.name)}</h1>
<div class="posts">${renderPostSummaryListHtmlAtBasePath(basePath, posts.items, "No posts with this tag yet.")}</div>
${renderPaginationNavHtml(page, posts.hasNextPage, tagPath)}`;

        const html = renderPublicPageShell({
          title: `${term.name} — ${tenant.tenantName} ${routeSettings.publicLabel}`,
          description: term.description ?? `Posts tagged ${term.name}.`,
          canonicalUrl: `${url.origin}${tagPath}`,
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
    log("error", "public_news.tag.failed", {
      slug,
      error: error instanceof Error ? error.message : String(error)
    });
    return serverErrorHtmlResponse();
  }
};
