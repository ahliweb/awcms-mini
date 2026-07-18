/**
 * LinkedIn organization-page provider adapter (Issue #645, epic
 * `social_publishing` #643-#647) — the FIRST real `SocialProviderAdapter`
 * implementation in this module (`domain/social-provider-adapter.ts`).
 * `providerKey: "linkedin_organization"`. Publishes eligible news-article
 * posts to a connected LinkedIn organization page.
 *
 * ## What this adapter does NOT do (see `domain/linkedin-provider-config.ts`
 * header for the full reasoning)
 *
 * - No interactive OAuth authorize/callback flow — connect/disconnect/
 *   reauthorize all go through the foundation's existing generic
 *   `POST /api/v1/social-publishing/accounts` (upsert), same as every
 *   other provider in this module.
 * - No personal member profile publishing, sponsored posts/campaign
 *   management, social metrics sync, comment moderation, or scraping —
 *   all explicitly out of scope per the issue body.
 * - No secret-manager integration — `token_reference` resolution only
 *   understands the `env:VAR_NAME` convention
 *   (`resolveLinkedInSecretReference`), a documented residual shared with
 *   the rest of this epic.
 *
 * ## `providerAccountId` = the full organization URN
 *
 * Matches the issue's own `organization_urn` account-metadata field name —
 * an operator connects an account with `providerAccountId` already set to
 * the full `urn:li:organization:{id}` string (not a bare numeric id). This
 * adapter never parses/reconstructs the URN itself.
 *
 * ## Two live LinkedIn calls per publish attempt, not one
 *
 * 1. An `organizationAcls` role check (`checkOrganizationRole`) — the
 *    issue's "Require explicit tenant-level LinkedIn connection; require
 *    supported permission and organization role" is enforced HERE, live,
 *    on every attempt (not just at connect time) — a member's
 *    organization role can change or be revoked on LinkedIn's side after
 *    this app's own `awcms_mini_social_accounts` row was last touched,
 *    with no notification to this app; checking live is the only way to
 *    honor that requirement correctly, not a stale/cached copy.
 * 2. The actual post-creation call.
 *
 * `verifyCredentials` (a separate, account-agnostic-role check reused by
 * `security:readiness`'s eventual consumers and directly unit-tested here)
 * does its own single live call (LinkedIn's OpenID Connect `/v2/userinfo`)
 * to confirm the token itself is still accepted, plus a purely local
 * required-scopes check against the `scopesJson` parameter — it does NOT
 * receive an organization URN (the adapter interface's signature is
 * provider-agnostic and intentionally does not carry one), so role
 * eligibility is `publish()`'s job, not `verifyCredentials`'s.
 *
 * ## Image handling — real LinkedIn Images API, gated by an R2-trust check
 *
 * When `content.imageUrl` is present AND looks like it was actually served
 * from this deployment's configured `NEWS_MEDIA_R2_PUBLIC_BASE_URL`
 * (`isTrustedR2MediaUrl` — belt-and-suspenders on top of the fact that
 * `create-social-publish-jobs.ts` already only ever populates `imageUrl`
 * from a verified media object in the first place), this adapter performs
 * LinkedIn's real 2-step image upload (`initializeUpload` -> fetch the
 * verified bytes -> `PUT` to the returned presigned URL) and posts an
 * image-attached post (`content.media`). An untrusted/missing image, or
 * any failure during upload, degrades gracefully to a link-share post
 * (`content.article`, `source: canonicalUrl`) — a non-essential image must
 * never block a legitimate publish.
 */
