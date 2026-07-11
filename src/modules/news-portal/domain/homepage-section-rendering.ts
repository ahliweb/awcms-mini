import { escapeHtml } from "../../../lib/html/escape";
import {
  renderContentJsonToHtml,
  type ResolvedGalleryMediaUrls
} from "../../blog-content/domain/content-block-rendering";

/**
 * Whitelist-based HTML renderer for editorial homepage sections (Issue
 * #637). Every function here only ever emits text through `escapeHtml` (or
 * delegates to `content-block-rendering.ts`'s already-whitelisted gallery
 * renderer for `gallery_block`) — there is no raw-HTML field on any section
 * `config`, so this renderer cannot emit a `<script>`/`<iframe>`/`<embed>`
 * tag no matter what a section's `config_json` contains. Same "degrade,
 * don't 500" convention as `content-block-rendering.ts`/
 * `public-page-rendering.ts`: a section whose curated references have since
 * become unpublished/unverified renders its configured empty state, never
 * a broken link or a thrown error.
 */
export type HomepageSectionPostCard = {
  title: string;
  slug: string;
  excerpt: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
};

function renderPostCard(
  basePath: string,
  card: HomepageSectionPostCard
): string {
  const image = card.imageUrl
    ? `<img src="${escapeHtml(card.imageUrl)}" alt="${escapeHtml(card.imageAlt ?? "")}" loading="lazy">`
    : "";
  const excerpt = card.excerpt ? `<p>${escapeHtml(card.excerpt)}</p>` : "";

  return `<article class="homepage-section-post">
  ${image}
  <h3><a href="${escapeHtml(basePath)}/${escapeHtml(card.slug)}">${escapeHtml(card.title)}</a></h3>
  ${excerpt}
</article>`;
}

/** `headline`/`featured_posts`/`editor_picks`/`latest_posts` share this body renderer — a flat list of cards, empty state when the resolved list is empty (every curated id turned out unpublished/cross-tenant, or a chronological query genuinely had nothing to show). */
export function renderPostCardListHtml(
  basePath: string,
  cards: readonly HomepageSectionPostCard[],
  emptyMessage: string
): string {
  if (cards.length === 0) {
    return `<p class="homepage-section-empty">${escapeHtml(emptyMessage)}</p>`;
  }

  return `<div class="homepage-section-posts">
${cards.map((card) => renderPostCard(basePath, card)).join("\n")}
</div>`;
}

export type HomepageSectionCategoryGroup = {
  categoryName: string;
  categorySlug: string;
  posts: readonly HomepageSectionPostCard[];
};

/** `category_grid` — one card list per category, category name as a sub-heading; a category with zero currently-published posts still renders its (empty) group rather than being silently dropped, so admins can see their configured grid is wired up correctly. */
export function renderCategoryGridSectionHtml(
  basePath: string,
  groups: readonly HomepageSectionCategoryGroup[],
  emptyMessage: string
): string {
  return `<div class="homepage-section-category-grid">
${groups
  .map(
    (group) => `<div class="homepage-section-category-group">
  <h3>${escapeHtml(group.categoryName)}</h3>
  ${renderPostCardListHtml(basePath, group.posts, emptyMessage)}
</div>`
  )
  .join("\n")}
</div>`;
}

/** `gallery_block` — reuses `content-block-rendering.ts`'s already-whitelisted gallery renderer verbatim (same code path a post's own gallery block uses) rather than emitting `<img>` tags independently here, so there is exactly one place in the codebase that decides how a gallery of `mediaObjectId`s becomes HTML. */
export function renderGalleryBlockSectionHtml(
  mediaObjectIds: readonly string[],
  caption: string | null,
  resolvedMediaUrls: ResolvedGalleryMediaUrls,
  emptyMessage: string
): string {
  const html = renderContentJsonToHtml(
    {
      blocks: [
        {
          type: "gallery",
          items: mediaObjectIds.map((mediaObjectId) => ({
            mediaType: "image",
            mediaObjectId,
            caption: caption ?? undefined
          }))
        }
      ]
    },
    resolvedMediaUrls
  );

  return (
    html || `<p class="homepage-section-empty">${escapeHtml(emptyMessage)}</p>`
  );
}

export type RenderedHomepageSection = {
  sectionKey: string;
  sectionType: string;
  title: string | null;
  bodyHtml: string;
};

function renderSectionShell(section: RenderedHomepageSection): string {
  const heading = section.title ? `<h2>${escapeHtml(section.title)}</h2>` : "";

  return `<section class="homepage-section homepage-section-${escapeHtml(section.sectionType)}" data-section-key="${escapeHtml(section.sectionKey)}">
${heading}
${section.bodyHtml}
</section>`;
}

/** Composes every already-rendered section (in the caller-supplied order — `sort_order`) into the `/news` homepage body. */
export function renderHomepageSectionsHtml(
  sections: readonly RenderedHomepageSection[]
): string {
  return sections.map(renderSectionShell).join("\n");
}
