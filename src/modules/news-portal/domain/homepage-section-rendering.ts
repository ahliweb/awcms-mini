import { escapeHtml } from "../../../lib/html/escape";
import {
  renderGalleryBlockHtml,
  type ResolvedGalleryMediaUrls
} from "../../_shared/rendering/gallery-block-renderer";

/**
 * Whitelist-based HTML renderer for editorial homepage sections (Issue
 * #637). Every function here only ever emits text through `escapeHtml` (or
 * delegates to `_shared/rendering/gallery-block-renderer.ts`'s
 * already-whitelisted gallery renderer for `gallery_block`) — there is no
 * raw-HTML field on any section `config`, so this renderer cannot emit a
 * `<script>`/`<iframe>`/`<embed>` tag no matter what a section's
 * `config_json` contains. Same "degrade, don't 500" convention as
 * `blog-content/domain/content-block-rendering.ts`/
 * `public-page-rendering.ts`: a section whose curated references have since
 * become unpublished/unverified renders its configured empty state, never
 * a broken link or a thrown error.
 *
 * Issue #681 (epic #679) — this file used to call
 * `blog-content/domain/content-block-rendering.ts`'s
 * `renderContentJsonToHtml` directly (wrapping media ids in a synthetic
 * `{blocks: [{type: "gallery", items: [...]}]}` shape purely to reuse its
 * gallery renderer), a genuine domain-to-domain cross-module import. Now
 * calls the shared, neutral `renderGalleryBlockHtml` directly — no
 * synthetic wrapping needed, and no import of `blog-content` anywhere in
 * this module's `domain`/`application` tree.
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

/** `gallery_block` — reuses the shared, neutral gallery renderer verbatim (same code path a post's own gallery block uses) rather than emitting `<img>` tags independently here, so there is exactly one place in the codebase that decides how a gallery of `mediaObjectId`s becomes HTML. */
export function renderGalleryBlockSectionHtml(
  mediaObjectIds: readonly string[],
  caption: string | null,
  resolvedMediaUrls: ResolvedGalleryMediaUrls,
  emptyMessage: string
): string {
  const html = renderGalleryBlockHtml(
    mediaObjectIds.map((mediaObjectId) => ({
      mediaType: "image" as const,
      mediaObjectId,
      caption: caption ?? undefined
    })),
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
