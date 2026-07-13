/**
 * Unit tests for the Meta Facebook Page adapter (Issue #644) — every Graph
 * API call is a FAKE `MetaGraphClient` (never a real `fetch`/network call,
 * per the issue's own hard requirement: "real HTTP calls to Meta's API
 * must be mocked in tests").
 */
import { describe, expect, test } from "bun:test";

import { createMetaFacebookPageAdapter } from "../../src/modules/social-publishing/infrastructure/meta/meta-facebook-page-adapter";
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
  META_REQUIRED_SCOPES: "pages_manage_posts,pages_read_engagement",
  SOCIAL_TOKEN_FB_PAGE_42: "EAAfakepageaccesstoken",
  META_APP_SECRET: "fake-app-secret-value"
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
    providerAccountId: "1234",
    tokenReference: "env:SOCIAL_TOKEN_FB_PAGE_42",
    idempotencyKey: "idem-1",
    content: {
      title: "Hello world",
      excerptOrCaption: "An eligible article about the world.",
      canonicalUrl: "https://tenant.example.test/news/hello-world",
      imageUrl: null
    },
    ...overrides
  };
}

describe("createMetaFacebookPageAdapter — publish (Issue #644)", () => {
  test("providerKey and supportedAccountTypes", () => {
    const adapter = createMetaFacebookPageAdapter({ env: VALID_ENV });
    expect(adapter.providerKey).toBe("meta_facebook_page");
    expect(adapter.supportedAccountTypes).toEqual(["page"]);
  });

  test("meta_provider_not_configured when META_PROVIDER_ENABLED is not true", async () => {
    const adapter = createMetaFacebookPageAdapter({
      env: { META_PROVIDER_ENABLED: "false" },
      graphClientFactory: () => fakeGraphClient([])
    });
    const result = await adapter.publish(baseRequest());
    expect(result).toEqual({
      outcome: "failed",
      errorCode: "meta_provider_not_configured",
      errorMessage: expect.any(String),
      retryable: false
    });
  });

  test("rejects ineligible content (missing caption) before ever calling Graph API", async () => {
    const client = fakeGraphClient([]);
    const adapter = createMetaFacebookPageAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });
    const result = await adapter.publish(
      baseRequest({
        content: {
          title: "x",
          excerptOrCaption: "",
          canonicalUrl: "https://tenant.example.test/news/x",
          imageUrl: null
        }
      })
    );
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorCode).toBe("missing_caption");
    }
    expect(client.calls.length).toBe(0);
  });

  test("needs_reauth when tokenReference cannot be resolved (unsupported scheme in this deployment)", async () => {
    const client = fakeGraphClient([]);
    const adapter = createMetaFacebookPageAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });
    const result = await adapter.publish(
      baseRequest({ tokenReference: "secretsmanager:social/fb-page-42" })
    );
    expect(result.outcome).toBe("needs_reauth");
    expect(client.calls.length).toBe(0);
  });

  test("successful publish: posts message+link to /{page-id}/feed and builds a facebook.com permalink", async () => {
    const client = fakeGraphClient([
      { httpStatus: 200, body: { id: "1234_987654321" } }
    ]);
    const adapter = createMetaFacebookPageAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const result = await adapter.publish(baseRequest());

    expect(result).toEqual({
      outcome: "published",
      externalPostId: "1234_987654321",
      externalPostUrl: "https://www.facebook.com/1234/posts/987654321"
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.path).toBe("/1234/feed");
    expect(client.calls[0]!.params.message).toBe(
      "An eligible article about the world."
    );
    expect(client.calls[0]!.params.link).toBe(
      "https://tenant.example.test/news/hello-world"
    );
    expect(client.calls[0]!.params.access_token).toBe("EAAfakepageaccesstoken");
  });

  test("an expired/invalid token error from Meta normalizes to needs_reauth, not retryable, no raw Meta message leaked", async () => {
    const client = fakeGraphClient([
      {
        httpStatus: 401,
        body: {
          error: {
            message: "Error validating access token: Session has expired.",
            type: "OAuthException",
            code: 190
          }
        }
      }
    ]);
    const adapter = createMetaFacebookPageAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const result = await adapter.publish(baseRequest());
    expect(result.outcome).toBe("needs_reauth");
    expect(JSON.stringify(result)).not.toContain("Session has expired");
  });

  test("a rate-limit error from Meta normalizes to rate_limited, retryable", async () => {
    const client = fakeGraphClient([
      { httpStatus: 400, body: { error: { message: "limited", code: 32 } } }
    ]);
    const adapter = createMetaFacebookPageAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const result = await adapter.publish(baseRequest());
    expect(result.outcome).toBe("rate_limited");
    if (result.outcome === "rate_limited") {
      expect(result.retryable).toBe(true);
    }
  });

  test("a 2xx response missing an id is a retryable failed (unexpected shape, not the adapter's fault)", async () => {
    const client = fakeGraphClient([{ httpStatus: 200, body: {} }]);
    const adapter = createMetaFacebookPageAdapter({
      env: VALID_ENV,
      graphClientFactory: () => client
    });

    const result = await adapter.publish(baseRequest());
    expect(result).toEqual({
      outcome: "failed",
      errorCode: "meta_unexpected_response",
      errorMessage: expect.any(String),
      retryable: true
    });
  });
});

