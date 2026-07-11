import type {
  PublicContentPort,
  PublicContentPostSummaryDTO
} from "../../_shared/ports/public-content-port";
import type { NewsMediaPort } from "../../_shared/ports/news-media-port";
import {
  renderCategoryGridSectionHtml,
  renderGalleryBlockSectionHtml,
  renderHomepageSectionsHtml,
  renderPostCardListHtml,
  type HomepageSectionCategoryGroup,
  type HomepageSectionPostCard,
  type RenderedHomepageSection
} from "../domain/homepage-section-rendering";
import {
  listActiveHomepageSectionsForRendering,
  type HomepageSectionView
} from "./homepage-section-directory";
import type {
  CategoryGridSectionConfig,
  CuratedPostsSectionConfig,
  GalleryBlockSectionConfig,
  HeadlineSectionConfig,
  LatestPostsSectionConfig
} from "../domain/homepage-section-policy";

/**
 * Orchestrates Issue #637's editorial homepage: fetches every active
 * section for the tenant (`listActiveHomepageSectionsForRendering`), then
 * for EACH section re-resolves its `config`'s references against current,
 * live public/verified data — never trusting that a reference validated at
 * save time is still valid now (a curated post could have been
 * unpublished, a category deleted, a media object soft-deleted since).
 * This is the only place in the module that turns a `HomepageSectionView`
 * into rendered HTML; `/news/index.ts` calls only
 * `composeHomepageSectionsHtml`, never the per-type renderers directly.
 *
 * Issue #681 (epic #679, platform-hardening) — `contentPort`/`mediaPort`
 * are caller-injected (`_shared/ports/public-content-port.ts`/
 * `news-media-port.ts`) rather than this file importing `blog-content`'s
 * application layer directly (as it did before this issue, for post/term
 * queries AND for `resolveVerifiedNewsMediaReferences`, which — before
 * this issue — lived in `blog-content` despite being purely a
 * `news_portal` media-registry concern). The route handler
 * (`/news/index.ts`) is the composition root: it imports the concrete
 * `blog-content`/`news-portal` adapters and passes them in here.
 */
const EMPTY_MESSAGE = "No content available yet.";

function toPostCard(
  post: PublicContentPostSummaryDTO,
  media: ReadonlyMap<string, { publicUrl: string; altText: string | null }>
): HomepageSectionPostCard {
  const resolved = post.featuredMediaId
    ? (media.get(post.featuredMediaId) ?? null)
    : null;

  return {
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    imageUrl: resolved?.publicUrl ?? null,
    imageAlt: resolved?.altText ?? null
  };
}

async function resolveMediaForPosts(
  tx: Bun.SQL,
  tenantId: string,
  posts: readonly PublicContentPostSummaryDTO[],
  mediaPort: NewsMediaPort
) {
  const mediaObjectIds = posts
    .map((post) => post.featuredMediaId)
    .filter((id): id is string => id !== null);

  return mediaPort.resolveMediaReferences(tx, tenantId, mediaObjectIds);
}

async function renderPostCards(
  tx: Bun.SQL,
  tenantId: string,
  basePath: string,
  posts: readonly PublicContentPostSummaryDTO[],
  mediaPort: NewsMediaPort
): Promise<string> {
  const media = await resolveMediaForPosts(tx, tenantId, posts, mediaPort);
  return renderPostCardListHtml(
    basePath,
    posts.map((post) => toPostCard(post, media)),
    EMPTY_MESSAGE
  );
}

async function renderSectionBody(
  tx: Bun.SQL,
  tenantId: string,
  basePath: string,
  section: HomepageSectionView,
  contentPort: PublicContentPort,
  mediaPort: NewsMediaPort
): Promise<string> {
  switch (section.sectionType) {
    case "headline": {
      const config = section.config as HeadlineSectionConfig;
      const posts = await contentPort.fetchPostSummariesByIds(tx, tenantId, [
        config.postId
      ]);
      return renderPostCards(tx, tenantId, basePath, posts, mediaPort);
    }

    case "latest_posts": {
      const config = section.config as LatestPostsSectionConfig;
      let posts: PublicContentPostSummaryDTO[];

      if (config.categorySlug) {
        const category = await contentPort.fetchCategoryBySlug(
          tx,
          tenantId,
          config.categorySlug
        );
        posts = category
          ? (
              await contentPort.listPostsByCategoryId(
                tx,
                tenantId,
                category.id,
                { pageSize: config.limit }
              )
            ).items.slice()
          : [];
      } else {
        posts = (
          await contentPort.listPosts(tx, tenantId, {
            pageSize: config.limit
          })
        ).items.slice();
      }

      return renderPostCards(tx, tenantId, basePath, posts, mediaPort);
    }

    case "featured_posts":
    case "editor_picks": {
      const config = section.config as CuratedPostsSectionConfig;
      const posts = await contentPort.fetchPostSummariesByIds(
        tx,
        tenantId,
        config.postIds
      );
      return renderPostCards(tx, tenantId, basePath, posts, mediaPort);
    }

    case "category_grid": {
      const config = section.config as CategoryGridSectionConfig;
      const groups: HomepageSectionCategoryGroup[] = [];

      for (const categorySlug of config.categorySlugs) {
        const category = await contentPort.fetchCategoryBySlug(
          tx,
          tenantId,
          categorySlug
        );

        if (!category) {
          continue;
        }

        const posts = (
          await contentPort.listPostsByCategoryId(tx, tenantId, category.id, {
            pageSize: config.postsPerCategory
          })
        ).items;
        const media = await resolveMediaForPosts(
          tx,
          tenantId,
          posts,
          mediaPort
        );

        groups.push({
          categoryName: category.name,
          categorySlug: category.slug,
          posts: posts.map((post) => toPostCard(post, media))
        });
      }

      return renderCategoryGridSectionHtml(basePath, groups, EMPTY_MESSAGE);
    }

    case "gallery_block": {
      const config = section.config as GalleryBlockSectionConfig;
      const media = await mediaPort.resolveMediaReferences(
        tx,
        tenantId,
        config.mediaObjectIds
      );
      const resolvedUrls = new Map(
        [...media].map(([id, entry]) => [id, entry.publicUrl])
      );
      return renderGalleryBlockSectionHtml(
        config.mediaObjectIds,
        config.caption,
        resolvedUrls,
        EMPTY_MESSAGE
      );
    }

    default:
      return "";
  }
}

export type ComposedHomepageSections = {
  hasSections: boolean;
  html: string;
};

/** `hasSections: false` (no enabled/in-schedule-window rows for this tenant) is the signal `/news/index.ts` uses to fall back to the pre-#637 plain post list — this feature is additive, not a replacement, for tenants that never configure a homepage. */
export async function composeHomepageSectionsHtml(
  tx: Bun.SQL,
  tenantId: string,
  basePath: string,
  contentPort: PublicContentPort,
  mediaPort: NewsMediaPort,
  now: Date = new Date()
): Promise<ComposedHomepageSections> {
  const sections = await listActiveHomepageSectionsForRendering(
    tx,
    tenantId,
    now
  );

  if (sections.length === 0) {
    return { hasSections: false, html: "" };
  }

  const rendered: RenderedHomepageSection[] = [];

  for (const section of sections) {
    const bodyHtml = await renderSectionBody(
      tx,
      tenantId,
      basePath,
      section,
      contentPort,
      mediaPort
    );
    rendered.push({
      sectionKey: section.sectionKey,
      sectionType: section.sectionType,
      title: section.title,
      bodyHtml
    });
  }

  return { hasSections: true, html: renderHomepageSectionsHtml(rendered) };
}
