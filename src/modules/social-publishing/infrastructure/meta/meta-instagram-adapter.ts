/**
 * Meta Instagram (professional/business account) adapter (Issue #644) —
 * `providerKey: "meta_instagram"`. Supported action:
 * `publish_image_or_article_post_to_instagram_where_supported` — Instagram
 * publishing is a real 2-call Graph API flow (unlike Facebook Page's
 * single `/feed` call):
 *
 * 1. `POST /{ig-user-id}/media` — create a media container from
 *    `image_url` + `caption`, returns a `creation_id`.
 * 2. `POST /{ig-user-id}/media_publish` — publish that container, returns
 *    the real media id.
 *
 * A third, best-effort `GET /{media-id}?fields=permalink` call resolves
 * the public `instagram.com` URL — its failure is NON-fatal (the publish
 * itself already succeeded by that point); this adapter falls back to a
 * Graph API resource reference URL so `externalPostUrl` is always
 * populated (the interface's `SocialProviderPublishSuccess.externalPostUrl`
 * is non-optional).
 */
import type {
  SocialProviderAdapter,
  SocialProviderCredentialCheck,
  SocialProviderPublishRequest,
  SocialProviderPublishResult
} from "../../domain/social-provider-adapter";
import { loadMetaProviderConfig } from "../../domain/meta-provider-config";
import { validateInstagramPublishEligibility } from "../../domain/meta-publish-content";
import { normalizeMetaGraphApiError } from "../../domain/meta-error-normalization";
import {
  createMetaGraphClient,
  extractGraphResponseStringField,
  type MetaGraphClient
} from "./meta-graph-client";
import { resolveMetaTokenReference } from "./meta-token-reference-resolver";
import { verifyMetaCredentials } from "./meta-credential-verification";
import type { MetaGraphClientFactory } from "./meta-facebook-page-adapter";

export const META_INSTAGRAM_PROVIDER_KEY = "meta_instagram";

export type CreateMetaInstagramAdapterOptions = {
  /** Test-only override — defaults to `process.env` at call time. */
  env?: NodeJS.ProcessEnv;
  /** Test-only override — defaults to a real `createMetaGraphClient`. */
  graphClientFactory?: MetaGraphClientFactory;
};

async function resolveInstagramPermalink(
  client: MetaGraphClient,
  mediaId: string,
  accessToken: string
): Promise<string | null> {
  try {
    const response = await client.call({
      path: `/${mediaId}`,
      method: "GET",
      params: { fields: "permalink", access_token: accessToken }
    });

    if (response.httpStatus < 200 || response.httpStatus >= 300) {
      return null;
    }

    return extractGraphResponseStringField(response.body, "permalink");
  } catch {
    return null;
  }
}

export function createMetaInstagramAdapter(
  options: CreateMetaInstagramAdapterOptions = {}
): SocialProviderAdapter {
  const resolveEnv = (): NodeJS.ProcessEnv => options.env ?? process.env;
  const graphClientFactory: MetaGraphClientFactory =
    options.graphClientFactory ??
    ((graphApiVersion) => createMetaGraphClient({ graphApiVersion }));

  return {
    providerKey: META_INSTAGRAM_PROVIDER_KEY,
    requiredEnvVars: [
      "META_PROVIDER_ENABLED",
      "META_APP_ID",
      "META_APP_SECRET_REFERENCE",
      "META_GRAPH_API_VERSION",
      "META_OAUTH_REDIRECT_URI",
      "META_REQUIRED_SCOPES"
    ],
    // Instagram professional/business accounts are connected as a
    // `"page"`-type row (see this module's own header / `social-publish-
    // content.ts` — Meta always publishes to Instagram via the linked
    // Page's access token, there is no standalone "profile"-type
    // Instagram credential this adapter supports).
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

      const eligibility = validateInstagramPublishEligibility(
        request.content,
        env
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

      const createResponse = await client.call({
        path: `/${request.providerAccountId}/media`,
        method: "POST",
        params: {
          // Eligibility already guaranteed `content.imageUrl` is non-null
          // and verified (`validateInstagramPublishEligibility` above).
          image_url: request.content.imageUrl!,
          caption: request.content.excerptOrCaption,
          access_token: credential.value
        }
      });

      if (createResponse.httpStatus < 200 || createResponse.httpStatus >= 300) {
        return normalizeMetaGraphApiError(
          createResponse.httpStatus,
          createResponse.body
        );
      }

      const creationId = extractGraphResponseStringField(
        createResponse.body,
        "id"
      );

      if (!creationId) {
        return {
          outcome: "failed",
          errorCode: "meta_unexpected_response",
          errorMessage: "Meta API did not return a media container id.",
          retryable: true
        };
      }

      const publishResponse = await client.call({
        path: `/${request.providerAccountId}/media_publish`,
        method: "POST",
        params: {
          creation_id: creationId,
          access_token: credential.value
        }
      });

      if (
        publishResponse.httpStatus < 200 ||
        publishResponse.httpStatus >= 300
      ) {
        return normalizeMetaGraphApiError(
          publishResponse.httpStatus,
          publishResponse.body
        );
      }

      const mediaId = extractGraphResponseStringField(
        publishResponse.body,
        "id"
      );

      if (!mediaId) {
        return {
          outcome: "failed",
          errorCode: "meta_unexpected_response",
          errorMessage:
            "Meta API published the media container but returned no media id.",
          retryable: true
        };
      }

      const permalink = await resolveInstagramPermalink(
        client,
        mediaId,
        credential.value
      );

      return {
        outcome: "published",
        externalPostId: mediaId,
        externalPostUrl: permalink ?? `https://graph.facebook.com/${mediaId}`
      };
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
