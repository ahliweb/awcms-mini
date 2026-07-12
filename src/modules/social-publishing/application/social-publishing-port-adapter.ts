import type { NewsMediaPort } from "../../_shared/ports/news-media-port";
import type {
  ArticlePublishedEventInput,
  ArticlePublishedPortResult,
  SocialPublishingPort
} from "../../_shared/ports/social-publishing-port";
import { fetchEffectivePublicRouteSettings } from "../../blog-content/application/public-route-settings";
import { createSocialPublishJobsForArticle } from "./create-social-publish-jobs";

/**
 * Concrete `SocialPublishingPort` implementation (Issue #643). A FACTORY,
 * not a ready-made singleton — see `_shared/ports/social-publishing-port.ts`'s
 * header comment for why: this adapter needs `news_portal`'s `NewsMediaPort`
 * to resolve a verified R2 image URL, but `social_publishing/application`
 * must never import `news_portal`'s concrete adapter directly (the same
 * anti-pattern Issue #681 fixed for `blog_content`/`news_portal`). Only the
 * TRUE composition root (`pages/api/v1/blog/posts/[id]/publish.ts`,
 * `scripts/blog-scheduled-publish.ts`) calls
 * `createSocialPublishingPortAdapter(newsMediaPortAdapter)`.
 *
 * This file DOES import `blog_content`'s `public-route-settings.ts` — that
 * is allowed: `blog_content` is the CONSUMER of this port (it calls
 * `onArticlePublished`), and this adapter needs `blog_content`'s own
 * `fetchEffectivePublicRouteSettings` to resolve `publicBasePath` for the
 * canonical URL. The structural module-boundary test
 * (`tests/unit/module-boundary.test.ts`) only governs the
 * `blog_content`<->`news_portal` pair; there is no equivalent boundary
 * (yet) between `social_publishing` and `blog_content`, and this direction
 * (social_publishing reading a small, stable, read-only settings getter
 * from blog_content) is much lower-risk than social_publishing importing
 * news_portal's media adapter (which would recreate the exact multi-hop
 * cross-module coupling #681 eliminated). Kept intentionally narrow — only
 * this one function is imported, never `blog_content`'s own directories.
 */
export function createSocialPublishingPortAdapter(
  mediaPort: NewsMediaPort
): SocialPublishingPort {
  return {
    async onArticlePublished(
      tx: Bun.SQL,
      tenantId: string,
      event: ArticlePublishedEventInput,
      correlationId?: string
    ): Promise<ArticlePublishedPortResult> {
      const routeSettings = await fetchEffectivePublicRouteSettings(
        tx,
        tenantId
      );

      const result = await createSocialPublishJobsForArticle(
        tx,
        tenantId,
        {
          id: event.articleId,
          title: event.title,
          slug: event.slug,
          excerpt: event.excerpt,
          featuredMediaId: event.featuredMediaId,
          publicBasePath: routeSettings.publicBasePath
        },
        event.trigger,
        mediaPort,
        process.env,
        correlationId
      );

      return { jobsCreated: result.jobsCreated };
    }
  };
}
