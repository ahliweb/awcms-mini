/**
 * Meta Facebook Page adapter (Issue #644) — `providerKey: "meta_facebook_page"`.
 * Supported action: `publish_link_post_to_facebook_page` (a Graph API
 * `POST /{page-id}/feed` with `message` + `link`; Facebook's own OG
 * scraper builds the link preview card, so no image upload happens here —
 * see `domain/meta-publish-content.ts`'s header comment).
 *
 * `publish()` never throws for an ordinary provider-rejected outcome (see
 * `SocialProviderAdapter.publish`'s own contract) — every branch below
 * returns a `SocialProviderPublishResult` value. A genuinely unexpected
 * exception (network error inside `MetaGraphClient.call`, a bug) is left
 * to propagate — the dispatcher's own `try/catch` around `adapter.publish`
 * treats that as a retryable `failed` outcome (Keputusan kunci #5).
 */
import type {
  SocialProviderAdapter,
  SocialProviderCredentialCheck,
  SocialProviderPublishRequest,
  SocialProviderPublishResult
} from "../../domain/social-provider-adapter";
import { loadMetaProviderConfig } from "../../domain/meta-provider-config";
import { validateFacebookPagePublishEligibility } from "../../domain/meta-publish-content";
import { normalizeMetaGraphApiError } from "../../domain/meta-error-normalization";
import {
  createMetaGraphClient,
  extractGraphResponseStringField,
  type MetaGraphClient
} from "./meta-graph-client";
import { resolveMetaTokenReference } from "./meta-token-reference-resolver";
import { verifyMetaCredentials } from "./meta-credential-verification";

export const META_FACEBOOK_PAGE_PROVIDER_KEY = "meta_facebook_page";

export type MetaGraphClientFactory = (
  graphApiVersion: string
) => MetaGraphClient;

export type CreateMetaFacebookPageAdapterOptions = {
  /** Test-only override — defaults to `process.env` at call time (never captured eagerly, so registering this adapter at process start never freezes stale env). */
  env?: NodeJS.ProcessEnv;
  /** Test-only override — defaults to a real `createMetaGraphClient`. */
  graphClientFactory?: MetaGraphClientFactory;
};

/** Splits Graph API's `POST /{page-id}/feed` response id (`"{page-id}_{post-id}"`) into a real `facebook.com` permalink. Falls back to the raw id if the expected shape isn't present — still a valid (if less pretty) reference URL, never blocks a successful publish on this alone. */
function buildFacebookPostUrl(pageId: string, feedPostId: string): string {
  const separatorIndex = feedPostId.indexOf("_");
  const postSuffix =
    separatorIndex >= 0 ? feedPostId.slice(separatorIndex + 1) : feedPostId;

  return `https://www.facebook.com/${pageId}/posts/${postSuffix}`;
}

export function createMetaFacebookPageAdapter(
  options: CreateMetaFacebookPageAdapterOptions = {}
): SocialProviderAdapter {
  const resolveEnv = (): NodeJS.ProcessEnv => options.env ?? process.env;
  const graphClientFactory: MetaGraphClientFactory =
    options.graphClientFactory ??
    ((graphApiVersion) => createMetaGraphClient({ graphApiVersion }));

  return {
    providerKey: META_FACEBOOK_PAGE_PROVIDER_KEY,
    requiredEnvVars: [
      "META_PROVIDER_ENABLED",
      "META_APP_ID",
      "META_APP_SECRET_REFERENCE",
      "META_GRAPH_API_VERSION",
      "META_OAUTH_REDIRECT_URI",
      "META_REQUIRED_SCOPES"
    ],
    supportedAccountTypes: ["page"],

    async publish(
      request: SocialProviderPublishRequest
    ): Promise<SocialProviderPublishResult> {
      const env = resolveEnv();
      const config = loadMetaProviderConfig(env);

      if (!config) {
        return {
          outcome: "failed",
          errorCode: "meta_provider_not_configured",
          errorMessage: "Meta provider is not configured for this deployment.",
          retryable: false
        };
      }

      const eligibility = validateFacebookPagePublishEligibility(
        request.content
      );

      if (!eligibility.eligible) {
        return {
          outcome: "failed",
          errorCode: eligibility.errorCode,
          errorMessage: eligibility.errorMessage,
          retryable: false
        };
      }

      const credential = resolveMetaTokenReference(request.tokenReference, env);

      if (!credential) {
        return {
          outcome: "needs_reauth",
          errorCode: "meta_token_reference_unresolved",
          errorMessage:
            "Could not resolve this account's token reference to a usable credential.",
          retryable: false
        };
      }

      const client = graphClientFactory(config.graphApiVersion);

      const response = await client.call({
        path: `/${request.providerAccountId}/feed`,
        method: "POST",
        params: {
          message: request.content.excerptOrCaption,
          link: request.content.canonicalUrl,
          access_token: credential.value
        }
      });

      if (response.httpStatus >= 200 && response.httpStatus < 300) {
        const feedPostId = extractGraphResponseStringField(response.body, "id");

        if (!feedPostId) {
          return {
            outcome: "failed",
            errorCode: "meta_unexpected_response",
            errorMessage:
              "Meta API returned a success response with no post id.",
            retryable: true
          };
        }

        return {
          outcome: "published",
          externalPostId: feedPostId,
          externalPostUrl: buildFacebookPostUrl(
            request.providerAccountId,
            feedPostId
          )
        };
      }

      return normalizeMetaGraphApiError(response.httpStatus, response.body);
    },

    async verifyCredentials(
      tokenReference: string,
      providerAccountId: string,
      scopesJson: unknown,
      env: NodeJS.ProcessEnv = process.env
    ): Promise<SocialProviderCredentialCheck> {
      try {
        return await verifyMetaCredentials(
          tokenReference,
          providerAccountId,
          scopesJson,
          env,
          graphClientFactory
        );
      } catch {
        return { valid: false, reason: "verification_call_failed" };
      }
    }
  };
}
