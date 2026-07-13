/**
 * Unit tests for the Meta Instagram adapter (Issue #644) — every Graph API
 * call is a FAKE `MetaGraphClient` (never a real `fetch`/network call).
 * Covers the 2-call publish flow (create media container -> publish),
 * the best-effort permalink resolution, and the "Instagram publishing
 * validates account eligibility and provider-supported content type
 * before job execution" acceptance criterion.
 */
import { describe, expect, test } from "bun:test";

import { createMetaInstagramAdapter } from "../../src/modules/social-publishing/infrastructure/meta/meta-instagram-adapter";
import type {
  MetaGraphCallRequest,
  MetaGraphCallResponse,
  MetaGraphClient
} from "../../src/modules/social-publishing/infrastructure/meta/meta-graph-client";
import type { SocialProviderPublishRequest } from "../../src/modules/social-publishing/domain/social-provider-adapter";

const VALID_ENV = {
  META_PROVIDER_ENABLED: "true",
  META_APP_ID: "1234567890",
  META_APP_SECRET_REFERENCE: "env:META_APP_SECRET",
  META_GRAPH_API_VERSION: "v21.0",
  META_OAUTH_REDIRECT_URI: "https://example.com/auth/meta/callback",
  META_REQUIRED_SCOPES: "instagram_content_publish",
  SOCIAL_TOKEN_IG_42: "EAAfakepageaccesstoken",
  META_APP_SECRET: "fake-app-secret-value",
  NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://media.example.com"
} satisfies NodeJS.ProcessEnv;

function fakeGraphClient(
  queuedResponses: MetaGraphCallResponse[]
): MetaGraphClient & { calls: MetaGraphCallRequest[] } {
  const calls: MetaGraphCallRequest[] = [];
  let index = 0;

  return {
    calls,
    async call(request: MetaGraphCallRequest): Promise<MetaGraphCallResponse> {
      calls.push(request);
      const response = queuedResponses[index] ?? queuedResponses.at(-1)!;
      index += 1;
      return response;
    }
  };
}

function baseRequest(
  overrides: Partial<SocialProviderPublishRequest> = {}
): SocialProviderPublishRequest {
  return {
    tenantId: "tenant-1",
    providerAccountId: "ig-1234",
    tokenReference: "env:SOCIAL_TOKEN_IG_42",
    idempotencyKey: "idem-1",
    content: {
      title: "Hello world",
      excerptOrCaption: "An eligible article about the world.",
      canonicalUrl: "https://tenant.example.test/news/hello-world",
      imageUrl: "https://media.example.com/news/1/photo.jpg"
    },
    ...overrides
  };
}

describe("createMetaInstagramAdapter — publish (Issue #644)", () => {
  test("providerKey and supportedAccountTypes", () => {
    const adapter = createMetaInstagramAdapter({ env: VALID_ENV });
    expect(adapter.providerKey).toBe("meta_instagram");
    expect(adapter.supportedAccountTypes).toEqual(["page"]);
  });

  test("unsupported_content_type when the article has no image — Instagram has no text-only post", async () => {
    const client = fakeGraphClient([]);
    const adapter = createMetaInstagramAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const result = await adapter.publish(
      baseRequest({
        content: {
          title: "Hello",
          excerptOrCaption: "caption",
          canonicalUrl: "https://tenant.example.test/news/hello",
          imageUrl: null
        }
      })
    );
    expect(result).toEqual({
      outcome: "failed",
      errorCode: "unsupported_content_type",
      errorMessage: expect.any(String),
      retryable: false
    });
    expect(client.calls).toHaveLength(0);
  });

  test("unverified_media_url when the image URL is not from the configured R2 origin (Issue #644: 'R2 image URLs used for provider media must come from verified media objects')", async () => {
    const client = fakeGraphClient([]);
    const adapter = createMetaInstagramAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const result = await adapter.publish(
      baseRequest({
        content: {
          title: "Hello",
          excerptOrCaption: "caption",
          canonicalUrl: "https://tenant.example.test/news/hello",
          imageUrl: "https://evil.example.com/photo.jpg"
        }
      })
    );
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorCode).toBe("unverified_media_url");
    }
    expect(client.calls).toHaveLength(0);
  });

  test("successful publish: create media container, publish it, resolve permalink", async () => {
    const client = fakeGraphClient([
      { httpStatus: 200, body: { id: "container-1" } },
      { httpStatus: 200, body: { id: "media-999" } },
      {
        httpStatus: 200,
        body: { permalink: "https://www.instagram.com/p/AbC123/" }
      }
    ]);
    const adapter = createMetaInstagramAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const result = await adapter.publish(baseRequest());

    expect(result).toEqual({
      outcome: "published",
      externalPostId: "media-999",
      externalPostUrl: "https://www.instagram.com/p/AbC123/"
    });
    expect(client.calls).toHaveLength(3);
    expect(client.calls[0]!.path).toBe("/ig-1234/media");
    expect(client.calls[0]!.params.image_url).toBe(
      "https://media.example.com/news/1/photo.jpg"
    );
    expect(client.calls[1]!.path).toBe("/ig-1234/media_publish");
    expect(client.calls[1]!.params.creation_id).toBe("container-1");
    expect(client.calls[2]!.path).toBe("/media-999");
  });

  test("publish still succeeds if the best-effort permalink lookup fails — falls back to a Graph API resource URL", async () => {
    const client = fakeGraphClient([
      { httpStatus: 200, body: { id: "container-1" } },
      { httpStatus: 200, body: { id: "media-999" } },
      { httpStatus: 500, body: {} }
    ]);
    const adapter = createMetaInstagramAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const result = await adapter.publish(baseRequest());
    expect(result).toEqual({
      outcome: "published",
      externalPostId: "media-999",
      externalPostUrl: "https://graph.facebook.com/media-999"
    });
  });

  test("a container-creation failure is normalized and never reaches the publish/permalink calls", async () => {
    const client = fakeGraphClient([
      {
        httpStatus: 400,
        body: { error: { message: "bad image", code: 100 } }
      }
    ]);
    const adapter = createMetaInstagramAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const result = await adapter.publish(baseRequest());
    expect(result.outcome).toBe("failed");
    expect(client.calls).toHaveLength(1);
  });

  test("an expired token error during container creation normalizes to needs_reauth", async () => {
    const client = fakeGraphClient([
      {
        httpStatus: 401,
        body: { error: { type: "OAuthException", code: 190 } }
      }
    ]);
    const adapter = createMetaInstagramAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const result = await adapter.publish(baseRequest());
    expect(result.outcome).toBe("needs_reauth");
  });
});

