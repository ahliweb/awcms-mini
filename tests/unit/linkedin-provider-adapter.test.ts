import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createLinkedInProviderAdapter,
  isTrustedR2MediaUrl,
  LINKEDIN_PROVIDER_KEY,
  registerLinkedInProviderAdapterIfEnabled
} from "../../src/modules/social-publishing/infrastructure/linkedin-provider-adapter";
import {
  getSocialProviderAdapter,
  resetSocialProviderRegistryForTests
} from "../../src/modules/social-publishing/infrastructure/social-provider-registry";
import type { SocialProviderPublishRequest } from "../../src/modules/social-publishing/domain/social-provider-adapter";

const TEST_TOKEN = "fake-bearer-token-value-1234567890";

function buildEnv(
  overrides: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return {
    LINKEDIN_PROVIDER_ENABLED: "true",
    LINKEDIN_CLIENT_ID: "client-abc",
    LINKEDIN_CLIENT_SECRET_REFERENCE: "env:LINKEDIN_CLIENT_SECRET_ACTUAL",
    LINKEDIN_API_VERSION: "202506",
    LINKEDIN_OAUTH_REDIRECT_URI: "https://app.example.com/callback",
    LINKEDIN_REQUIRED_SCOPES:
      "w_organization_social,r_organization_social,rw_organization_admin",
    TEST_LINKEDIN_TOKEN: TEST_TOKEN,
    ...overrides
  } as NodeJS.ProcessEnv;
}

function buildRequest(
  overrides: Partial<SocialProviderPublishRequest> = {}
): SocialProviderPublishRequest {
  return {
    tenantId: "11111111-1111-1111-1111-111111111111",
    providerAccountId: "urn:li:organization:12345",
    tokenReference: "env:TEST_LINKEDIN_TOKEN",
    idempotencyKey: "job-abc-123",
    content: {
      title: "Test Article",
      excerptOrCaption: "A short caption for the article.",
      canonicalUrl: "https://news.example.com/news/test-article",
      imageUrl: null
    },
    correlationId: "corr-1",
    ...overrides
  };
}

describe("createLinkedInProviderAdapter — providerKey (Issue #645)", () => {
  test("providerKey is linkedin_organization", () => {
    const adapter = createLinkedInProviderAdapter();
    expect(adapter.providerKey).toBe(LINKEDIN_PROVIDER_KEY);
  });
});

