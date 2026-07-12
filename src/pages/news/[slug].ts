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
import { newsMediaPortAdapter } from "../../modules/news-portal/application/news-media-port-adapter";
import { resolveNewsShareConfig } from "../../modules/news-portal/domain/news-share-config";
import {
  collectRenderableGalleryMediaObjectIds,
  collectRenderableVideoNewsThumbnailMediaObjectIds,
  renderContentJsonToHtml
} from "../../modules/blog-content/domain/content-block-rendering";
import { renderContentHtmlWithInternalTagLinks } from "../../modules/blog-content/application/internal-tag-link-rendering";
import {
  resolveCanonicalUrl,
  resolveMetaDescription,
  resolveOgImageUrl,
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

        // Issue #636 — resolve every mediaObjectId this post's content
        // could reference (featured image + gallery blocks) to verified R2
        // media metadata in ONE bulk lookup, then thread the result into
        // both the gallery renderer and the og:image tags. An id that
        // isn't `verified`/`attached`/same-tenant simply never appears in
        // `resolvedMedia` — never rendered, never thrown. Issue #639 adds
        // `video_news` blocks' optional thumbnail ids to the SAME bulk
        // lookup — they share the same news-media-registry id space, so
        // `renderContentJsonToHtml`'s single `resolvedMediaUrls` map
        // already serves both the gallery `<img>` and the video thumbnail.
        const galleryMediaObjectIds = collectRenderableGalleryMediaObjectIds(
          post.contentJson
        );
        const videoThumbnailMediaObjectIds =
          collectRenderableVideoNewsThumbnailMediaObjectIds(post.contentJson);
        const referencedMediaObjectIds = post.featuredMediaId
          ? [
              post.featuredMediaId,
              ...galleryMediaObjectIds,
              ...videoThumbnailMediaObjectIds
            ]
          : [...galleryMediaObjectIds, ...videoThumbnailMediaObjectIds];
        const resolvedMedia = await newsMediaPortAdapter.resolveMediaReferences(
          tx,
          tenant.tenantId,
          referencedMediaObjectIds
        );
        const resolvedGalleryUrls = new Map(
          [...resolvedMedia].map(([id, media]) => [id, media.publicUrl])
        );
        const featuredMedia = post.featuredMediaId
          ? (resolvedMedia.get(post.featuredMediaId) ?? null)
          : null;

        const renderedContentHtml = renderContentJsonToHtml(
          post.contentJson,
          resolvedGalleryUrls
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
          ogImageUrl: resolveOgImageUrl(featuredMedia?.publicUrl ?? null),
          ogImageAlt: featuredMedia?.altText ?? null,
          siteName: tenant.tenantName
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
