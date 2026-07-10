/**
 * Application-layer enforcement of Issue #636 (epic `news_portal`): when
 * full-online R2-only mode is active for the tenant making a request,
 * `featuredMediaId` and every image-gallery block item must reference an
 * existing, same-tenant, `verified`/`attached` row in the news media
 * registry (Issue #633) — never a raw URL, never another tenant's object,
 * never an unverified/failed/orphaned/deleted one.
 *
 * Deliberately NOT part of the pure validators in `blog-post-validation.ts`/
 * `blog-page-validation.ts` — this needs a real database round trip
 * (`fetchNewsMediaObjectById`), so it follows the exact same convention
 * `countExistingTerms` already established for `termIds` (Issue #539):
 * shape-only checks stay in the pure validator, existence/ownership checks
 * run here, called from the route handler AFTER pure validation passes and
 * BEFORE the post/page is written — so a request that fails this check
 * never creates a partially-written row.
 *
 * When full-online R2-only mode is NOT active for the tenant (the
 * overwhelming majority of deployments/tenants today), this entire check
 * is a no-op — `featuredMediaId`/gallery `url` fields keep their existing,
 * unchanged, pre-#636 behavior. This is intentionally conditional, not a
 * blanket tightening of `blog_content` itself (issue's own "Security
 * notes": enforce hard in R2-only mode, but the mode itself stays opt-in).
 */
import {
  collectGalleryImageReferences,
  type GalleryImageReferenceViolation
} from "../domain/content-block-media-references";
import { isNewsPortalFullOnlineR2ModeActiveForTenant } from "./news-portal-r2-mode-gate";
import {
  fetchNewsMediaObjectById,
  isNewsMediaObjectSafeForPublicReference
} from "../../news-portal/application/news-media-object-directory";

export type NewsMediaReferenceValidationError = {
  field: string;
  message: string;
};

export type NewsMediaReferenceValidationResult =
  | { valid: true }
  | { valid: false; errors: NewsMediaReferenceValidationError[] };

function violationMessage(violation: GalleryImageReferenceViolation): string {
  const prefix = `contentJson.blocks[].items[${violation.itemIndex}]`;

  if (violation.reason === "raw_url_not_allowed") {
    return `${prefix}: image gallery items must use "mediaObjectId" (a verified R2 media object), not a raw "url", in full-online R2-only mode.`;
  }

  return `${prefix}: image gallery items require a valid "mediaObjectId" (UUID) in full-online R2-only mode.`;
}

/**
 * Runs inside the caller's own tenant-scoped transaction (same `tx` the
 * route handler already opened via `withTenant`) — every existence check
 * below is naturally tenant-scoped by `fetchNewsMediaObjectById`'s own
 * `tenantId` parameter, so a cross-tenant `mediaObjectId` simply resolves
 * to `null` (indistinguishable from "does not exist"), never leaking
 * whether the id belongs to a different tenant.
 */
export async function validateNewsMediaReferencesForFullOnlineR2Mode(
  tx: Bun.SQL,
  tenantId: string,
  input: {
    featuredMediaId: string | null | undefined;
    contentJson: Record<string, unknown> | undefined;
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<NewsMediaReferenceValidationResult> {
  const modeActive = await isNewsPortalFullOnlineR2ModeActiveForTenant(
    tx,
    tenantId,
    env
  );

  if (!modeActive) {
    return { valid: true };
  }

  const errors: NewsMediaReferenceValidationError[] = [];

  if (input.featuredMediaId) {
    const media = await fetchNewsMediaObjectById(
      tx,
      tenantId,
      input.featuredMediaId
    );

    if (!media || !isNewsMediaObjectSafeForPublicReference(media.status)) {
      errors.push({
        field: "featuredMediaId",
        message:
          "featuredMediaId must reference an existing, verified R2 media object belonging to this tenant in full-online R2-only mode."
      });
    }
  }

  if (input.contentJson) {
    const { mediaObjectIds, violations } = collectGalleryImageReferences(
      input.contentJson
    );

    for (const violation of violations) {
      errors.push({
        field: "contentJson",
        message: violationMessage(violation)
      });
    }

    for (const mediaObjectId of mediaObjectIds) {
      const media = await fetchNewsMediaObjectById(tx, tenantId, mediaObjectId);

      if (!media || !isNewsMediaObjectSafeForPublicReference(media.status)) {
        errors.push({
          field: "contentJson",
          message: `contentJson references mediaObjectId "${mediaObjectId}" which does not exist, does not belong to this tenant, or is not a verified R2 media object.`
        });
      }
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Resolves already-`verified`/`attached` media object metadata for
 * rendering (public detail routes: gallery images, SEO og:image/
 * twitter:image) — never used for write-time validation (that's
 * `validateNewsMediaReferencesForFullOnlineR2Mode` above). An id that
 * fails to resolve (wrong tenant, unsafe status, or simply absent) is
 * silently omitted from the returned map rather than throwing, matching
 * `content-block-rendering.ts`'s established "degrade, don't 500"
 * convention — a stale/since-orphaned reference just renders as if the
 * image were never there.
 */
export async function resolveVerifiedNewsMediaReferences(
  tx: Bun.SQL,
  tenantId: string,
  mediaObjectIds: readonly string[]
): Promise<Map<string, { publicUrl: string; altText: string | null }>> {
  const resolved = new Map<
    string,
    { publicUrl: string; altText: string | null }
  >();

  for (const mediaObjectId of new Set(mediaObjectIds)) {
    const media = await fetchNewsMediaObjectById(tx, tenantId, mediaObjectId);

    if (media && isNewsMediaObjectSafeForPublicReference(media.status)) {
      resolved.set(mediaObjectId, {
        publicUrl: media.publicUrl,
        altText: media.altText
      });
    }
  }

  return resolved;
}
