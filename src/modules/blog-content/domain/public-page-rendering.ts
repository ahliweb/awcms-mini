import { escapeHtml } from "../../../lib/html/escape";

/** Structural shape only (title/slug/excerpt) so this domain-layer renderer has no dependency on the application layer's concrete row types — both `PublicBlogPostSummary` (listing/archive) and `BlogSearchResultItem` (search) satisfy this. */
export type PublicPostLinkSummary = {
  title: string;
  slug: string;
  excerpt: string | null;
};

/**
 * Shared public-page HTML shell (Issue #540) — the `<head>`/SEO
 * boilerplate every public blog page needs (title, meta description,
 * canonical link, lang). Route-specific body content is built by each
 * route itself (index/detail/category/tag/search bodies genuinely
 * differ) and passed in already as safe HTML — this function only
 * escapes the head-level text fields, it does not sanitize `bodyHtml`
 * (that is `content-block-rendering.ts`'s job for post bodies, and plain
 * template string interpolation with `escapeHtml` per field for list
 * pages).
 */
export type PublicPageShellOptions = {
  title: string;
  description: string;
  canonicalUrl: string | null;
  bodyHtml: string;
  locale: string;
};

export function renderPublicPageShell(options: PublicPageShellOptions): string {
  const canonicalTag = options.canonicalUrl
    ? `<link rel="canonical" href="${escapeHtml(options.canonicalUrl)}" />`
    : "";

  return `<!doctype html>
<html lang="${escapeHtml(options.locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(options.title)}</title>
<meta name="description" content="${escapeHtml(options.description)}" />
${canonicalTag}
</head>
<body>
${options.bodyHtml}
</body>
</html>`;
}

/**
 * A list of post summaries + prev/next pagination links — shared by the
 * index, category archive, tag archive, and search result pages (Issue
 * #540) so the four route files don't each hand-roll the same list markup
 * independently.
 */
export function renderPostSummaryListHtml(
  tenantCode: string,
  posts: readonly PublicPostLinkSummary[],
  emptyMessage: string
): string {
  if (posts.length === 0) {
    return `<p>${escapeHtml(emptyMessage)}</p>`;
  }

  return posts
    .map(
      (post) => `<article>
  <h2><a href="/blog/${escapeHtml(tenantCode)}/${escapeHtml(post.slug)}">${escapeHtml(post.title)}</a></h2>
  ${post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : ""}
</article>`
    )
    .join("\n");
}

export function renderPaginationNavHtml(
  currentPage: number,
  hasNextPage: boolean,
  basePath: string
): string {
  const prevLink =
    currentPage > 1
      ? `<a href="${escapeHtml(basePath)}?page=${currentPage - 1}">Previous</a>`
      : "";
  const nextLink = hasNextPage
    ? `<a href="${escapeHtml(basePath)}?page=${currentPage + 1}">Next</a>`
    : "";

  return `<nav>${prevLink} ${nextLink}</nav>`;
}