describe("createMetaInstagramAdapter — verifyCredentials (Issue #644, providerAccountId param Issue #646)", () => {
  test("valid when debug_token reports is_valid=true, unexpired, all required scopes present, AND the token can reach the specific target Instagram Business account", async () => {
    const client = fakeGraphClient([
      {
        httpStatus: 200,
        body: {
          data: {
            is_valid: true,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            scopes: ["instagram_content_publish"]
          }
        }
      },
      { httpStatus: 200, body: { id: "ig-1234" } }
    ]);
    const adapter = createMetaInstagramAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const result = await adapter.verifyCredentials(
      "env:SOCIAL_TOKEN_IG_42",
      "ig-1234",
      [],
      VALID_ENV
    );
    expect(result).toEqual({
      valid: true,
      details: { permissions: ["instagram_content_publish"] }
    });
    expect(client.calls[1]!.path).toBe("/ig-1234");
  });

  test("invalid — token valid but cannot reach the specific target Instagram account", async () => {
    const client = fakeGraphClient([
      {
        httpStatus: 200,
        body: {
          data: {
            is_valid: true,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            scopes: ["instagram_content_publish"]
          }
        }
      },
      { httpStatus: 403, body: { error: { message: "no access", code: 10 } } }
    ]);
    const adapter = createMetaInstagramAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const result = await adapter.verifyCredentials(
      "env:SOCIAL_TOKEN_IG_42",
      "ig-1234",
      [],
      VALID_ENV
    );
    expect(result).toEqual({ valid: false, reason: "target_not_accessible" });
  });
});

describe("createMetaInstagramAdapter — idempotency (Issue #644)", () => {
  test("calling publish() twice with the same idempotencyKey issues two independent Graph API attempts — duplicate prevention is the dispatcher's job (job status transition), not this adapter's; documents the residual honestly", async () => {
    const client = fakeGraphClient([
      { httpStatus: 200, body: { id: "container-1" } },
      { httpStatus: 200, body: { id: "media-999" } },
      {
        httpStatus: 200,
        body: { permalink: "https://www.instagram.com/p/AbC123/" }
      },
      { httpStatus: 200, body: { id: "container-2" } },
      { httpStatus: 200, body: { id: "media-1000" } },
      {
        httpStatus: 200,
        body: { permalink: "https://www.instagram.com/p/DeF456/" }
      }
    ]);
    const adapter = createMetaInstagramAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const request = baseRequest({ idempotencyKey: "same-key" });
    const first = await adapter.publish(request);
    expect(first.outcome).toBe("published");

    // A second call with the identical idempotencyKey still reaches the
    // adapter (Meta's Graph API has no client-supplied dedup parameter for
    // these endpoints) — real duplicate prevention is enforced upstream:
    // the outbox dispatcher only ever calls `publish()` for a job still in
    // `pending`/`approved` status (`social-publish-dispatch.ts`'s CLAIM
    // query), and a job that reached `published` is never reclaimed. See
    // `tests/integration/social-publishing.integration.test.ts` and
    // `tests/unit/social-publish-idempotency.test.ts` for that mechanism's
    // own coverage.
    const second = await adapter.publish(request);
    expect(second.outcome).toBe("published");
    expect(client.calls).toHaveLength(6);
  });
});