describe("verifyCredentials (Issue #645)", () => {
  const TEST_ORGANIZATION_URN = "urn:li:organization:12345";

  test("invalid — missing required scopes", async () => {
    const adapter = createLinkedInProviderAdapter({ env: buildEnv() });

    const result = await adapter.verifyCredentials(
      "env:TEST_LINKEDIN_TOKEN",
      TEST_ORGANIZATION_URN,
      ["w_organization_social"], // missing r_organization_social/rw_organization_admin
      buildEnv()
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("missing_scopes");
    expect(result.reason).toContain("r_organization_social");
  });

  test("invalid — missing client config", async () => {
    const adapter = createLinkedInProviderAdapter();

    const result = await adapter.verifyCredentials(
      "env:TEST_LINKEDIN_TOKEN",
      TEST_ORGANIZATION_URN,
      [
        "w_organization_social",
        "r_organization_social",
        "rw_organization_admin"
      ],
      buildEnv({
        LINKEDIN_PROVIDER_ENABLED: "true",
        LINKEDIN_CLIENT_ID: undefined
      } as unknown as NodeJS.ProcessEnv)
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("missing_client_config");
  });

  test("invalid — token expired (LinkedIn userinfo returns 401)", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("unauthorized", { status: 401 });
      }
    });

    const env = buildEnv();
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.verifyCredentials(
      "env:TEST_LINKEDIN_TOKEN",
      TEST_ORGANIZATION_URN,
      [
        "w_organization_social",
        "r_organization_social",
        "rw_organization_admin"
      ],
      env
    );

    expect(result).toEqual({ valid: false, reason: "token_expired" });
  });

  test("invalid — token valid but unsupported organization role for this target", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/v2/userinfo") {
          return Response.json({ sub: "member-123" });
        }
        if (pathname === "/rest/organizationAcls") {
          return Response.json({
            elements: [{ role: "VIEWER", state: "APPROVED" }]
          });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const env = buildEnv();
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.verifyCredentials(
      "env:TEST_LINKEDIN_TOKEN",
      TEST_ORGANIZATION_URN,
      [
        "w_organization_social",
        "r_organization_social",
        "rw_organization_admin"
      ],
      env
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("unsupported_organization_role");
  });

  test("valid — token accepted, scopes satisfied, supported organization role for this target", async () => {
    // Object wrapper (not a plain `let`) — TypeScript's control-flow
    // narrowing does not track a plain `let` being reassigned inside a
    // callback invoked later/asynchronously (Bun.serve's `fetch` handler),
    // so a bare `let x: Headers | null = null` reads back as narrowed to
    // `null` at the assertion below. A wrapped property is not narrowed
    // the same way once the object has been passed across an awaited call.
    const captured: { userinfoHeaders: Headers | null } = {
      userinfoHeaders: null
    };

    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/v2/userinfo") {
          captured.userinfoHeaders = request.headers;
          return Response.json({ sub: "member-123" });
        }
        if (pathname === "/rest/organizationAcls") {
          return Response.json({
            elements: [{ role: "ADMINISTRATOR", state: "APPROVED" }]
          });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const env = buildEnv();
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.verifyCredentials(
      "env:TEST_LINKEDIN_TOKEN",
      TEST_ORGANIZATION_URN,
      [
        "w_organization_social",
        "r_organization_social",
        "rw_organization_admin"
      ],
      env
    );

    expect(result).toEqual({ valid: true, details: { role: "ADMINISTRATOR" } });
    expect(captured.userinfoHeaders?.get("linkedin-version")).toBe("202506");
    expect(captured.userinfoHeaders?.get("authorization")).toBe(
      `Bearer ${TEST_TOKEN}`
    );
  });
});

describe("publish — organization role enforcement (Issue #645)", () => {
  test("fails (non-retryable) on an unsupported organization role", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/rest/organizationAcls") {
          return Response.json({
            elements: [{ role: "VIEWER", state: "APPROVED" }]
          });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const env = buildEnv();
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.publish(buildRequest());

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorCode).toBe("unsupported_organization_role");
      expect(result.retryable).toBe(false);
    }
  });

  test("fails (non-retryable) when no approved role exists at all", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/rest/organizationAcls") {
          return Response.json({ elements: [] });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const env = buildEnv();
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.publish(buildRequest());

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorCode).toBe("unsupported_organization_role");
    }
  });

  test("needs_reauth when the role check itself returns 401 (expired token)", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/rest/organizationAcls") {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const env = buildEnv();
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.publish(buildRequest());

    expect(result.outcome).toBe("needs_reauth");
    if (result.outcome === "needs_reauth") {
      expect(result.errorCode).toBe("token_expired");
      expect(result.retryable).toBe(false);
    }
  });

  test("needs_reauth when the post-creation call itself returns 401", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/rest/organizationAcls") {
          return Response.json({
            elements: [{ role: "ADMINISTRATOR", state: "APPROVED" }]
          });
        }
        if (pathname === "/rest/posts") {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const env = buildEnv();
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.publish(buildRequest());

    expect(result.outcome).toBe("needs_reauth");
  });
});

describe("publish — successful text-only post (Issue #645)", () => {
  test("returns published with external post id/url, sends versioned headers + idempotency header", async () => {
    const capturedRequests: {
      pathname: string;
      headers: Headers;
      body: string;
    }[] = [];

    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        const body = await request.text().catch(() => "");
        capturedRequests.push({ pathname, headers: request.headers, body });

        if (pathname === "/rest/organizationAcls") {
          return Response.json({
            elements: [{ role: "ADMINISTRATOR", state: "APPROVED" }]
          });
        }

        if (pathname === "/rest/posts") {
          return new Response(null, {
            status: 201,
            headers: { "x-restli-id": "urn:li:share:999888777" }
          });
        }

        return new Response("not found", { status: 404 });
      }
    });

    const env = buildEnv();
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.publish(buildRequest());

    expect(result).toEqual({
      outcome: "published",
      externalPostId: "urn:li:share:999888777",
      externalPostUrl:
        "https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A999888777/"
    });

    const postsCall = capturedRequests.find(
      (call) => call.pathname === "/rest/posts"
    );
    expect(postsCall).toBeDefined();
    expect(postsCall?.headers.get("linkedin-version")).toBe("202506");
    expect(postsCall?.headers.get("x-restli-protocol-version")).toBe("2.0.0");
    expect(postsCall?.headers.get("x-idempotency-key")).toBe("job-abc-123");

    const postedBody = JSON.parse(postsCall!.body);
    expect(postedBody.author).toBe("urn:li:organization:12345");
    expect(postedBody.content.article.source).toBe(
      "https://news.example.com/news/test-article"
    );
  });
});

