import { isAbsoluteHttpUrl } from "./seo-validation";

/**
 * SEO field fallback resolution for public rendering (Issue #540 §SEO
 * Requirements). All three functions are pure — no I/O, no escaping (the
 * caller renders the returned string through `escapeHtml` when embedding
 * it into a `<meta>`/`<title>` tag, same separation of concerns
 * `content-block-rendering.ts` uses).
 */

const MAX_GENERATED_SUMMARY_LENGTH = 160;

export function resolveSeoTitle(post: {
  seoTitle: string | null;
  title: string;
}): string {
  return post.seoTitle && post.seoTitle.trim().length > 0
    ? post.seoTitle
    : post.title;
}

/**
 * `metaDescription -> excerpt -> generated summary from contentText`
 * (doc issue #540: "Fall back to excerpt or safe generated summary when
 * meta_description is empty"). The generated summary truncates at a word
 * boundary and never mid-entity — safe because it is plain text, not
 * markup, and still passes through `escapeHtml` at render time like every
 * other field here.
 */
export function resolveMetaDescription(post: {
  metaDescription: string | null;
  excerpt: string | null;
  contentText: string;
}): string {
  if (post.metaDescription && post.metaDescription.trim().length > 0) {
    return post.metaDescription;
  }

  if (post.excerpt && post.excerpt.trim().length > 0) {
    return post.excerpt;
  }

  return generateSummary(post.contentText, MAX_GENERATED_SUMMARY_LENGTH);
}

function generateSummary(text: string, maxLength: number): string {
  const normalized = text.trim().replace(/\s+/g, " ");

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const truncated = normalized.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  const boundary = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;

  return `${boundary}...`;
}

/**
 * `canonicalUrl` (author override) if present and still a safe absolute
 * http(s) URL, otherwise `selfUrl` (the page's own public URL) — every
 * public page emits *some* canonical, per standard SEO practice. Returns
 * `null` only if neither is a safe URL (doc issue #540: "Render canonical
 * URL only when valid and safe... Do not render unsafe URLs" — `null`
 * means the caller omits the `<link rel="canonical">` tag entirely rather
 * than emitting an unsafe one).
 */
export function resolveCanonicalUrl(
  post: { canonicalUrl: string | null },
  selfUrl: string
): string | null {
  if (post.canonicalUrl && isAbsoluteHttpUrl(post.canonicalUrl)) {
    return post.canonicalUrl;
  }

  return isAbsoluteHttpUrl(selfUrl) ? selfUrl : null;
}

/**
 * `og:image`/`twitter:image` source (Issue #636, epic `news_portal`
 * §"SEO image rendering uses verified R2 media metadata only"). Takes an
 * ALREADY-resolved public URL — resolution (looking up the post's
 * `featuredMediaId` in the news media registry, confirming it is
 * `verified`/`attached` and belongs to this tenant) is the caller's job
 * (`blog-content/application/news-media-reference-gate.ts`'s
 * `resolveVerifiedNewsMediaReferences`), never this function's, since a
 * pure `domain` function cannot perform that database round trip.
 * `null` in (no featured image, or one that didn't resolve to a safe R2
 * object — e.g. full-online R2-only mode is not active for this tenant, so
 * there is no trusted source to render from at all) means `null` out — the
 * caller omits the `og:image`/`twitter:image` tags entirely rather than
 * ever guessing at an unvalidated URL. Re-validates `isAbsoluteHttpUrl` as
 * defense-in-depth (same convention `resolveCanonicalUrl` uses), even
 * though the registry's `publicUrl` is already trusted-by-construction.
 */
export function resolveOgImageUrl(
  resolvedFeaturedMediaUrl: string | null
): string | null {
  return resolvedFeaturedMediaUrl && isAbsoluteHttpUrl(resolvedFeaturedMediaUrl)
    ? resolvedFeaturedMediaUrl
    : null;
}