import { withTimeout } from "../../../lib/integration/timeout";
import {
  LINKEDIN_DEFAULT_API_BASE_URL,
  LINKEDIN_DEFAULT_CALL_TIMEOUT_MS,
  LINKEDIN_RESTLI_PROTOCOL_VERSION,
  findMissingOrInvalidLinkedInConfig,
  isLinkedInProviderEnabled,
  isSupportedLinkedInOrganizationRole,
  resolveLinkedInApiVersion,
  resolveLinkedInRequiredScopes,
  resolveLinkedInSecretReference,
  LINKEDIN_REQUIRED_WHEN_ENABLED
} from "../domain/linkedin-provider-config";
import type {
  SocialProviderAdapter,
  SocialProviderCredentialCheck,
  SocialProviderPublishRequest,
  SocialProviderPublishResult
} from "../domain/social-provider-adapter";
import { registerSocialProviderAdapter } from "./social-provider-registry";
import type { NewsMediaPort } from "../../_shared/ports/news-media-port";

export const LINKEDIN_PROVIDER_KEY = "linkedin_organization";

const MAX_ERROR_MESSAGE_LENGTH = 500;
const LINKEDIN_MAX_COMMENTARY_LENGTH = 3000;
const LINKEDIN_MAX_DESCRIPTION_LENGTH = 300;
const IDEMPOTENCY_HEADER_NAME = "X-Idempotency-Key";

export type LinkedInProviderAdapterConfig = {
  /** Override for tests/dev only — a local fake HTTP server standing in for LinkedIn. Always from configuration, never request input (same convention `mailketing-provider.ts`'s `baseUrl` uses). */
  apiBaseUrl?: string;
  callTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests (`Bun.serve`-backed fake LinkedIn server) — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * `news_portal`'s `news_media` capability (Issue #859, epic #818),
   * injected at the composition root — the ONLY thing that resolves the
   * trusted R2 public base URL this adapter's image-trust check compares
   * against. Optional (mirroring the `capabilities.consumes` `news_media`
   * `optional: true` declaration): when ABSENT, every image URL is treated
   * as untrusted and the adapter degrades to a link-share post — the exact
   * same safe fallback an unset `NEWS_MEDIA_R2_PUBLIC_BASE_URL` already
   * produced. Whether a given TENANT has `news_portal` enabled does NOT
   * decide this: the port and the R2 base URL are DEPLOYMENT-wide config, and
   * the real publish path always injects the port, so a verified R2 image is
   * uploaded regardless of a single tenant's `news_portal` toggle. This
   * replaces the
   * former static `import { resolveNewsMediaR2Config } from
   * "../../news-portal/domain/news-media-r2-config"`, which had forced
   * `news_portal` to be a HARD lifecycle dependency of `social_publishing`.
   * Only the real publish path (`scripts/social-publish-dispatch.ts`)
   * injects it; the SSR "verify connection" route never publishes, so its
   * registration deliberately leaves it unset.
   */
  mediaPort?: NewsMediaPort;
};

type OrganizationRoleCheckResult =
  | { outcome: "ok"; role: string }
  | { outcome: "no_role" }
  | { outcome: "unauthorized" }
  | { outcome: "http_error"; status: number; body: string };

type ImageUploadResult =
  | { outcome: "ok"; mediaUrn: string }
  | { outcome: "unauthorized" }
  | { outcome: "skipped" };

type LinkedInPostRequestBody = {
  author: string;
  commentary: string;
  visibility: "PUBLIC";
  distribution: {
    feedDistribution: "MAIN_FEED";
    targetEntities: never[];
    thirdPartyDistributionChannels: never[];
  };
  lifecycleState: "PUBLISHED";
  isReshareDisabledByAuthor: boolean;
  content?:
    | { article: { source: string; title: string; description: string } }
    | { media: { id: string; title: string } };
};

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/**
 * Redacts every occurrence of the literal bearer token from a message
 * before it can ever reach `awcms_mini_social_publish_jobs.last_error_message`/
 * an attempt row (both readable via the admin API) — a deterministic
 * literal-substring redaction, not a shape heuristic, since the exact
 * secret value is known in scope at the point every error message is
 * constructed.
 *
 * ## MUST run before `truncate()`, never after (Critical finding, PR #737
 * review)
 *
 * `redact()` only matches a COMPLETE occurrence of `secret` via
 * `.split(secret).join(...)` — if `truncate()` runs first and the cutoff
 * lands in the middle of the token, only a partial fragment of the real
 * secret survives truncation. That fragment is no longer equal to the
 * full token, so this function's `.split()` silently fails to match it,
 * and the fragment (confirmed: the first ~20 characters of a real token)
 * is persisted in the clear. Every call site in this file MUST call this
 * as `truncate(redact(message, ...secrets), maxLength)`, never
 * `redact(truncate(...), ...secrets)`.
 */