describe("publish — rate limiting (Issue #645)", () => {
  test("rate_limited outcome parses Retry-After", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/rest/organizationAcls") {
          return Response.json({
            elements: [{ role: "ADMINISTRATOR", state: "APPROVED" }]
          });
        }
        if (pathname === "/rest/posts") {
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "45" }
          });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const env = buildEnv();
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.publish(buildRequest());

    expect(result.outcome).toBe("rate_limited");
    if (result.outcome === "rate_limited") {
      expect(result.retryAfterSeconds).toBe(45);
    }
  });
});

describe("publish — secret redaction (Issue #645)", () => {
  test("never echoes the bearer token back in an error message", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/rest/organizationAcls") {
          // A misbehaving/compromised endpoint echoing the Authorization
          // header back in an error body — this adapter must still never
          // let the literal token value reach the returned error message.
          return new Response(
            `Forbidden — request had header Authorization: Bearer ${TEST_TOKEN}`,
            { status: 403 }
          );
        }
        return new Response("not found", { status: 404 });
      }
    });

    const env = buildEnv();
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.publish(buildRequest());

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorMessage).not.toContain(TEST_TOKEN);
      expect(result.errorMessage).toContain("[REDACTED]");
    }
  });

  // Critical finding (PR #737 review): an earlier version called
  // `redact(truncate(message, 500), token)` — truncate BEFORE redact.
  // `redact()` only matches a COMPLETE occurrence of the token via
  // `.split(token)`; if truncation cuts the token in half, the surviving
  // fragment no longer equals the full token, so `.split()` silently
  // fails to match it and the fragment stays in the clear. This fixture
  // computes the padding needed (accounting for the adapter's own fixed
  // "LinkedIn organizationAcls check failed (HTTP 403): " prefix text, not
  // just the raw response body) so the token straddles the 500-char
  // truncation cutoff in the FINAL constructed message — not just within
  // the raw body — regardless of exact adapter-internal prefix wording.
  test("never leaks a partial token fragment when the token straddles the truncation boundary", async () => {
    const MAX_ERROR_MESSAGE_LENGTH = 500;
    // Mirrors the exact fixed text `publish()` prepends to the raw
    // organizationAcls response body for this error path.
    const fixedMessagePrefix =
      "LinkedIn organizationAcls check failed (HTTP 403): ";

    // Margin (chars) between where the token STARTS and the truncation
    // cutoff — deliberately generous (20, not just barely over the
    // boundary) so that even under the OLD, buggy truncate-before-redact
    // ordering, a guaranteed, substantial fragment of the real token
    // (computed below) would survive truncation intact — this fixture
    // must be strong enough to have actually failed against that bug,
    // not merely pass by coincidence against a fragment shorter than
    // whatever a real regression would leak.
    const MARGIN_BEFORE_CUTOFF = 20;

    const paddingLength = Math.max(
      MAX_ERROR_MESSAGE_LENGTH -
        fixedMessagePrefix.length -
        MARGIN_BEFORE_CUTOFF,
      0
    );
    const prefix = "x".repeat(paddingLength);
    const suffix = "y".repeat(100);
    const longBody = `${prefix}${TEST_TOKEN}${suffix}`;

    // Sanity-check the fixture itself actually exercises the boundary
    // this test is about, against the FULL message the adapter
    // constructs (fixed prefix + body) — if these ever stop holding, the
    // fixture no longer reproduces the bug and must be adjusted, not the
    // assertions below.
    const tokenStartInFullMessage = fixedMessagePrefix.length + prefix.length;
    expect(tokenStartInFullMessage).toBeLessThan(MAX_ERROR_MESSAGE_LENGTH);
    expect(tokenStartInFullMessage + TEST_TOKEN.length).toBeGreaterThan(
      MAX_ERROR_MESSAGE_LENGTH
    );
    expect(fixedMessagePrefix.length + longBody.length).toBeGreaterThan(
      MAX_ERROR_MESSAGE_LENGTH
    );

    // `truncate()` keeps `slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)` — i.e.
    // absolute indices `0..(MAX_ERROR_MESSAGE_LENGTH - 2)`. Under the OLD
    // (buggy) ordering, whatever portion of the token falls within that
    // range would survive un-redacted (since `redact()` can no longer
    // match the now-incomplete token). Confirm that guaranteed leak would
    // have been long enough for the fragment check below to catch —
    // otherwise this fixture doesn't actually prove anything.
    const guaranteedLeakLengthUnderOldBug =
      MAX_ERROR_MESSAGE_LENGTH - 1 - tokenStartInFullMessage;
    const FRAGMENT_CHECK_LENGTH = 8;
    expect(guaranteedLeakLengthUnderOldBug).toBeGreaterThanOrEqual(
      FRAGMENT_CHECK_LENGTH
    );

    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/rest/organizationAcls") {
          return new Response(longBody, { status: 403 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const env = buildEnv();
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.publish(buildRequest());

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorMessage).not.toContain(TEST_TOKEN);
      // Not just "doesn't contain the full token" — must not contain even
      // a meaningful fragment of it. `guaranteedLeakLengthUnderOldBug`
      // above proves the old (buggy) ordering would have left at least
      // this many real characters of the token exposed, un-redacted.
      expect(result.errorMessage).not.toContain(
        TEST_TOKEN.slice(0, FRAGMENT_CHECK_LENGTH)
      );
      // The redaction marker itself is short and non-secret, so it is
      // harmless for IT to straddle the truncation cutoff (unlike the
      // real token) — only check for its (possibly truncated) prefix.
      expect(result.errorMessage).toContain("[REDACT");
      expect(result.errorMessage.length).toBeLessThanOrEqual(
        MAX_ERROR_MESSAGE_LENGTH
      );
    }
  });
});

