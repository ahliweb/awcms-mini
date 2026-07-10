import { escapeHtml } from "../../../lib/html/escape";
import { isAbsoluteHttpUrl } from "./seo-validation";
import { collectGalleryImageReferences } from "./content-block-media-references";

/**
 * Safe, whitelist-based renderer for `content_json` (Issue #540 §Content
 * Safety Requirements: "Use structured JSON content as the source of
 * truth", "Rendering must sanitize or safely render content", "Script
 * tags/inline JavaScript/dangerous iframe-embed must be rejected or
 * stripped"). `content_json` was already write-time-rejected for unsafe
 * markup (`validateContentJsonField`, Issue #538) — this is the
 * *rendering*-side defense-in-depth layer: every block type in the
 * whitelist below only ever emits text through `escapeHtml`, and any
 * value outside the whitelist (unknown block `type`, non-string `text`,
 * raw HTML field, etc.) is silently skipped rather than rendered. There
 * is no "raw html" block type — by construction, this renderer cannot
 * emit a `<script>`/`<iframe>`/`<embed>`/`<object>` tag or an inline
 * event handler no matter what `content_json` contains.
 *
 * This is the first place in the repo that defines a concrete shape for
 * `content_json` (previously "opaque to the API", doc issue #537/#538) —
 * `{ blocks: ContentBlock[] }` with five block types (paragraph, heading,
 * list, quote, and gallery — the latter added by Issue #542 for public
 * image/video display, deliberately not a new media-library table since
 * there is no base media library to integrate with beyond a loose URL, see
 * `sql/029_awcms_mini_blog_content_presentation_schema.sql`'s header
 * comment). A derived app or later issue needing richer blocks (embed,
 * table, ...) extends the `switch` below, not a general raw-HTML escape
 * hatch.
 */
export type GalleryItem = {
  mediaType: "image" | "video";
  /** Legacy/non-R2-only-mode shape — a raw absolute URL. Mutually exclusive with `mediaObjectId` in practice (Issue #636 write-time validation rejects both being used together in full-online R2-only mode), but this renderer tolerates either being present. */
  url?: string;
  /** Issue #636 (full-online R2-only mode) shape — a verified news media registry object id. Resolved to a public URL via `resolvedMediaUrls` at render time; unresolved (or resolver not provided) silently skips the item, same "degrade, don't 500" convention as every other malformed item here. */
  mediaObjectId?: string;
  caption?: string;
};

/** `mediaObjectId -> public URL` for gallery items using the Issue #636 R2-only-mode reference shape — built by the caller (`resolveVerifiedNewsMediaReferences`, `blog-content/application/news-media-reference-gate.ts`) BEFORE rendering, since resolving a registry id requires a database round trip this renderer deliberately never performs itself (kept pure, same as every other function in this file). */
export type ResolvedGalleryMediaUrls = ReadonlyMap<string, string>;

export type ContentBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "gallery"; items: GalleryItem[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderParagraph(text: unknown): string | null {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }

  return `<p>${escapeHtml(text)}</p>`;
}

function renderHeading(level: unknown, text: unknown): string | null {
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    typeof level !== "number" ||
    !Number.isInteger(level) ||
    level < 1 ||
    level > 6
  ) {
    return null;
  }

  return `<h${level}>${escapeHtml(text)}</h${level}>`;
}

function renderList(ordered: unknown, items: unknown): string | null {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const listItems = items
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0
    )
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");

  if (listItems.length === 0) {
    return null;
  }

  const tag = ordered === true ? "ol" : "ul";
  return `<${tag}>${listItems}</${tag}>`;
}

function renderQuote(text: unknown): string | null {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }

  return `<blockquote>${escapeHtml(text)}</blockquote>`;
}

/**
 * Gallery block (Issue #542 §Media/Gallery: "Support image and video
 * gallery display. Validate allowed file/media references."). Two mutually
 * exclusive image sources, both defense-in-depth re-checked at render time
 * (never trusting write-time validation alone):
 *
 * - `url` (legacy/non-R2-only-mode shape) — re-validated `isAbsoluteHttpUrl`
 *   (same defense-in-depth convention `resolveCanonicalUrl` uses).
 * - `mediaObjectId` (Issue #636, full-online R2-only mode) — looked up in
 *   `resolvedMediaUrls`, which the CALLER must have already populated via
 *   `resolveVerifiedNewsMediaReferences` (a real, `verified`/`attached`,
 *   same-tenant registry row) — an id absent from that map (never resolved,
 *   or resolved to an unsafe status) renders nothing for this item, the
 *   same "degrade, don't 500" convention every other block here follows.
 *
 * `<img>`/`<video controls>` only — no `<iframe>`/embed, so a gallery item
 * can never become an arbitrary-origin embed.
 */
