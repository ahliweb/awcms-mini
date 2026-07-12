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
  /**
   * Issue #636 — an already-resolved, verified R2 media object public URL
   * (`seo-rendering.ts`'s `resolveOgImageUrl`), or `null` to omit
   * `og:image`/`twitter:image` entirely. Never a raw/unvalidated URL.
   */
  ogImageUrl?: string | null;
  /** Alt text for the `og:image`, from the same verified media object (`altText`) — omitted if there is no image or no alt text set. */
  ogImageAlt?: string | null;
  /**
   * Issue #642 — tenant-specific site name (`PublicTenantResolution.tenantName`)
   * rendered as `og:site_name`. Omitted (no tag) when not provided — every
   * existing caller predates this option and stays behavior-identical.
   */
  siteName?: string | null;
};

/**
 * `og:title`/`og:description`/`og:url` + `twitter:title`/`twitter:description`/
 * `twitter:card` (Issue #642 — "Open Graph/Twitter Card metadata" for public
 * social share previews). Derived from the SAME `title`/`description`/
 * `canonicalUrl` this shell already renders as `<title>`/
 * `<meta name="description">`/`<link rel="canonical">` — one source of
 * truth per field, never a second copy that could drift. `og:url` is
 * omitted (like the canonical link) when `canonicalUrl` is `null` (no safe
 * URL to point crawlers at). `twitter:card` is always emitted — unlike
 * `og:image`/`twitter:image` (still gated on a verified R2 image existing,
 * per Issue #636's R2-only policy), a text-only `summary` card is always
 * safe to advertise; it upgrades to `summary_large_image` once an image is
 * present.
 */
function renderOpenGraphMetaTags(options: PublicPageShellOptions): string {
  const tags = [
    `<meta property="og:title" content="${escapeHtml(options.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(options.description)}" />`,
    options.canonicalUrl
      ? `<meta property="og:url" content="${escapeHtml(options.canonicalUrl)}" />`
      : "",
    options.siteName
      ? `<meta property="og:site_name" content="${escapeHtml(options.siteName)}" />`
      : "",
    `<meta name="twitter:card" content="${options.ogImageUrl ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${escapeHtml(options.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(options.description)}" />`,
    options.ogImageUrl
      ? `<meta property="og:image" content="${escapeHtml(options.ogImageUrl)}" />`
      : "",
    options.ogImageUrl
      ? `<meta name="twitter:image" content="${escapeHtml(options.ogImageUrl)}" />`
      : "",
    options.ogImageUrl && options.ogImageAlt
      ? `<meta property="og:image:alt" content="${escapeHtml(options.ogImageAlt)}" />`
      : ""
  ];

  return tags.filter((tag) => tag.length > 0).join("\n");
}

export function renderPublicPageShell(options: PublicPageShellOptions): string {
  const canonicalTag = options.canonicalUrl
    ? `<link rel="canonical" href="${escapeHtml(options.canonicalUrl)}" />`
    : "";

  const ogTags = renderOpenGraphMetaTags(options);

  return `<!doctype html>
<html lang="${escapeHtml(options.locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(options.title)}</title>
<meta name="description" content="${escapeHtml(options.description)}" />
${canonicalTag}
${ogTags}
</head>
<body>
${options.bodyHtml}
</body>
</html>`;
}

/**
 * A list of post summaries + prev/next pagination links — shared by the
 * index, category archive, tag archive, and search result pages (Issue
 * #540, extended to `/news` in Issue #560) so route files don't each
 * hand-roll the same list markup independently. `basePath` is the public
 * listing root each post detail link is built under (`/blog/{tenantCode}`
 * for the legacy per-tenant-code routes, `/news` for Issue #560's routes) —
 * `renderPostSummaryListHtml` below is the pre-existing `/blog/{tenantCode}`
 * convenience wrapper, kept byte-for-byte behavior-identical (same
 * `escapeHtml` semantics apply whether the tenant code is escaped on its
 * own or as part of the whole base path string) so no existing call site
 * needed to change.
 */
export function renderPostSummaryListHtmlAtBasePath(
  basePath: string,
  posts: readonly PublicPostLinkSummary[],
  emptyMessage: string
): string {
  if (posts.length === 0) {
    return `<p>${escapeHtml(emptyMessage)}</p>`;
  }

  return posts
    .map(
      (post) => `<article>
  <h2><a href="${escapeHtml(basePath)}/${escapeHtml(post.slug)}">${escapeHtml(post.title)}</a></h2>
  ${post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : ""}
</article>`
    )
    .join("\n");
}

/** `/blog/{tenantCode}` convenience wrapper — see `renderPostSummaryListHtmlAtBasePath` above. */
export function renderPostSummaryListHtml(
  tenantCode: string,
  posts: readonly PublicPostLinkSummary[],
  emptyMessage: string
): string {
  return renderPostSummaryListHtmlAtBasePath(
    `/blog/${tenantCode}`,
    posts,
    emptyMessage
  );
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