describe("isTrustedR2MediaUrl (Issue #645)", () => {
  test("true only when the URL starts with the configured R2 public base URL", () => {
    const env = {
      NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://media.example.com"
    } as NodeJS.ProcessEnv;

    expect(
      isTrustedR2MediaUrl("https://media.example.com/photo.jpg", env)
    ).toBe(true);
    expect(
      isTrustedR2MediaUrl("https://attacker.example.com/photo.jpg", env)
    ).toBe(false);
  });

  test("false when NEWS_MEDIA_R2_PUBLIC_BASE_URL is unset", () => {
    expect(
      isTrustedR2MediaUrl(
        "https://media.example.com/photo.jpg",
        {} as NodeJS.ProcessEnv
      )
    ).toBe(false);
  });
});

describe("publish — R2 image validation (Issue #645)", () => {
  test("untrusted image URL is never uploaded — falls back to a link-share post", async () => {
    const calledPathnames: string[] = [];

    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        calledPathnames.push(pathname);

        if (pathname === "/rest/organizationAcls") {
          return Response.json({
            elements: [{ role: "ADMINISTRATOR", state: "APPROVED" }]
          });
        }
        if (pathname === "/rest/posts") {
          return new Response(null, {
            status: 201,
            headers: { "x-restli-id": "urn:li:share:1" }
          });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const env = buildEnv({
      NEWS_MEDIA_R2_PUBLIC_BASE_URL: `http://127.0.0.1:${server.port}`
    } as NodeJS.ProcessEnv);
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.publish(
      buildRequest({
        content: {
          title: "Test",
          excerptOrCaption: "Caption",
          canonicalUrl: "https://news.example.com/news/test",
          // NOT served from the configured R2 public base — untrusted.
          imageUrl: "https://attacker.example.com/fake.jpg"
        }
      })
    );

    expect(result.outcome).toBe("published");
    expect(calledPathnames).not.toContain("/rest/images");
  });

  test("trusted R2 image URL triggers the real upload flow and an image-attached post", async () => {
    const calledPathnames: string[] = [];
    const captured: { postsBody: string | null } = { postsBody: null };
    // Declared before the server and assigned right after — the handler
    // below is only ever INVOKED later (on a real request), by which point
    // this has already been set, but referencing `server.port` directly
    // inside its own initializer is a genuine self-reference TypeScript
    // cannot type (see `server` below).
    let serverPort = 0;

    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        calledPathnames.push(pathname);

        if (pathname === "/rest/organizationAcls") {
          return Response.json({
            elements: [{ role: "ADMINISTRATOR", state: "APPROVED" }]
          });
        }

        if (pathname === "/rest/images") {
          return Response.json({
            value: {
              uploadUrl: `http://127.0.0.1:${serverPort}/upload-target`,
              image: "urn:li:image:verified-abc"
            }
          });
        }

        if (pathname === "/fake-r2-image.jpg") {
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "content-type": "image/jpeg" }
          });
        }

        if (pathname === "/upload-target" && request.method === "PUT") {
          return new Response(null, { status: 201 });
        }

        if (pathname === "/rest/posts") {
          captured.postsBody = await request.text();
          return new Response(null, {
            status: 201,
            headers: { "x-restli-id": "urn:li:share:2" }
          });
        }

        return new Response("not found", { status: 404 });
      }
    });

    serverPort = server.port ?? 0;

    const env = buildEnv({
      NEWS_MEDIA_R2_PUBLIC_BASE_URL: `http://127.0.0.1:${server.port}`
    } as NodeJS.ProcessEnv);
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    const result = await adapter.publish(
      buildRequest({
        content: {
          title: "Test",
          excerptOrCaption: "Caption",
          canonicalUrl: "https://news.example.com/news/test",
          imageUrl: `http://127.0.0.1:${server.port}/fake-r2-image.jpg`
        }
      })
    );

    expect(result.outcome).toBe("published");
    expect(calledPathnames).toContain("/rest/images");
    expect(calledPathnames).toContain("/upload-target");
    expect(captured.postsBody).not.toBeNull();
    const postedBody = JSON.parse(captured.postsBody!);
    expect(postedBody.content.media.id).toBe("urn:li:image:verified-abc");
  });
});

