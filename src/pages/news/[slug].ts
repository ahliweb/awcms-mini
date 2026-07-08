import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../lib/database/client";
import { escapeHtml } from "../../lib/html/escape";
import {
  notFoundHtmlResponse,
  serverErrorHtmlResponse
} from "../../lib/html/error-responses";
import { log } from "../../lib/logging/logger";
import { fetchPublicBlogPostBySlug } from "../../modules/blog-content/application/public-blog-directory";
import { withNewsTenant } from "../../modules/blog-content/application/public-news-tenant-resolution";
import { renderContentJsonToHtml } from "../../modules/blog-content/domain/content-block-rendering";
import {
  resolveCanonicalUrl,
  resolveMetaDescription,
  resolveSeoTitle
} from "../../modules/blog-content/domain/seo-rendering";
import { renderPublicPageShell } from "../../modules/blog-content/domain/public-page-rendering";

/**
 * `GET /news/{slug}` (Issue #560) — public post detail, tenant-code-free
 * counterpart of `/blog/{tenantCode}/{slug}` (Issue #540). Same
 * `fetchPublicBlogPostBySlug` predicate (`visibility IN ('public',
 * 'unlisted')`, private/non-published/scheduled-future/soft-deleted always
 * 404) — only the tenant resolution and canonical/self URL base path
 * differ (`/news/{slug}` here vs `/blog/{tenantCode}/{slug}`).
 */
export const GET: APIRoute = async ({ params, request, url }) => {
  const slug = params.slug;

  if (!slug) {
    return notFoundHtmlResponse();
  }

  try {
    const sql = getDatabaseClient();

    const result = await withNewsTenant(sql, request, async (tx, tenant) => {
      const post = await fetchPublicBlogPostBySlug(tx, tenant.tenantId, slug);

      if (!post) {
        return null;
      }

      const selfUrl = `${url.origin}/news/${post.slug}`;
      const seoTitle = resolveSeoTitle(post);
      const metaDescription = resolveMetaDescription(post);
      const canonicalUrl = resolveCanonicalUrl(post, selfUrl);
      const contentHtml = renderContentJsonToHtml(post.contentJson);

      const bodyHtml = `<article>
  <h1>${escapeHtml(post.title)}</h1>
  <p><time datetime="${post.publishedAt.toISOString()}">${escapeHtml(post.publishedAt.toDateString())}</time></p>
  ${contentHtml}
</article>
<p><a href="/news">Back to news</a></p>`;

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

    return result ?? notFoundHtmlResponse();
  } catch (error) {
    log("error", "public_news.detail.failed", {
      slug,
      error: error instanceof Error ? error.message : String(error)
    });
    return serverErrorHtmlResponse();
  }
};
