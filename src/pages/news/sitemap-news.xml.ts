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

/**
 * `GET /news/sitemap-news.xml` (Issue #560) — sitemap protocol 0.9,
 * tenant-code-free counterpart of `/blog/{tenantCode}/sitemap-blog.xml`
 * (Issue #540). Same `sitemapEnabled` gate (Issue #543) and same
 * disabled-looks-like-404 behavior as the RSS feed above (extended to
 * `publicRouteMode=disabled` by Issue #564). `sitemapEnabled` still comes
 * from `awcms_mini_blog_settings` (unchanged store) — see
 * `application/public-route-settings.ts`. `<loc>` entries now follow the
 * tenant's effective `publicBasePath` (Issue #564) instead of a hardcoded
 * `/news`.
 */
export const GET: APIRoute = async ({ request, url }) => {
  try {
    const sql = getDatabaseClient();

    const result = await withNewsTenant(
      sql,
      request,
      async (tx, tenant, routeSettings) => {
        if (!routeSettings.sitemapEnabled) {
          return null;
        }

        const posts = await listPublicBlogPostsForFeed(tx, tenant.tenantId);
        const blogSettings = await fetchBlogSettings(tx, tenant.tenantId);
        const channelLink = `${url.origin}${routeSettings.publicBasePath}`;

        // Issue #649 — "sitemap/news sitemap should use canonical public
        // URLs and verified R2 preview images where applicable" (the
        // `image` sitemap extension namespace). Resolved sequentially, one
        // query at a time on the shared transaction (same reasoning as
        // `feed.xml.ts`).
        const urlParts: string[] = [];
        for (const post of posts) {
          const link = `${channelLink}/${post.slug}`;
          const previewImage = await resolveNewsArticlePreviewImage(
            tx,
            tenant.tenantId,
            newsMediaPortAdapter,
            blogSettings,
            post
          );
          const imageTag = previewImage
            ? `<image:image><image:loc>${escapeHtml(previewImage.url)}</image:loc></image:image>`
            : "";

          urlParts.push(`<url>
<loc>${escapeHtml(link)}</loc>
<lastmod>${post.publishedAt.toISOString()}</lastmod>
${imageTag}
</url>`);
        }

        const urls = urlParts.join("\n");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
<url>
<loc>${escapeHtml(channelLink)}</loc>
</url>
${urls}
</urlset>`;

        return new Response(xml, {
          status: 200,
          headers: { "content-type": "application/xml; charset=utf-8" }
        });
      }
    );

    return result ?? notFoundXmlResponse();
  } catch (error) {
    log("error", "public_news.sitemap.failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return serverErrorXmlResponse();
  }
};