function renderGalleryItem(
  item: unknown,
  resolvedMediaUrls: ResolvedGalleryMediaUrls
): string | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return null;
  }

  const record = item as Record<string, unknown>;

  if (record.mediaType !== "image" && record.mediaType !== "video") {
    return null;
  }

  let resolvedUrl: string | null = null;

  if (typeof record.mediaObjectId === "string") {
    resolvedUrl = resolvedMediaUrls.get(record.mediaObjectId) ?? null;
  } else if (typeof record.url === "string" && isAbsoluteHttpUrl(record.url)) {
    resolvedUrl = record.url;
  }

  if (resolvedUrl === null) {
    return null;
  }

  const url = escapeHtml(resolvedUrl);
  const caption =
    typeof record.caption === "string" && record.caption.trim().length > 0
      ? `<figcaption>${escapeHtml(record.caption)}</figcaption>`
      : "";
  const media =
    record.mediaType === "image"
      ? `<img src="${url}" alt="${caption ? escapeHtml(record.caption as string) : ""}">`
      : `<video src="${url}" controls></video>`;

  return `<figure>${media}${caption}</figure>`;
}

function renderGallery(
  items: unknown,
  resolvedMediaUrls: ResolvedGalleryMediaUrls
): string | null {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const rendered = items
    .map((item) => renderGalleryItem(item, resolvedMediaUrls))
    .filter((html): html is string => html !== null);

  if (rendered.length === 0) {
    return null;
  }

  return `<div class="gallery">${rendered.join("\n")}</div>`;
}

function renderBlock(
  block: unknown,
  resolvedMediaUrls: ResolvedGalleryMediaUrls
): string | null {
  if (!isRecord(block)) {
    return null;
  }

  switch (block.type) {
    case "paragraph":
      return renderParagraph(block.text);
    case "heading":
      return renderHeading(block.level, block.text);
    case "list":
      return renderList(block.ordered, block.items);
    case "quote":
      return renderQuote(block.text);
    case "gallery":
      return renderGallery(block.items, resolvedMediaUrls);
    default:
      return null;
  }
}

const EMPTY_RESOLVED_MEDIA_URLS: ResolvedGalleryMediaUrls = new Map();

/**
 * Renders `contentJson.blocks` to a safe HTML string. Malformed/unknown
 * blocks are silently skipped, never thrown — a corrupt or unexpected
 * shape must degrade to "renders less", not a 500 with a stack trace (doc
 * issue #540: "Error output must not expose stack traces").
 *
 * `resolvedMediaUrls` (Issue #636) defaults to empty, which is the correct
 * behavior for every existing call site that hasn't been updated to
 * resolve `mediaObjectId`-based gallery items — those items simply render
 * nothing (never a broken `<img>` tag), while `url`-based items are
 * entirely unaffected either way.
 */
export function renderContentJsonToHtml(
  contentJson: Record<string, unknown>,
  resolvedMediaUrls: ResolvedGalleryMediaUrls = EMPTY_RESOLVED_MEDIA_URLS
): string {
  const blocks = contentJson.blocks;

  if (!Array.isArray(blocks)) {
    return "";
  }

  return blocks
    .map((block) => renderBlock(block, resolvedMediaUrls))
    .filter((html): html is string => html !== null)
    .join("\n");
}

/**
 * Extracts every well-formed `mediaObjectId` an image gallery item
 * references, so a caller can resolve them
 * (`resolveVerifiedNewsMediaReferences`) BEFORE calling
 * `renderContentJsonToHtml` — this renderer is synchronous/pure and cannot
 * itself perform the database round trip resolution requires. Thin
 * re-export of `content-block-media-references.ts`'s
 * `collectGalleryImageReferences` (its write-time violation list is
 * irrelevant here — already-written content is trusted to have passed
 * write-time validation — only the id list matters for render-time
 * resolution), kept as one traversal instead of two so the definition of
 * "which gallery items reference a media object" can never drift between
 * write-time validation and render-time resolution.
 */
export function collectRenderableGalleryMediaObjectIds(
  contentJson: Record<string, unknown>
): string[] {
  return collectGalleryImageReferences(contentJson).mediaObjectIds;
}