function redact(
  message: string,
  ...secrets: (string | null | undefined)[]
): string {
  let redacted = message;

  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }

  return redacted;
}

function buildHeaders(bearerToken: string, apiVersion: string): HeadersInit {
  return {
    Authorization: `Bearer ${bearerToken}`,
    "LinkedIn-Version": apiVersion,
    "X-Restli-Protocol-Version": LINKEDIN_RESTLI_PROTOCOL_VERSION,
    "Content-Type": "application/json"
  };
}

/**
 * Defense-in-depth only — `create-social-publish-jobs.ts` already only
 * ever populates `content.imageUrl` from `NewsMediaPort.resolveMediaReferences`,
 * which only ever resolves verified/attached, same-tenant R2 objects. This
 * re-check ensures a bug or future refactor elsewhere can never cause this
 * adapter to hand an arbitrary caller-influenced URL to a third-party API.
 *
 * `publicBaseUrl` is resolved by the injected `NewsMediaPort`
 * (`resolveMediaPublicBaseUrl`) at the composition root (Issue #859) rather
 * than read from a static `news_portal` import — an empty string (port not
 * injected, or `NEWS_MEDIA_R2_PUBLIC_BASE_URL` unset) means "trust nothing",
 * so the adapter safely degrades to a link-share post.
 */
export function isTrustedR2MediaUrl(
  url: string,
  publicBaseUrl: string
): boolean {
  if (!publicBaseUrl) {
    return false;
  }

  return url.startsWith(publicBaseUrl);
}

function buildLinkedInPostRequestBody(params: {
  organizationUrn: string;
  title: string;
  caption: string;
  canonicalUrl: string;
  mediaUrn: string | null;
}): LinkedInPostRequestBody {
  const distribution = {
    feedDistribution: "MAIN_FEED" as const,
    targetEntities: [] as never[],
    thirdPartyDistributionChannels: [] as never[]
  };

  if (params.mediaUrn) {
    // Image-attached post — `content.media` has no separate URL field, so
    // the canonical article URL is appended to the commentary text itself
    // to make sure the link is never dropped just because an image was
    // available.
    return {
      author: params.organizationUrn,
      commentary: truncate(
        `${params.caption}\n\n${params.canonicalUrl}`,
        LINKEDIN_MAX_COMMENTARY_LENGTH
      ),
      visibility: "PUBLIC",
      distribution,
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
      content: { media: { id: params.mediaUrn, title: params.title } }
    };
  }

  return {
    author: params.organizationUrn,
    commentary: truncate(params.caption, LINKEDIN_MAX_COMMENTARY_LENGTH),
    visibility: "PUBLIC",
    distribution,
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
    content: {
      article: {
        source: params.canonicalUrl,
        title: params.title,
        description: truncate(params.caption, LINKEDIN_MAX_DESCRIPTION_LENGTH)
      }
    }
  };
}

/**
 * Creates a real `SocialProviderAdapter` for LinkedIn organization pages.
 * `config` is entirely optional in production (every field falls back to a
 * real default/`process.env`) — tests override `apiBaseUrl`/`fetchImpl`/
 * `env` to point at a local `Bun.serve` fake LinkedIn server, same
 * convention `google-oauth-client.test.ts` established for Google's OAuth
 * endpoints.
 */
