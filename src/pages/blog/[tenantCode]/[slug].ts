import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../lib/database/client";
import { withTenant } from "../../../lib/database/tenant-context";
import { resolvePublicTenantByCode } from "../../../lib/tenant/public-tenant-resolver";
import { escapeHtml } from "../../../lib/html/escape";
import {
  notFoundHtmlResponse,
  serverErrorHtmlResponse
} from "../../../lib/html/error-responses";
import { log } from "../../../lib/logging/logger";
import { fetchPublicBlogPostBySlug } from "../../../modules/blog-content/application/public-blog-directory";
import { renderContentJsonToHtml } from "../../../modules/blog-content/domain/content-block-rendering";
import {
  resolveCanonicalUrl,
  resolveMetaDescription,
  resolveSeoTitle
} from "../../../modules/blog-content/domain/seo-rendering";
import { renderPublicPageShell } from "../../../modules/blog-content/domain/public-page-rendering";

/**
 * `GET /blog/{tenantCode}/{slug}` (Issue #540) — public post detail.
 * Reachable for `visibility IN ('public', 'unlisted')` (unlisted = direct
 * link only, excluded from every listing surface — see
 * `public-blog-directory.ts`'s doc comment); `private`, non-`published`,
 * scheduled-future, and soft-deleted posts always 404.
 */
export const GET: APIRoute = async ({ params, url }) => {
  const tenantCode = params.tenantCode;
  const slug = params.slug;

  if (!tenantCode || !slug) {
    return notFoundHtmlResponse();
  }

  try {
    const sql = getDatabaseClient();
    const tenant = await resolvePublicTenantByCode(sql, tenantCode);

    if (!tenant) {
      return notFoundHtmlResponse();
    }

    return await withTenant(sql, tenant.tenantId, async (tx) => {
      const post = await fetchPublicBlogPostBySlug(tx, tenant.tenantId, slug);

      if (!post) {
        return notFoundHtmlResponse();
      }

      const selfUrl = `${url.origin}/blog/${tenantCode}/${post.slug}`;
      const seoTitle = resolveSeoTitle(post);
      const metaDescription = resolveMetaDescription(post);
      const canonicalUrl = resolveCanonicalUrl(post, selfUrl);
      const contentHtml = renderContentJsonToHtml(post.contentJson);

      const bodyHtml = `<article>
  <h1>${escapeHtml(post.title)}</h1>
  <p><time datetime="${post.publishedAt.toISOString()}">${escapeHtml(post.publishedAt.toDateString())}</time></p>
  ${contentHtml}
</article>
<p><a href="/blog/${escapeHtml(tenantCode)}">Back to blog</a></p>`;

      const html = renderPublicPageShell({
        title: seoTitle,
        description: metaDescription,
        canonicalUrl,
        bodyHtml,
        locale: post.locale
      });

      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
  } catch (error) {
    log("error", "public_blog.detail.failed", {
      tenantCode,
      slug,
      error: error instanceof Error ? error.message : String(error)
    });
    return serverErrorHtmlResponse();
  }
};
