/**
 * Pure extraction of image-gallery media references from `content_json`
 * (Issue #636, epic `news_portal`). Deliberately separate from
 * `content-block-rendering.ts`'s renderer: this module answers "what does
 * this content claim to reference" (used by the application layer to
 * verify those references exist/are safe before a post/page is
 * written), while the renderer answers "how do I safely turn already-
 * write-time-validated content into HTML." Neither depends on the other.
 *
 * Only `mediaType: "image"` gallery items are in scope — `"video"` items
 * are untouched by Issue #636 (a video news thumbnail requirement is
 * Issue #639's separate, not-yet-implemented scope; forcing video items
 * through this same gate now would be building ahead of a dependency that
 * doesn't exist yet, the exact mistake this epic's other issues have
 * repeatedly documented avoiding).
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

export type GalleryImageReferenceViolation = {
  /** 0-based index of the offending item within the `gallery` block's `items` array. */
  itemIndex: number;
  reason: "raw_url_not_allowed" | "media_object_id_missing_or_malformed";
  /**
   * The offending raw `url` value, only present when `reason` is
   * `"raw_url_not_allowed"` (Issue #640, content quality checklist) — lets a
   * caller classify the violation as a local path vs. an arbitrary external
   * URL (`content-quality-checklist.ts`'s `classifyRawImageUrl`) without a
   * second traversal of `contentJson` that could drift from this one.
   */
  rawUrl?: string;
};

export type GalleryImageReferences = {
  /** Deduplicated, well-formed-UUID `mediaObjectId`s referenced by image gallery items — candidates for existence/status verification. */
  mediaObjectIds: string[];
  /** Items that cannot possibly be valid in full-online R2-only mode, independent of whether any `mediaObjectId` actually resolves. */
  violations: GalleryImageReferenceViolation[];
};

/**
 * Scans every `gallery` block's `items` for `mediaType: "image"` entries.
 * Deliberately tolerant of malformed/unknown shapes elsewhere in
 * `contentJson` (mirrors `content-block-rendering.ts`'s own "skip, don't
 * throw" convention) — this function's job is only to enumerate what a
 * caller must verify, not to fully validate `contentJson`'s shape (that
 * remains `validateContentJsonField`'s job).
 */
export function collectGalleryImageReferences(
  contentJson: Record<string, unknown>
): GalleryImageReferences {
  const mediaObjectIds = new Set<string>();
  const violations: GalleryImageReferenceViolation[] = [];

  const blocks = contentJson.blocks;
  if (!isRecordArray(blocks)) {
    return { mediaObjectIds: [], violations: [] };
  }

  for (const block of blocks) {
    if (block.type !== "gallery" || !isRecordArray(block.items)) {
      continue;
    }

    block.items.forEach((item, itemIndex) => {
      if (item.mediaType !== "image") {
        return;
      }

      if (typeof item.url === "string" && item.url.trim().length > 0) {
        violations.push({
          itemIndex,
          reason: "raw_url_not_allowed",
          rawUrl: item.url
        });
        return;
      }

      if (
        typeof item.mediaObjectId !== "string" ||
        !UUID_PATTERN.test(item.mediaObjectId)
      ) {
        violations.push({
          itemIndex,
          reason: "media_object_id_missing_or_malformed"
        });
        return;
      }

      mediaObjectIds.add(item.mediaObjectId);
    });
  }

  return { mediaObjectIds: [...mediaObjectIds], violations };
}