export function createLinkedInProviderAdapter(
  config: LinkedInProviderAdapterConfig = {}
): SocialProviderAdapter {
  const apiBaseUrl = config.apiBaseUrl ?? LINKEDIN_DEFAULT_API_BASE_URL;
  const callTimeoutMs =
    config.callTimeoutMs ?? LINKEDIN_DEFAULT_CALL_TIMEOUT_MS;
  const env = config.env ?? process.env;
  const fetchImpl = config.fetchImpl ?? fetch;
  const mediaPort = config.mediaPort;

  // Resolved through the injected `news_media` port (Issue #859) — empty
  // string when no port was injected (SSR verify path) or `news_portal`
  // has no configured R2 public base URL, in which case every image URL is
  // untrusted and the adapter degrades to a link-share post.
  const trustedMediaBaseUrl = mediaPort
    ? mediaPort.resolveMediaPublicBaseUrl(env)
    : "";

  async function checkOrganizationRole(
    organizationUrn: string,
    bearerToken: string,
    apiVersion: string,
    correlationId: string | undefined
  ): Promise<OrganizationRoleCheckResult> {
    try {
      const url = `${apiBaseUrl}/rest/organizationAcls?q=roleAssignee&organization=${encodeURIComponent(organizationUrn)}`;
      const response = await withTimeout(
        fetchImpl(url, {
          method: "GET",
          headers: buildHeaders(bearerToken, apiVersion)
        }),
        callTimeoutMs,
        `linkedin organizationAcls (${correlationId ?? "n/a"})`
      );

      if (response.status === 401) {
        return { outcome: "unauthorized" };
      }

      const rawBody = await response.text().catch(() => "");

      if (!response.ok) {
        return {
          outcome: "http_error",
          status: response.status,
          body: rawBody
        };
      }

      let parsed: { elements?: Array<{ role?: string; state?: string }> } = {};

      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return {
          outcome: "http_error",
          status: response.status,
          body: "non-JSON response"
        };
      }

      const approved = (parsed.elements ?? []).find(
        (element) =>
          element.state === "APPROVED" && typeof element.role === "string"
      );

      return approved?.role
        ? { outcome: "ok", role: approved.role }
        : { outcome: "no_role" };
    } catch (error) {
      return {
        outcome: "http_error",
        status: 0,
        body: error instanceof Error ? error.message : "Unknown network error."
      };
    }
  }

  async function uploadOrganizationImage(
    organizationUrn: string,
    imageUrl: string,
    bearerToken: string,
    apiVersion: string,
    correlationId: string | undefined
  ): Promise<ImageUploadResult> {
    try {
      const initResponse = await withTimeout(
        fetchImpl(`${apiBaseUrl}/rest/images?action=initializeUpload`, {
          method: "POST",
          headers: buildHeaders(bearerToken, apiVersion),
          body: JSON.stringify({
            initializeUploadRequest: { owner: organizationUrn }
          })
        }),
        callTimeoutMs,
        `linkedin images initializeUpload (${correlationId ?? "n/a"})`
      );

      if (initResponse.status === 401) {
        return { outcome: "unauthorized" };
      }

      if (!initResponse.ok) {
        return { outcome: "skipped" };
      }

      const initBody = (await initResponse.json().catch(() => null)) as {
        value?: { uploadUrl?: string; image?: string };
      } | null;
      const uploadUrl = initBody?.value?.uploadUrl;
      const mediaUrn = initBody?.value?.image;

      if (!uploadUrl || !mediaUrn) {
        return { outcome: "skipped" };
      }

      const imageBytesResponse = await withTimeout(
        fetchImpl(imageUrl, { method: "GET" }),
        callTimeoutMs,
        `fetch verified R2 image bytes (${correlationId ?? "n/a"})`
      );

      if (!imageBytesResponse.ok) {
        return { outcome: "skipped" };
      }

      const imageBytes = await imageBytesResponse.arrayBuffer();
      const contentType =
        imageBytesResponse.headers.get("content-type") ??
        "application/octet-stream";

      const putResponse = await withTimeout(
        fetchImpl(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: imageBytes
        }),
        callTimeoutMs,
        `linkedin image upload PUT (${correlationId ?? "n/a"})`
      );

      if (putResponse.status === 401) {
        return { outcome: "unauthorized" };
      }

      if (!putResponse.ok) {
        return { outcome: "skipped" };
      }

      return { outcome: "ok", mediaUrn };
    } catch {
      // Non-essential — degrade to a text/link-only post rather than
      // failing the whole publish attempt over an image upload hiccup.
      return { outcome: "skipped" };
    }
  }

  return {
    providerKey: LINKEDIN_PROVIDER_KEY,
    requiredEnvVars: [...LINKEDIN_REQUIRED_WHEN_ENABLED],

    async publish(
      request: SocialProviderPublishRequest
    ): Promise<SocialProviderPublishResult> {
      const resolvedToken = resolveLinkedInSecretReference(
        request.tokenReference,
        env
      );

      if (!resolvedToken.ok) {
        return {
          outcome: "needs_reauth",
          errorCode: "token_reference_unresolvable",
          errorMessage:
            "Connected LinkedIn account's token reference could not be resolved to a usable credential.",
          retryable: false
        };
      }

      const bearerToken = resolvedToken.value;
      const apiVersion = resolveLinkedInApiVersion(env);
      const organizationUrn = request.providerAccountId;

      const roleCheck = await checkOrganizationRole(
        organizationUrn,
        bearerToken,
        apiVersion,
        request.correlationId
      );

      if (roleCheck.outcome === "unauthorized") {
        return {
          outcome: "needs_reauth",
          errorCode: "token_expired",
          errorMessage:
            "LinkedIn rejected the access token (401) while checking the organization role.",
          retryable: false
        };
      }

      if (roleCheck.outcome === "http_error") {
        return {
          outcome: "failed",
          errorCode: `organization_acl_http_${roleCheck.status}`,
          errorMessage: truncate(
            redact(
              `LinkedIn organizationAcls check failed (HTTP ${roleCheck.status}): ${roleCheck.body}`,
              bearerToken
            ),
            MAX_ERROR_MESSAGE_LENGTH
          ),
          retryable: roleCheck.status === 0 || roleCheck.status >= 500
        };
      }

      if (
        roleCheck.outcome === "no_role" ||
        !isSupportedLinkedInOrganizationRole(roleCheck.role)
      ) {
        return {
          outcome: "failed",
          errorCode: "unsupported_organization_role",
          errorMessage:
            roleCheck.outcome === "ok"
              ? `Connected LinkedIn member's organization role ("${roleCheck.role}") is not eligible to publish organization posts.`
              : "Connected LinkedIn member has no approved role on this organization.",
          retryable: false
        };
      }

      let mediaUrn: string | null = null;

      if (
        request.content.imageUrl &&
        isTrustedR2MediaUrl(request.content.imageUrl, trustedMediaBaseUrl)
      ) {
        const uploadResult = await uploadOrganizationImage(
          organizationUrn,
          request.content.imageUrl,
          bearerToken,
          apiVersion,
          request.correlationId
        );

        if (uploadResult.outcome === "unauthorized") {
          return {
            outcome: "needs_reauth",
            errorCode: "token_expired",
            errorMessage:
              "LinkedIn rejected the access token (401) while uploading the article image.",
            retryable: false
          };
        }

        if (uploadResult.outcome === "ok") {
          mediaUrn = uploadResult.mediaUrn;
        }
        // "skipped" — degrade to a link-share post below, no error surfaced.
      }

      const postBody = buildLinkedInPostRequestBody({
        organizationUrn,
        title: request.content.title,
        caption: request.content.excerptOrCaption,
        canonicalUrl: request.content.canonicalUrl,
        mediaUrn
      });

      try {
        const response = await withTimeout(
          fetchImpl(`${apiBaseUrl}/rest/posts`, {
            method: "POST",
            headers: {
              ...buildHeaders(bearerToken, apiVersion),
              [IDEMPOTENCY_HEADER_NAME]: request.idempotencyKey
            },
            body: JSON.stringify(postBody)
          }),
          callTimeoutMs,
          `linkedin posts create (${request.correlationId ?? "n/a"})`
        );

        if (response.status === 401) {
          return {
            outcome: "needs_reauth",
            errorCode: "token_expired",
            errorMessage:
              "LinkedIn rejected the access token (401) while creating the post.",
            retryable: false
          };
        }

        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfterSeconds = retryAfterHeader
            ? Number.parseInt(retryAfterHeader, 10)
            : undefined;

          return {
            outcome: "rate_limited",
            errorCode: "linkedin_rate_limited",
            errorMessage:
              "LinkedIn rate-limited the post-creation request (429).",
            retryable: true,
            retryAfterSeconds:
              retryAfterSeconds &&
              Number.isFinite(retryAfterSeconds) &&
              retryAfterSeconds > 0
                ? retryAfterSeconds
                : undefined
          };
        }

        if (!response.ok) {
          const rawBody = await response.text().catch(() => "");

          return {
            outcome: "failed",
            errorCode: `linkedin_post_http_${response.status}`,
            errorMessage: truncate(
              redact(
                `LinkedIn rejected the post (HTTP ${response.status}): ${rawBody}`,
                bearerToken
              ),
              MAX_ERROR_MESSAGE_LENGTH
            ),
            retryable: response.status >= 500
          };
        }

        const externalPostId =
          response.headers.get("x-restli-id") ??
          response.headers.get("x-linkedin-id") ??
          "";

        if (!externalPostId) {
          return {
            outcome: "failed",
            errorCode: "linkedin_post_missing_id",
            errorMessage:
              "LinkedIn accepted the post but returned no identifying header (x-restli-id).",
            retryable: true
          };
        }

        return {
          outcome: "published",
          externalPostId,
          externalPostUrl: `https://www.linkedin.com/feed/update/${encodeURIComponent(externalPostId)}/`
        };
      } catch (error) {
        return {
          outcome: "failed",
          errorCode: "linkedin_post_call_exception",
          errorMessage: truncate(
            redact(
              error instanceof Error
                ? error.message
                : "Unknown LinkedIn API error.",
              bearerToken
            ),
            MAX_ERROR_MESSAGE_LENGTH
          ),
          retryable: true
        };
      }
    },

    async verifyCredentials(
      tokenReference: string,
      providerAccountId: string,
      scopesJson: unknown,
      verifyEnv: NodeJS.ProcessEnv = process.env
    ): Promise<SocialProviderCredentialCheck> {
      if (!isLinkedInProviderEnabled(verifyEnv)) {
        return { valid: false, reason: "linkedin_provider_disabled" };
      }

      const missingConfig = findMissingOrInvalidLinkedInConfig(verifyEnv);

      if (missingConfig.length > 0) {
        return {
          valid: false,
          reason: `missing_client_config:${missingConfig.join(",")}`
        };
      }

      const requiredScopes = resolveLinkedInRequiredScopes(verifyEnv);
      const grantedScopes = Array.isArray(scopesJson)
        ? (scopesJson as unknown[]).filter(
            (scope): scope is string => typeof scope === "string"
          )
        : [];
      const missingScopes = requiredScopes.filter(
        (scope) => !grantedScopes.includes(scope)
      );

      if (missingScopes.length > 0) {
        return {
          valid: false,
          reason: `missing_scopes:${missingScopes.join(",")}`
        };
      }

      const resolvedToken = resolveLinkedInSecretReference(
        tokenReference,
        verifyEnv
      );

      if (!resolvedToken.ok) {
        return {
          valid: false,
          reason: `token_reference_${resolvedToken.reason}`
        };
      }

      const apiVersion = resolveLinkedInApiVersion(verifyEnv);

      try {
        const response = await withTimeout(
          fetchImpl(`${apiBaseUrl}/v2/userinfo`, {
            method: "GET",
            headers: buildHeaders(resolvedToken.value, apiVersion)
          }),
          callTimeoutMs,
          "linkedin verifyCredentials userinfo"
        );

        if (response.status === 401) {
          return { valid: false, reason: "token_expired" };
        }

        if (!response.ok) {
          return {
            valid: false,
            reason: `unexpected_status_${response.status}`
          };
        }
      } catch {
        return { valid: false, reason: "network_error" };
      }

      // Token itself is valid — now confirm it also has an eligible
      // organization role for THIS specific target (Issue #646 extended
      // `verifyCredentials` with `providerAccountId` precisely because a
      // bearer credential can be valid in general yet still lack access to
      // a specific target). Reuses the exact same live check `publish()`
      // performs, so "verify connection" genuinely reflects publish
      // eligibility rather than only "is this token not expired".
      const roleCheck = await checkOrganizationRole(
        providerAccountId,
        resolvedToken.value,
        apiVersion,
        undefined
      );

      if (roleCheck.outcome === "unauthorized") {
        return { valid: false, reason: "token_expired" };
      }

      if (roleCheck.outcome === "http_error") {
        return {
          valid: false,
          reason: `organization_acl_http_${roleCheck.status}`
        };
      }

      if (
        roleCheck.outcome === "no_role" ||
        !isSupportedLinkedInOrganizationRole(roleCheck.role)
      ) {
        return {
          valid: false,
          reason: "unsupported_organization_role",
          details:
            roleCheck.outcome === "ok" ? { role: roleCheck.role } : undefined
        };
      }

      return { valid: true, details: { role: roleCheck.role } };
    }
  };
}