describe("publish — idempotency (Issue #645)", () => {
  test("the dispatcher's idempotency key is forwarded as a header on every attempt", async () => {
    const captured: { idempotencyHeader: string | null } = {
      idempotencyHeader: null
    };

    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/rest/organizationAcls") {
          return Response.json({
            elements: [{ role: "ADMINISTRATOR", state: "APPROVED" }]
          });
        }
        if (pathname === "/rest/posts") {
          captured.idempotencyHeader = request.headers.get("x-idempotency-key");
          return new Response(null, {
            status: 201,
            headers: { "x-restli-id": "urn:li:share:idem-1" }
          });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const env = buildEnv();
    const adapter = createLinkedInProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      env
    });

    await adapter.publish(
      buildRequest({ idempotencyKey: "deterministic-job-id-42" })
    );

    expect(captured.idempotencyHeader).toBe("deterministic-job-id-42");
  });
});

describe("registerLinkedInProviderAdapterIfEnabled (Issue #645)", () => {
  beforeEach(() => {
    resetSocialProviderRegistryForTests();
  });

  afterEach(() => {
    resetSocialProviderRegistryForTests();
  });

  test("registers the adapter when LINKEDIN_PROVIDER_ENABLED=true", () => {
    registerLinkedInProviderAdapterIfEnabled(buildEnv());
    expect(getSocialProviderAdapter(LINKEDIN_PROVIDER_KEY)?.providerKey).toBe(
      LINKEDIN_PROVIDER_KEY
    );
  });

  test("does not register anything when disabled", () => {
    registerLinkedInProviderAdapterIfEnabled({
      LINKEDIN_PROVIDER_ENABLED: "false"
    } as NodeJS.ProcessEnv);
    expect(getSocialProviderAdapter(LINKEDIN_PROVIDER_KEY)).toBeUndefined();
  });
});
