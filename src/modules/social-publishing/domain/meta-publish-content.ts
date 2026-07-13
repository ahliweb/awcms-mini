/**
 * Meta adapter content eligibility rules (Issue #644). Pure, no I/O — every
 * function here takes the already-resolved job content snapshot
 * (`SocialProviderContentSnapshot`, built by the FOUNDATION's
 * `create-social-publish-jobs.ts` before this adapter ever sees it) and
 * decides whether THIS provider can publish it, never calls out to Meta.
 *
 * "Instagram publishing validates account eligibility and provider-
 * supported content type before job execution" (Issue #644 acceptance
 * criterion) is satisfied by calling
 * `validateInstagramPublishEligibility` as the FIRST thing
 * `meta-instagram-adapter.ts`'s `publish()` does, before any Graph API
 * call — "before job execution" here means "before the provider call,"
 * the same phase boundary the dispatcher itself already enforces (Keputusan
 * kunci #5, `.claude/skills/awcms-mini-social-publishing/SKILL.md`).
 */
import type { SocialPublishContentSnapshot } from "./social-provider-adapter";

export type MetaContentEligibilityResult =
  | { eligible: true }
  | { eligible: false; errorCode: string; errorMessage: string };

/**
 * Facebook Page link posts (`publish_link_post_to_facebook_page`) need only
 * a caption and a link — Facebook's own OG scraper generates the preview
 * image from `canonicalUrl` itself, so no image is required here (unlike
 * Instagram). `canonicalUrl` is already guaranteed non-empty by the
 * foundation's job creation (`no_verified_domain` skip happens before a job
 * row is ever written), so this check is defense-in-depth, not the primary
 * guard.
 */
export function validateFacebookPagePublishEligibility(
  content: SocialPublishContentSnapshot
): MetaContentEligibilityResult {
  if (!content.canonicalUrl || content.canonicalUrl.trim().length === 0) {
    return {
      eligible: false,
      errorCode: "missing_canonical_url",
      errorMessage: "Article has no canonical URL to attach as a link."
    };
  }

  if (
    !content.excerptOrCaption ||
    content.excerptOrCaption.trim().length === 0
  ) {
    return {
      eligible: false,
      errorCode: "missing_caption",
      errorMessage: "Article has no title/excerpt/caption to post."
    };
  }

  return { eligible: true };
}

/**
 * Instagram's Graph API `.../media` container endpoint requires
 * `image_url` (or `video_url`, out of scope per Issue #644's "Out of
 * scope: Stories/Reels" — this issue only ships image posts) — a text-only
 * "link post" the way Facebook Pages support does NOT exist on Instagram.
 * An article with no verified featured image is therefore genuinely
 * ineligible for Instagram, not a transient failure: `retryable: false`
 * (the dispatcher's retry/backoff would never make a missing image appear).
 */
export function validateInstagramPublishEligibility(
  content: SocialPublishContentSnapshot,
  env: NodeJS.ProcessEnv = process.env
): MetaContentEligibilityResult {
  if (!content.imageUrl) {
    return {
      eligible: false,
      errorCode: "unsupported_content_type",
      errorMessage:
        "Instagram publishing requires an image; this article has none."
    };
  }

  if (!isAcceptableProviderMediaUrl(content.imageUrl, env)) {
    return {
      eligible: false,
      errorCode: "unverified_media_url",
      errorMessage:
        "Image URL is not from this deployment's verified media origin."
    };
  }

  if (
    !content.excerptOrCaption ||
    content.excerptOrCaption.trim().length === 0
  ) {
    return {
      eligible: false,
      errorCode: "missing_caption",
      errorMessage: "Article has no title/excerpt/caption to post."
    };
  }

  return { eligible: true };
}

/**
 * Defense-in-depth re-check (Issue #644 acceptance criterion: "R2 image
 * URLs used for provider media must come from verified media objects").
 * By construction, `content.imageUrl` on a job snapshot is ALREADY only
 * ever populated from `NewsMediaPort.resolveMediaReferences`'s
 * `publicUrl` (verified/attached R2 objects only — see
 * `create-social-publish-jobs.ts`) — this adapter never accepts an
 * additional caller-supplied image URL (the "optional editor-approved
 * custom caption" the issue describes is TEXT only, never a URL). This
 * function re-validates that invariant at the last point before an
 * external network call, so a future regression upstream (e.g. a bug that
 * lets an unverified URL onto a job row) fails CLOSED here rather than
 * silently sending an arbitrary URL to Meta's servers.
 *
 * Compares the URL's `origin`+`host` exactly against the configured news
 * media public base — never a substring/prefix check (Issue #635's
 * `checkNewsMediaR2PublicBaseUrlProductionSafe` review found substring/
 * prefix-style hostname checks bypassable via a trailing-dot FQDN; an exact
 * `URL.host` comparison sidesteps that whole bug class rather than
 * re-deriving the same fix here).
 */
export function isAcceptableProviderMediaUrl(
  url: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const configuredBase = env.NEWS_MEDIA_R2_PUBLIC_BASE_URL;

  if (!configuredBase) {
    return false;
  }

  let target: URL;
  let base: URL;

  try {
    target = new URL(url);
    base = new URL(configuredBase);
  } catch {
    return false;
  }

  if (target.protocol !== "https:") {
    return false;
  }

  return target.host === base.host;
}