/**
 * Composition-root registration entrypoint (Issue #643 Keputusan kunci #4:
 * "panggil `registerSocialProviderAdapter(adapter)` dari COMPOSITION ROOT
 * milik adapter itu sendiri"). Called from every process that needs
 * `getSocialProviderAdapter` to recognize `"linkedin_organization"`:
 * `scripts/social-publish-dispatch.ts` and `scripts/security-readiness.ts`
 * call this directly (needs it so `checkSocialPublishingProviderReadiness`'s
 * existing "every connected account's provider is registered" check does
 * not false-positive for a correctly-configured LinkedIn deployment); the
 * Astro SSR process (`src/pages/api/v1/social-publishing/accounts/[id]/verify.ts`,
 * Issue #646) instead imports the thin side-effect wrapper
 * `linkedin-provider-registration.ts`, matching the convention
 * `telegram-provider-registration.ts` established. A no-op (never registers
 * a broken adapter, never throws) when `LINKEDIN_PROVIDER_ENABLED` is not
 * `"true"` — config completeness beyond that flag is reported separately by
 * `checkLinkedInProviderReadiness`, not gated here.
 *
 * `mediaPort` (Issue #859, epic #818) is `news_portal`'s `news_media`
 * capability, injected by the composition root that needs the LinkedIn
 * adapter to actually PUBLISH images (`scripts/social-publish-dispatch.ts`).
 * It is OPTIONAL: a call site that never publishes — the SSR "verify
 * connection" route via `linkedin-provider-registration.ts` — omits it, and
 * the adapter then treats every image as untrusted (safe link-share
 * fallback). Omitting it is precisely what keeps `news_portal` from being a
 * hard, undisableable dependency of `social_publishing`.
 */
export function registerLinkedInProviderAdapterIfEnabled(
  env: NodeJS.ProcessEnv = process.env,
  mediaPort?: NewsMediaPort
): void {
  if (!isLinkedInProviderEnabled(env)) {
    return;
  }

  registerSocialProviderAdapter(
    createLinkedInProviderAdapter({ env, mediaPort })
  );
}
