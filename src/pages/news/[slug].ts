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
import { fetchBlogSettings } from "../../modules/blog-content/application/blog-settings-directory";
import { buildNewsArticleSeoMetadata } from "../../modules/blog-content/application/news-article-seo-metadata";
import { newsMediaPortAdapter } from "../../modules/news-portal/application/news-media-port-adapter";
import { resolveNewsShareConfig } from "../../modules/news-portal/domain/news-share-config";
import { renderContentJsonToHtml } from "../../modules/blog-content/domain/content-block-rendering";
import { renderContentHtmlWithInternalTagLinks } from "../../modules/blog-content/application/internal-tag-link-rendering";
import {
  resolveCanonicalUrl,
  resolveMetaDescription,
  resolveSeoTitle
} from "../../modules/blog-content/domain/seo-rendering";
import { renderPublicPageShell } from "../../modules/blog-content/domain/public-page-rendering";
import { renderSocialShareButtonsHtml } from "../../modules/blog-content/domain/social-share-links";

const NEWS_SHARE_CLIENT_SCRIPT_SRC = "/js/news-share.js";

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

    const result = await withNewsTenant(
      sql,
      request,
      async (tx, tenant, routeSettings) => {
        const post = await fetchPublicBlogPostBySlug(tx, tenant.tenantId, slug);

        if (!post) {
          return null;
        }

        const basePath = routeSettings.publicBasePath;
        const selfUrl = `${url.origin}${basePath}/${post.slug}`;
        const seoTitle = resolveSeoTitle(post);
        const metaDescription = resolveMetaDescription(post);
        const canonicalUrl = resolveCanonicalUrl(post, selfUrl);

        // Issue #649 — one shared orchestration builds every SEO/social
        // preview metadata value (resolved gallery/featured/SEO-image URLs,
        // og:image + dimensions/MIME, robots directive, article:section/tag,
        // NewsArticle JSON-LD) from a SINGLE bulk media resolution, reusing
        // Issue #636's exact R2-verification primitive
        // (`NewsMediaPort.resolveMediaReferences`) rather than re-deriving
        // it. Shared with `/blog/[tenantCode]/[slug].ts` so both routes stay
        // byte-for-byte consistent.
        const blogSettings = await fetchBlogSettings(tx, tenant.tenantId);
        const seoMetadata = await buildNewsArticleSeoMetadata(
          tx,
          tenant.tenantId,
          newsMediaPortAdapter,
          blogSettings,
          {
            post,
            tenantName: tenant.tenantName,
            canonicalUrl,
            seoTitle,
            metaDescription
          }
        );

        const renderedContentHtml = renderContentJsonToHtml(
          post.contentJson,
          seoMetadata.resolvedGalleryUrls
        );

        // Issue #641 — automatic internal tag linking, applied as a pure
        // render-time transform of the already-safe renderer output (never
        // the stored `content_json`/`content_text`). No-ops (returns
        // `renderedContentHtml` unchanged) when the deployment/tenant/post
        // has it disabled — see `internal-tag-link-rendering.ts`.
        const contentHtml = await renderContentHtmlWithInternalTagLinks(
          tx,
          tenant.tenantId,
          renderedContentHtml,
          post.autoInternalTagLinksDisabled,
          basePath
        );

        // Issue #642 — public share buttons, rendered only for this
        // already-gated public/published post (withNewsTenant + a non-null
        // fetchPublicBlogPostBySlug result above already exclude draft/
        // private/scheduled/soft-deleted content, matching the acceptance
        // criterion "buttons render only on public/published pages").
        // `canonicalUrl` (never the request's raw querystring) is the only
        // URL ever handed to the share widget.
        const shareButtonsHtml = canonicalUrl
          ? renderSocialShareButtonsHtml(
              { canonicalUrl, title: seoTitle, excerpt: metaDescription },
              resolveNewsShareConfig(),
              NEWS_SHARE_CLIENT_SCRIPT_SRC
            )
          : "";

        const bodyHtml = `<article>
  <h1>${escapeHtml(post.title)}</h1>
  <p><time datetime="${post.publishedAt.toISOString()}">${escapeHtml(post.publishedAt.toDateString())}</time></p>
  ${contentHtml}
</article>
${shareButtonsHtml}
<p><a href="${escapeHtml(basePath)}">Back to ${escapeHtml(routeSettings.publicLabel)}</a></p>`;

        const html = renderPublicPageShell({
          title: seoTitle,
          description: metaDescription,
          canonicalUrl,
          bodyHtml,
          locale: post.locale,
          ogImageUrl: seoMetadata.ogImageUrl,
          ogImageAlt: seoMetadata.ogImageAlt,
          ogImageMimeType: seoMetadata.ogImageMimeType,
          ogImageWidth: seoMetadata.ogImageWidth,
          ogImageHeight: seoMetadata.ogImageHeight,
          siteName: tenant.tenantName,
          ogType: "article",
          articlePublishedTime: post.publishedAt.toISOString(),
          articleModifiedTime: post.updatedAt.toISOString(),
          articleSection: seoMetadata.articleSection,
          articleTags: seoMetadata.articleTags,
          robotsContent: seoMetadata.robotsContent,
          structuredDataJsonLd: seoMetadata.structuredDataJsonLd
        });

        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
    );

    return result ?? notFoundHtmlResponse();
  } catch (error) {
    log("error", "public_news.detail.failed", {
      slug,
      error: error instanceof Error ? error.message : String(error)
    });
    return serverErrorHtmlResponse();
  }
};
