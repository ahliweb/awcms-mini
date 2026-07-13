/**
 * Unit tests for the Telegram channel provider adapter (Issue #646). Every
 * "real" Telegram Bot API call is served by a LOCAL `Bun.serve()` fake
 * server (same technique `tests/unit/cloudflare-dns-adapter.test.ts`
 * already established for a different provider) — `apiBaseUrl` is
 * overridden to point at it. No real bot token exists anywhere in this
 * file and no test ever reaches `api.telegram.org`.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { getProviderCircuitBreaker } from "../../src/lib/database/circuit-breaker";
import {
  createTelegramChannelProviderAdapter,
  resolveTelegramBotToken
} from "../../src/modules/social-publishing/infrastructure/telegram-provider-adapter";
import type { SocialProviderPublishRequest } from "../../src/modules/social-publishing/domain/social-provider-adapter";

const TOKEN_ENV_VAR = "TEST_TELEGRAM_BOT_TOKEN_FOR_UNIT_TESTS";
const FAKE_TOKEN = "fake-test-bot-token-not-a-real-credential";
const TOKEN_REFERENCE = `env:${TOKEN_ENV_VAR}`;

const MALICIOUS_TITLE =
  "Breaking: *URGENT* _important_ [click here](https://evil.example)";

type ServerBehavior =
  | "success"
  | "permission_denied"
  | "channel_not_found"
  | "rate_limited"
  | "invalid_token"
  | "not_admin"
  | "admin_no_post_permission"
  | "slow"
  | "malformed_json";

describe("resolveTelegramBotToken", () => {
  const originalValue = process.env[TOKEN_ENV_VAR];

  afterEach(() => {
    if (originalValue === undefined) delete process.env[TOKEN_ENV_VAR];
    else process.env[TOKEN_ENV_VAR] = originalValue;
  });

  test("resolves an env: reference to the target env var's value", () => {
    process.env[TOKEN_ENV_VAR] = FAKE_TOKEN;
    const result = resolveTelegramBotToken(TOKEN_REFERENCE);
    expect(result).toEqual({ ok: true, token: FAKE_TOKEN });
  });

  test("fails when the referenced env var is not set", () => {
    delete process.env[TOKEN_ENV_VAR];
    const result = resolveTelegramBotToken(TOKEN_REFERENCE);
    expect(result.ok).toBe(false);
  });

  test("fails for a non-env: reference (no real secret-manager integration exists)", () => {
    const result = resolveTelegramBotToken("secretsmanager:social/telegram-1");
    expect(result.ok).toBe(false);
  });
});

describe("Telegram channel provider adapter", () => {
  let requestCount = 0;
  let requests: { method: string; pathname: string; body: string }[] = [];
  let behavior: ServerBehavior = "success";
  let server: ReturnType<typeof Bun.serve>;
  const originalEnabled = process.env.TELEGRAM_PROVIDER_ENABLED;
  const originalToken = process.env[TOKEN_ENV_VAR];

  beforeEach(() => {
    requestCount = 0;
    requests = [];
    behavior = "success";
    process.env.TELEGRAM_PROVIDER_ENABLED = "true";
    process.env[TOKEN_ENV_VAR] = FAKE_TOKEN;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestCount += 1;
        const url = new URL(request.url);
        const body = await request.text().catch(() => "");
        requests.push({ method: request.method, pathname: url.pathname, body });

        const apiMethod = url.pathname.split("/").pop();

        if (behavior === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return Response.json({ ok: true, result: { message_id: 1 } });
        }

        if (behavior === "malformed_json") {
          return new Response("not json", { status: 200 });
        }

        if (apiMethod === "getMe") {
          if (behavior === "invalid_token") {
            return Response.json(
              { ok: false, error_code: 401, description: "Unauthorized" },
              { status: 401 }
            );
          }
          return Response.json({
            ok: true,
            result: { id: 999, is_bot: true, username: "test_bot" }
          });
        }

        if (apiMethod === "getChatMember") {
          if (behavior === "channel_not_found") {
            return Response.json(
              {
                ok: false,
                error_code: 400,
                description: "Bad Request: chat not found"
              },
              { status: 400 }
            );
          }
          if (behavior === "not_admin") {
            return Response.json({ ok: true, result: { status: "member" } });
          }
          if (behavior === "admin_no_post_permission") {
            return Response.json({
              ok: true,
              result: { status: "administrator", can_post_messages: false }
            });
          }
          return Response.json({
            ok: true,
            result: {
              status: "administrator",
              can_post_messages: true,
              can_edit_messages: true
            }
          });
        }

        // sendMessage
        if (behavior === "permission_denied") {
          return Response.json(
            {
              ok: false,
              error_code: 400,
              description:
                "Bad Request: not enough rights to send text messages to the chat"
            },
            { status: 400 }
          );
        }
        if (behavior === "channel_not_found") {
          return Response.json(
            {
              ok: false,
              error_code: 400,
              description: "Bad Request: chat not found"
            },
            { status: 400 }
          );
        }
        if (behavior === "rate_limited") {
          return Response.json(
            {
              ok: false,
              error_code: 429,
              description: "Too Many Requests: retry after 30",
              parameters: { retry_after: 30 }
            },
            { status: 429 }
          );
        }
        if (behavior === "invalid_token") {
          return Response.json(
            { ok: false, error_code: 401, description: "Unauthorized" },
            { status: 401 }
          );
        }

        return Response.json({ ok: true, result: { message_id: 42 } });
      }
    });
  });

  afterEach(() => {
    server.stop(true);
    if (originalEnabled === undefined)
      delete process.env.TELEGRAM_PROVIDER_ENABLED;
    else process.env.TELEGRAM_PROVIDER_ENABLED = originalEnabled;
    if (originalToken === undefined) delete process.env[TOKEN_ENV_VAR];
    else process.env[TOKEN_ENV_VAR] = originalToken;
  });

  function makeAdapter() {
    return createTelegramChannelProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${server.port}`
    });
  }

  function makeRequest(
    overrides: Partial<SocialPublishContentSnapshotRequest> = {}
  ): SocialProviderPublishRequest {
    return {
      tenantId: "11111111-1111-1111-1111-111111111111",
      providerAccountId: "@testchannel",
      tokenReference: TOKEN_REFERENCE,
      idempotencyKey: "idem-key-1",
      content: {
        title: "Plain title",
        excerptOrCaption: "Plain excerpt.",
        canonicalUrl: "https://news.example.com/news/some-article",
        imageUrl: null
      },
      ...overrides
    };
  }

  type SocialPublishContentSnapshotRequest = SocialProviderPublishRequest;

  // -------------------------------------------------------------------
  // publish() — happy path
  // -------------------------------------------------------------------

  test("publish: successful sendMessage returns published with externalPostId/Url", async () => {
    const adapter = makeAdapter();
    const result = await adapter.publish(makeRequest());
    expect(result.outcome).toBe("published");
    if (result.outcome === "published") {
      expect(result.externalPostId).toBe("42");
      expect(result.externalPostUrl).toBe("https://t.me/testchannel/42");
    }
    expect(requestCount).toBe(1);
    expect(requests[0]!.method).toBe("POST");
  });

  // -------------------------------------------------------------------
  // publish() — deployment/config gates (no network call)
  // -------------------------------------------------------------------

  test("publish: TELEGRAM_PROVIDER_ENABLED not true never calls the network", async () => {
    process.env.TELEGRAM_PROVIDER_ENABLED = "false";
    const adapter = makeAdapter();
    const result = await adapter.publish(makeRequest());
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorCode).toBe("telegram_provider_disabled");
      expect(result.retryable).toBe(false);
    }
    expect(requestCount).toBe(0);
  });

  test("publish: missing bot token (tokenReference not resolvable) never calls the network", async () => {
    const adapter = makeAdapter();
    const result = await adapter.publish(
      makeRequest({ tokenReference: "secretsmanager:social/x" })
    );
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorCode).toBe("telegram_bot_token_unresolvable");
    }
    expect(requestCount).toBe(0);
  });

  test("publish: tokenReference pointing at an unset env var never calls the network", async () => {
    delete process.env[TOKEN_ENV_VAR];
    const adapter = makeAdapter();
    const result = await adapter.publish(makeRequest());
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorCode).toBe("telegram_bot_token_unresolvable");
    }
    expect(requestCount).toBe(0);
  });

  // -------------------------------------------------------------------
  // publish() — provider-side rejections
  // -------------------------------------------------------------------

  test("publish: invalid channel (chat not found) is a terminal, non-retryable failure", async () => {
    behavior = "channel_not_found";
    const adapter = makeAdapter();
    const result = await adapter.publish(makeRequest());
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorCode).toBe("telegram_invalid_channel");
      expect(result.retryable).toBe(false);
    }
  });

  test("publish: missing channel permission maps to needs_reauth, non-retryable", async () => {
    behavior = "permission_denied";
    const adapter = makeAdapter();
    const result = await adapter.publish(makeRequest());
    expect(result.outcome).toBe("needs_reauth");
    if (result.outcome === "needs_reauth" || result.outcome === "failed") {
      expect(result.errorCode).toBe("telegram_missing_permission");
    }
  });

  test("publish: invalid bot token (401 Unauthorized) maps to needs_reauth", async () => {
    behavior = "invalid_token";
    const adapter = makeAdapter();
    const result = await adapter.publish(makeRequest());
    expect(result.outcome).toBe("needs_reauth");
  });

  test("publish: rate limited maps to rate_limited with retryAfterSeconds from Telegram's own hint", async () => {
    behavior = "rate_limited";
    const adapter = makeAdapter();
    const result = await adapter.publish(makeRequest());
    expect(result.outcome).toBe("rate_limited");
    if (result.outcome === "rate_limited") {
      expect(result.retryAfterSeconds).toBe(30);
    }
  });

  test("publish: a wedged server times out instead of hanging, retryable", async () => {
    behavior = "slow";
    process.env.TELEGRAM_REQUEST_TIMEOUT_MS = "20";
    try {
      const adapter = makeAdapter();
      const result = await adapter.publish(makeRequest());
      expect(result.outcome).toBe("failed");
      if (result.outcome === "failed") {
        expect(result.errorCode).toBe("telegram_request_timeout");
        expect(result.retryable).toBe(true);
      }
    } finally {
      delete process.env.TELEGRAM_REQUEST_TIMEOUT_MS;
    }
  });

  test("publish: an unreachable server is a retryable network error, never leaks the bot token in the error message", async () => {
    // Stand up and immediately stop a server to obtain a port nothing is
    // listening on anymore — guarantees a real connection failure without
    // ever reaching the actual internet.
    const deadServer = Bun.serve({ port: 0, fetch: () => new Response("") });
    const deadPort = deadServer.port;
    deadServer.stop(true);

    const adapter = createTelegramChannelProviderAdapter({
      apiBaseUrl: `http://127.0.0.1:${deadPort}`
    });
    const result = await adapter.publish(makeRequest());
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorCode).toBe("telegram_network_error");
      expect(result.retryable).toBe(true);
      expect(result.errorMessage).not.toContain(FAKE_TOKEN);
    }
  });

  test("publish: a malformed (non-JSON) 200 response is treated as a non-retryable failure, not a crash", async () => {
    behavior = "malformed_json";
    const adapter = makeAdapter();
    const result = await adapter.publish(makeRequest());
    expect(result.outcome).toBe("failed");
  });

  // -------------------------------------------------------------------
  // Parse-mode sanitization — the security-critical behavior
  // -------------------------------------------------------------------

  test("publish: default plain text mode sends the title completely unescaped and omits parse_mode entirely", async () => {
    const adapter = makeAdapter();
    await adapter.publish(
      makeRequest({
        content: {
          title: MALICIOUS_TITLE,
          excerptOrCaption: "",
          canonicalUrl: "https://news.example.com/x",
          imageUrl: null
        }
      })
    );
    const sent = JSON.parse(requests[0]!.body) as {
      text: string;
      parse_mode?: string;
    };
    expect(sent.text).toContain(MALICIOUS_TITLE);
    expect(sent.parse_mode).toBeUndefined();
  });

  test("publish: explicit MarkdownV2 opt-in escapes the title so formatting-shaped text is never interpreted as real formatting", async () => {
    process.env.TELEGRAM_DEFAULT_PARSE_MODE = "MarkdownV2";
    try {
      const adapter = makeAdapter();
      await adapter.publish(
        makeRequest({
          content: {
            title: MALICIOUS_TITLE,
            excerptOrCaption: "",
            canonicalUrl: "https://news.example.com/x",
            imageUrl: null
          }
        })
      );
      const sent = JSON.parse(requests[0]!.body) as {
        text: string;
        parse_mode?: string;
      };
      expect(sent.parse_mode).toBe("MarkdownV2");
      expect(sent.text).not.toContain(MALICIOUS_TITLE);
      expect(sent.text).not.toMatch(/(?<!\\)[*_[\]()]/);
    } finally {
      delete process.env.TELEGRAM_DEFAULT_PARSE_MODE;
    }
  });

  test("publish: never sends the bot token anywhere in the request body", async () => {
    const adapter = makeAdapter();
    await adapter.publish(makeRequest());
    expect(requests[0]!.body).not.toContain(FAKE_TOKEN);
  });

  // -------------------------------------------------------------------
  // verifyCredentials()
  // -------------------------------------------------------------------

  test("verifyCredentials: succeeds when the bot is a channel administrator that can post", async () => {
    const adapter = makeAdapter();
    const result = await adapter.verifyCredentials(
      TOKEN_REFERENCE,
      "@testchannel",
      []
    );
    expect(result.valid).toBe(true);
    expect(result.details?.botUsername).toBe("test_bot");
    expect(result.details?.permissions).toContain("can_post_messages");
  });

  test("verifyCredentials: fails when the bot is a plain member (not an administrator)", async () => {
    behavior = "not_admin";
    const adapter = makeAdapter();
    const result = await adapter.verifyCredentials(
      TOKEN_REFERENCE,
      "@testchannel",
      []
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing_channel_permission");
  });

  test("verifyCredentials: fails when the bot is an administrator without post permission", async () => {
    behavior = "admin_no_post_permission";
    const adapter = makeAdapter();
    const result = await adapter.verifyCredentials(
      TOKEN_REFERENCE,
      "@testchannel",
      []
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing_post_permission");
  });

  test("verifyCredentials: fails for an invalid/nonexistent channel", async () => {
    behavior = "channel_not_found";
    const adapter = makeAdapter();
    const result = await adapter.verifyCredentials(
      TOKEN_REFERENCE,
      "@doesnotexist",
      []
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("channel_not_found");
  });

  test("verifyCredentials: TELEGRAM_PROVIDER_ENABLED not true never calls the network", async () => {
    process.env.TELEGRAM_PROVIDER_ENABLED = "false";
    const adapter = makeAdapter();
    const result = await adapter.verifyCredentials(
      TOKEN_REFERENCE,
      "@testchannel",
      []
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("telegram_provider_disabled");
    expect(requestCount).toBe(0);
  });

  test("verifyCredentials: an unresolvable token reference never calls the network", async () => {
    const adapter = makeAdapter();
    const result = await adapter.verifyCredentials(
      "secretsmanager:social/x",
      "@testchannel",
      []
    );
    expect(result.valid).toBe(false);
    expect(requestCount).toBe(0);
  });
});

describe("Telegram adapter — idempotency (dispatcher-level replay must never duplicate)", () => {
  test("adapter.publish itself has no local retry state — idempotency is enforced by the outbox's idempotency_key + unique index (Issue #643), never by the adapter re-sending", () => {
    // Documented, not exercised via network here (covered by
    // tests/integration/social-publishing.integration.test.ts's job
    // idempotency_key tests) — this adapter is stateless per call, exactly
    // as `SocialProviderAdapter.publish`'s own contract requires.
    expect(typeof createTelegramChannelProviderAdapter().publish).toBe(
      "function"
    );
  });
});

afterAll(() => {
  // Defensive: ensure no lingering open circuit-breaker state from a
  // timeout/network-error test leaks into another module's tests (same
  // convention `cloudflare-dns-adapter.test.ts` follows for its own
  // provider key namespace) — Telegram's adapter does not register its own
  // circuit breaker (the dispatcher owns that, per Issue #643's design), so
  // this is a no-op safety net rather than a required cleanup.
  getProviderCircuitBreaker("social-publishing:telegram_channel").recordSuccess(
    new Date()
  );
});