describe("createMetaFacebookPageAdapter — verifyCredentials (Issue #644, providerAccountId param Issue #646)", () => {
  test("valid when debug_token reports is_valid=true, unexpired, all required scopes present, AND the token can reach the specific target page", async () => {
    const client = fakeGraphClient([
      {
        httpStatus: 200,
        body: {
          data: {
            is_valid: true,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            scopes: [
              "pages_manage_posts",
              "pages_read_engagement",
              "extra_scope"
            ]
          }
        }
      },
      { httpStatus: 200, body: { id: "1234" } }
    ]);
    const adapter = createMetaFacebookPageAdapter({
      graphClientFactory: () => client
    });

    const result = await adapter.verifyCredentials(
      "env:SOCIAL_TOKEN_FB_PAGE_42",
      "1234",
      [],
      VALID_ENV
    );
    expect(result).toEqual({
      valid: true,
      details: {
        permissions: [
          "pages_manage_posts",
          "pages_read_engagement",
          "extra_scope"
        ]
      }
    });
    expect(client.calls[1]!.path).toBe("/1234");
  });

  test("invalid — token valid but cannot reach the specific target page (e.g. removed as page admin)", async () => {
    const client = fakeGraphClient([
      {
        httpStatus: 200,
        body: {
          data: {
            is_valid: true,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            scopes: ["pages_manage_posts", "pages_read_engagement"]
          }
        }
      },
      { httpStatus: 403, body: { error: { message: "no access", code: 10 } } }
    ]);
    const adapter = createMetaFacebookPageAdapter({
      graphClientFactory: () => client
    });

    const result = await adapter.verifyCredentials(
      "env:SOCIAL_TOKEN_FB_PAGE_42",
      "1234",
      [],
      VALID_ENV
    );
    expect(result).toEqual({ valid: false, reason: "target_not_accessible" });
  });

  test("invalid — missing required scopes", async () => {
    const client = fakeGraphClient([
      {
        httpStatus: 200,
        body: {
          data: {
            is_valid: true,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            scopes: ["pages_manage_posts"]
          }
        }
      }
    ]);
    const adapter = createMetaFacebookPageAdapter({
      graphClientFactory: () => client
    });

    const result = await adapter.verifyCredentials(
      "env:SOCIAL_TOKEN_FB_PAGE_42",
      "1234",
      [],
      VALID_ENV
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("pages_read_engagement");
  });

  test("invalid — expired token", async () => {
    const client = fakeGraphClient([
      {
        httpStatus: 200,
        body: {
          data: {
            is_valid: true,
            expires_at: Math.floor(Date.now() / 1000) - 3600,
            scopes: ["pages_manage_posts", "pages_read_engagement"]
          }
        }
      }
    ]);
    const adapter = createMetaFacebookPageAdapter({
      graphClientFactory: () => client
    });

    const result = await adapter.verifyCredentials(
      "env:SOCIAL_TOKEN_FB_PAGE_42",
      "1234",
      [],
      VALID_ENV
    );
    expect(result).toEqual({ valid: false, reason: "token_expired" });
  });

  test("invalid — Meta reports is_valid=false", async () => {
    const client = fakeGraphClient([
      { httpStatus: 200, body: { data: { is_valid: false, scopes: [] } } }
    ]);
    const adapter = createMetaFacebookPageAdapter({
      graphClientFactory: () => client
    });

    const result = await adapter.verifyCredentials(
      "env:SOCIAL_TOKEN_FB_PAGE_42",
      "1234",
      [],
      VALID_ENV
    );
    expect(result).toEqual({ valid: false, reason: "token_invalid" });
  });

  test("never throws even if the graph client rejects", async () => {
    const throwingClient: MetaGraphClient = {
      async call() {
        throw new Error("network error");
      }
    };
    const adapter = createMetaFacebookPageAdapter({
      graphClientFactory: () => throwingClient
    });

    const result = await adapter.verifyCredentials(
      "env:SOCIAL_TOKEN_FB_PAGE_42",
      "1234",
      [],
      VALID_ENV
    );
    expect(result.valid).toBe(false);
  });
});
