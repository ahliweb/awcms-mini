import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../lib/database/client";
import { escapeHtml } from "../../lib/html/escape";
import {
  notFoundXmlResponse,
  serverErrorXmlResponse
} from "../../lib/html/error-responses";
import { log } from "../../lib/logging/logger";
import { listPublicBlogPostsForFeed } from "../../modules/blog-content/application/public-blog-directory";
import { withNewsTenant } from "../../modules/blog-content/application/public-news-tenant-resolution";
import { fetchBlogSettings } from "../../modules/blog-content/application/blog-settings-directory";
import { resolveNewsArticlePreviewImage } from "../../modules/blog-content/application/news-article-seo-metadata";
import { newsMediaPortAdapter } from "../../modules/news-portal/application/news-media-port-adapter";
import { resolveMetaDescription } from "../../modules/blog-content/domain/seo-rendering";

/**
 * `GET /news/feed.xml` (Issue #560) — RSS 2.0, tenant-code-free counterpart
 * of `/blog/{tenantCode}/feed.xml` (Issue #540). Same `rssEnabled` gate
 * (Issue #543) — a tenant that has the feed turned off (or `blog_content`
 * disabled entirely, or `publicRouteMode=disabled` since Issue #564) 404s
 * the same generic way as an unresolved tenant. `rssEnabled` still comes
 * from `awcms_mini_blog_settings` (unchanged store, Issue #543) —
 * `withNewsTenant`'s `routeSettings` merges it in for convenience only, see
 * `application/public-route-settings.ts`. `publicBasePath`/`publicLabel`
 * (Issue #564) are new: the feed's self-link and channel title now follow
 * the tenant's effective settings instead of a hardcoded `/news`/`News`.
 */
export const GET: APIRoute = async ({ request, url }) => {
  try {
    const sql = getDatabaseClient();

    const result = await withNewsTenant(
      sql,
      request,
      async (tx, tenant, routeSettings) => {
        if (!routeSettings.rssEnabled) {
          return null;
        }

        const posts = await listPublicBlogPostsForFeed(tx, tenant.tenantId);
        const blogSettings = await fetchBlogSettings(tx, tenant.tenantId);
        const channelLink = `${url.origin}${routeSettings.publicBasePath}`;

        // Issue #649 — "RSS... should use... verified R2 preview images
        // where applicable." Resolved sequentially (not `Promise.all`): every
        // query in this loop shares the SAME transaction (`tx`), and this
        // repo's convention (every other multi-query loop in this codebase)
        // is one query at a time per transaction, never concurrent queries
        // racing on one connection.
        const itemParts: string[] = [];
        for (const post of posts) {
          const link = `${channelLink}/${post.slug}`;
          const description = resolveMetaDescription(post);
          const previewImage = await resolveNewsArticlePreviewImage(
            tx,
            tenant.tenantId,
            newsMediaPortAdapter,
            blogSettings,
            post
          );
          const enclosure = previewImage
            ? `<enclosure url="${escapeHtml(previewImage.url)}" length="${previewImage.sizeBytes ?? 0}" type="${escapeHtml(previewImage.mimeType)}" />`
            : "";

          itemParts.push(`<item>
<title>${escapeHtml(post.title)}</title>
<link>${escapeHtml(link)}</link>
<guid isPermaLink="true">${escapeHtml(link)}</guid>
<pubDate>${post.publishedAt.toUTCString()}</pubDate>
<description>${escapeHtml(description)}</description>
${enclosure}
</item>`);
        }

        const items = itemParts.join("\n");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${escapeHtml(tenant.tenantName)} ${escapeHtml(routeSettings.publicLabel)}</title>
<link>${escapeHtml(channelLink)}</link>
<description>Latest posts from ${escapeHtml(tenant.tenantName)}.</description>
<language>${escapeHtml(tenant.defaultLocale)}</language>
${items}
</channel>
</rss>`;

        return new Response(xml, {
          status: 200,
          headers: { "content-type": "application/rss+xml; charset=utf-8" }
        });
      }
    );

    return result ?? notFoundXmlResponse();
  } catch (error) {
    log("error", "public_news.feed.failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return serverErrorXmlResponse();
  }
};
