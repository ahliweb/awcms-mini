import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../lib/database/client";
import { withTenant } from "../../../lib/database/tenant-context";
import { resolvePublicTenantByCode } from "../../../lib/tenant/public-tenant-resolver";
import { escapeHtml } from "../../../lib/html/escape";
import {
  notFoundXmlResponse,
  serverErrorXmlResponse
} from "../../../lib/html/error-responses";
import { log } from "../../../lib/logging/logger";
import { listPublicBlogPostsForFeed } from "../../../modules/blog-content/application/public-blog-directory";
import { fetchBlogSettings } from "../../../modules/blog-content/application/blog-settings-directory";

/**
 * `GET /blog/{tenantCode}/sitemap-blog.xml` (Issue #540) — sitemap
 * protocol 0.9, same public visibility predicate as the RSS feed/index
 * (doc issue #540 §Sitemap Requirements: same exclusion list as RSS).
 * Issue #543 §Settings Page adds `sitemapEnabled` — same disabled-looks-
 * like-404 behavior as the RSS feed above.
 */
export const GET: APIRoute = async ({ params, url }) => {
  const tenantCode = params.tenantCode;

  if (!tenantCode) {
    return notFoundXmlResponse();
  }

  try {
    const sql = getDatabaseClient();
    const tenant = await resolvePublicTenantByCode(sql, tenantCode);

    if (!tenant) {
      return notFoundXmlResponse();
    }

    return await withTenant(sql, tenant.tenantId, async (tx) => {
      const settings = await fetchBlogSettings(tx, tenant.tenantId);

      if (!settings.sitemapEnabled) {
        return notFoundXmlResponse();
      }

      const posts = await listPublicBlogPostsForFeed(tx, tenant.tenantId);
      const channelLink = `${url.origin}/blog/${tenantCode}`;

      const urls = posts
        .map((post) => {
          const link = `${channelLink}/${post.slug}`;
          return `<url>
<loc>${escapeHtml(link)}</loc>
<lastmod>${post.publishedAt.toISOString()}</lastmod>
</url>`;
        })
        .join("\n");

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url>
<loc>${escapeHtml(channelLink)}</loc>
</url>
${urls}
</urlset>`;

      return new Response(xml, {
        status: 200,
        headers: { "content-type": "application/xml; charset=utf-8" }
      });
    });
  } catch (error) {
    log("error", "public_blog.sitemap.failed", {
      tenantCode,
      error: error instanceof Error ? error.message : String(error)
    });
    return serverErrorXmlResponse();
  }
};
