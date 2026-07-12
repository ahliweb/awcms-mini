/**
 * Application-layer orchestration for Issue #640's content quality
 * checklist — the database/port-touching half of `content-quality-
 * checklist.ts`'s pure evaluator, same split as `news-media-reference-
 * gate.ts` (Issue #636) uses for the same reason: `domain` stays pure/
 * synchronously testable, this file does the real DB round trips and is
 * injected the caller's `NewsMediaPort` (never imports `news_portal`
 * directly — see `_shared/ports/news-media-port.ts`'s header and
 * `tests/unit/module-boundary.test.ts`).
 *
 * Called from THREE composition roots (route handlers/scripts, per
 * ADR-0011): `POST /api/v1/blog/posts/{id}/publish`,
 * `POST /api/v1/blog/posts/{id}/schedule`, and the scheduled-publish worker
 * (`blog-scheduled-publish.ts`) — each injects `newsMediaPortAdapter` from
 * `news-portal/application/news-media-port-adapter.ts`. Also called
 * read-only by the `GET .../quality-checklist` preview endpoints (posts AND
 * pages) that back the admin editor's checklist panel (Issue #640
 * acceptance criterion: "Checklist is available in admin post/page
 * editor").
 */
import { collectGalleryImageReferences } from "../domain/content-block-media-references";
import {
  evaluateContentQualityChecklist,
  notApplicableChecklistResult,
  type ChecklistContentKind,
  type ChecklistPolicyOverrides,
  type ContentQualityChecklistResult
} from "../domain/content-quality-checklist";
import type { NewsMediaPort } from "../../_shared/ports/news-media-port";

export type ChecklistEvaluableContent = {
  title: string;
  slug: string;
  excerpt: string | null;
  metaDescription: string | null;
  contentText: string;
  contentJson: Record<string, unknown>;
  featuredMediaId: string | null;
};

export type EvaluateContentQualityChecklistOptions = {
  /** Present (non-null) only for the "schedule" action's own request body — `null` for an immediate publish or the scheduled-publish worker's due-post re-check. */
  scheduledAt?: Date | null;
  now?: Date;
};

/**
 * `termCount` is the caller's job to fetch (`fetchPostTermIds(tx, tenantId,
 * postId).length`, `blog-taxonomy-directory.ts`) — this file doesn't take a
 * `postId` at all, only content values, so it can also serve the "preview
 * before the post exists yet" case a future admin UI draft-preview might
 * want (not built by this issue, but the shape doesn't preclude it).
 */
export async function evaluateContentQualityChecklistForContent(
  tx: Bun.SQL,
  tenantId: string,
  contentKind: ChecklistContentKind,
  content: ChecklistEvaluableContent,
  termCount: number,
  mediaPort: NewsMediaPort,
  overrides: ChecklistPolicyOverrides,
  options: EvaluateContentQualityChecklistOptions = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<ContentQualityChecklistResult> {
  const modeActive = await mediaPort.isFullOnlineR2ModeActiveForTenant(
    tx,
    tenantId,
    env
  );

  if (!modeActive) {
    return notApplicableChecklistResult();
  }

  const {
    mediaObjectIds: galleryMediaObjectIds,
    violations: galleryViolations
  } = collectGalleryImageReferences(content.contentJson);

  const idsToResolve = [
    ...(content.featuredMediaId ? [content.featuredMediaId] : []),
    ...galleryMediaObjectIds
  ];

  const resolved = await mediaPort.resolveMediaReferences(
    tx,
    tenantId,
    idsToResolve
  );

  const featuredMedia = content.featuredMediaId
    ? (resolved.get(content.featuredMediaId) ?? null)
    : null;

  const unsafeGalleryMediaObjectIds = galleryMediaObjectIds.filter(
    (id) => !resolved.has(id)
  );

  return evaluateContentQualityChecklist(
    {
      contentKind,
      title: content.title,
      slug: content.slug,
      excerpt: content.excerpt,
      metaDescription: content.metaDescription,
      contentText: content.contentText,
      contentJson: content.contentJson,
      featuredMediaId: content.featuredMediaId,
      featuredMedia: featuredMedia
        ? {
            altText: featuredMedia.altText,
            width: featuredMedia.width,
            height: featuredMedia.height,
            mimeType: featuredMedia.mimeType,
            sizeBytes: featuredMedia.sizeBytes
          }
        : null,
      galleryViolations,
      unsafeGalleryMediaObjectIds,
      termCount,
      scheduledAt: options.scheduledAt ?? null,
      now: options.now ?? new Date()
    },
    overrides
  );
}

/** `{ field: ruleId, message }` pairs for every failed blocking rule — matches the existing `ErrorDetail` envelope shape (`ApiError.error.details`) the rest of this API already uses (`VALIDATION_ERROR`, `NEWS_MEDIA_REFERENCE_INVALID`), so a blocked publish/schedule response needs no new response envelope shape. */
export function checklistBlockersToErrorDetails(
  result: ContentQualityChecklistResult
): { field: string; message: string }[] {
  return result.blockers.map((blocker) => ({
    field: blocker.ruleId,
    message: blocker.message
  }));
}
