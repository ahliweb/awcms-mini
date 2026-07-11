import {
  fetchPublicBlogPostSummariesByIds,
  fetchPublicTermBySlug,
  listPublicBlogPosts,
  listPublicBlogPostsByTermId,
  type PublicBlogPostSummary
} from "../../blog-content/application/public-blog-directory";
import { resolveVerifiedNewsMediaReferences } from "../../blog-content/application/news-media-reference-gate";
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
 */
const EMPTY_MESSAGE = "No content available yet.";

function toPostCard(
  post: PublicBlogPostSummary,
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
  posts: readonly PublicBlogPostSummary[]
) {
  const mediaObjectIds = posts
    .map((post) => post.featuredMediaId)
    .filter((id): id is string => id !== null);

  return resolveVerifiedNewsMediaReferences(tx, tenantId, mediaObjectIds);
}

async function renderPostCards(
  tx: Bun.SQL,
  tenantId: string,
  basePath: string,
  posts: readonly PublicBlogPostSummary[]
): Promise<string> {
  const media = await resolveMediaForPosts(tx, tenantId, posts);
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
  section: HomepageSectionView
): Promise<string> {
  switch (section.sectionType) {
    case "headline": {
      const config = section.config as HeadlineSectionConfig;
      const posts = await fetchPublicBlogPostSummariesByIds(tx, tenantId, [
        config.postId
      ]);
      return renderPostCards(tx, tenantId, basePath, posts);
    }

    case "latest_posts": {
      const config = section.config as LatestPostsSectionConfig;
      let posts: PublicBlogPostSummary[];

      if (config.categorySlug) {
        const term = await fetchPublicTermBySlug(
          tx,
          tenantId,
          "category",
          config.categorySlug
        );
        posts = term
          ? (
              await listPublicBlogPostsByTermId(tx, tenantId, term.id, {
                pageSize: config.limit
              })
            ).items
          : [];
      } else {
        posts = (
          await listPublicBlogPosts(tx, tenantId, { pageSize: config.limit })
        ).items;
      }

      return renderPostCards(tx, tenantId, basePath, posts);
    }

    case "featured_posts":
    case "editor_picks": {
      const config = section.config as CuratedPostsSectionConfig;
      const posts = await fetchPublicBlogPostSummariesByIds(
        tx,
        tenantId,
        config.postIds
      );
      return renderPostCards(tx, tenantId, basePath, posts);
    }

    case "category_grid": {
      const config = section.config as CategoryGridSectionConfig;
      const groups: HomepageSectionCategoryGroup[] = [];

      for (const categorySlug of config.categorySlugs) {
        const term = await fetchPublicTermBySlug(
          tx,
          tenantId,
          "category",
          categorySlug
        );

        if (!term) {
          continue;
        }

        const posts = (
          await listPublicBlogPostsByTermId(tx, tenantId, term.id, {
            pageSize: config.postsPerCategory
          })
        ).items;
        const media = await resolveMediaForPosts(tx, tenantId, posts);

        groups.push({
          categoryName: term.name,
          categorySlug: term.slug,
          posts: posts.map((post) => toPostCard(post, media))
        });
      }

      return renderCategoryGridSectionHtml(basePath, groups, EMPTY_MESSAGE);
    }

    case "gallery_block": {
      const config = section.config as GalleryBlockSectionConfig;
      const media = await resolveVerifiedNewsMediaReferences(
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
    const bodyHtml = await renderSectionBody(tx, tenantId, basePath, section);
    rendered.push({
      sectionKey: section.sectionKey,
      sectionType: section.sectionType,
      title: section.title,
      bodyHtml
    });
  }

  return { hasSections: true, html: renderHomepageSectionsHtml(rendered) };
}
