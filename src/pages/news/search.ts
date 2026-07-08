import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../lib/database/client";
import { escapeHtml } from "../../lib/html/escape";
import {
  notFoundHtmlResponse,
  serverErrorHtmlResponse
} from "../../lib/html/error-responses";
import { log } from "../../lib/logging/logger";
import { searchPublicBlogContent } from "../../modules/blog-content/application/blog-search";
import { withNewsTenant } from "../../modules/blog-content/application/public-news-tenant-resolution";
import {
  renderPostSummaryListHtmlAtBasePath,
  renderPublicPageShell
} from "../../modules/blog-content/domain/public-page-rendering";
import { decodeKeysetCursor } from "../../modules/_shared/keyset-pagination";

/**
 * `GET /news/search?q=` (Issue #560) — tenant-code-free counterpart of
 * `/blog/{tenantCode}/search` (Issue #540), reusing `searchPublicBlogContent`
 * (Issue #539) directly with the same public visibility predicate.
 */
export const GET: APIRoute = async ({ request, url }) => {
  try {
    const sql = getDatabaseClient();
    const query = url.searchParams.get("q")?.trim() ?? "";
    const cursorParam = url.searchParams.get("cursor");
    const cursor = cursorParam ? decodeKeysetCursor(cursorParam) : null;

    const result = await withNewsTenant(
      sql,
      request,
      async (tx, tenant, routeSettings) => {
        const searchResult =
          query.length > 0
            ? await searchPublicBlogContent(tx, tenant.tenantId, {
                query,
                resourceType: "post",
                cursor: cursor ?? undefined
              })
            : { items: [], nextCursor: null };

        const basePath = routeSettings.publicBasePath;
        const searchPath = `${basePath}/search`;
        const label = routeSettings.publicLabel;

        const nextLink =
          searchResult.nextCursor && query.length > 0
            ? `<a href="?q=${encodeURIComponent(query)}&cursor=${encodeURIComponent(searchResult.nextCursor)}">Next</a>`
            : "";

        const bodyHtml = `<h1>Search ${escapeHtml(tenant.tenantName)} ${escapeHtml(label)}</h1>
<form method="get" action="${escapeHtml(searchPath)}">
  <input type="text" name="q" value="${escapeHtml(query)}" aria-label="Search" />
  <button type="submit">Search</button>
</form>
<div class="posts">${
          query.length === 0
            ? "<p>Enter a search term above.</p>"
            : renderPostSummaryListHtmlAtBasePath(
                basePath,
                searchResult.items,
                "No results found."
              )
        }</div>
<nav>${nextLink}</nav>`;

        const html = renderPublicPageShell({
          title: query
            ? `Search: ${query} — ${tenant.tenantName} ${label}`
            : `Search — ${tenant.tenantName} ${label}`,
          description: `Search results for "${query}" on the ${tenant.tenantName} news site.`,
          canonicalUrl: null,
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
    log("error", "public_news.search.failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return serverErrorHtmlResponse();
  }
};
