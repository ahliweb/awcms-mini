import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildGoogleAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchGoogleJwks,
  resetGoogleJwksCacheForTests,
  resolveGoogleRedirectUri
} from "../../src/lib/auth/google-oauth-client";
import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";

describe("resolveGoogleRedirectUri/buildGoogleAuthorizationUrl", () => {
  test("resolveGoogleRedirectUri combines APP_URL with the redirect path", () => {
    expect(
      resolveGoogleRedirectUri({
        APP_URL: "https://awcms-mini.example.com"
      } as NodeJS.ProcessEnv)
    ).toBe(
      "https://awcms-mini.example.com/api/v1/auth/providers/google/callback"
    );
  });

  test("buildGoogleAuthorizationUrl includes every required query param", () => {
    const url = new URL(
      buildGoogleAuthorizationUrl({
        clientId: "client-abc",
        tenantId: "11111111-1111-1111-1111-111111111111",
        state: "raw-state-value",
        nonce: "raw-nonce-value"
      })
    );

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(url.searchParams.get("client_id")).toBe("client-abc");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe(
      "11111111-1111-1111-1111-111111111111.raw-state-value"
    );
    expect(url.searchParams.get("nonce")).toBe("raw-nonce-value");
  });
});

describe("exchangeAuthorizationCode", () => {
  beforeEach(() => {
    resetProviderCircuitBreakersForTests();
  });

  afterEach(() => {
    resetProviderCircuitBreakersForTests();
  });

  test("succeeds when Google returns an id_token", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ id_token: "a-real-id-token" });
      }
    });

    const result = await exchangeAuthorizationCode({
      code: "good-code",
      clientId: "client-abc",
      clientSecret: "secret-abc",
      redirectUri: "https://app.example.com/callback",
      tokenEndpoint: `http://127.0.0.1:${server.port}`
    });

    expect(result).toEqual({ ok: true, idToken: "a-real-id-token" });
  });

  test("fails cleanly (not retryable) on a 400 invalid_grant — Google correctly rejecting a bad code", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const result = await exchangeAuthorizationCode({
      code: "bad-or-reused-code",
      clientId: "client-abc",
      clientSecret: "secret-abc",
      redirectUri: "https://app.example.com/callback",
      tokenEndpoint: `http://127.0.0.1:${server.port}`
    });

    expect(result).toEqual({ ok: false, retryable: false });
  });

  test("never trips the circuit breaker on repeated invalid_grant responses (client-input-driven, not a provider outage)", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const params = {
      code: "bad-code",
      clientId: "client-abc",
      clientSecret: "secret-abc",
      redirectUri: "https://app.example.com/callback",
      tokenEndpoint: `http://127.0.0.1:${server.port}`
    };

    for (let i = 0; i < 10; i += 1) {
      await exchangeAuthorizationCode(params);
    }

    // If this were incorrectly tripping the breaker, the 11th call would
    // come back retryable:true without ever reaching the fake server —
    // instead it must still reach it and get the same clean 400 result.
    const result = await exchangeAuthorizationCode(params);
    expect(result).toEqual({ ok: false, retryable: false });
  });

  test("opens the circuit breaker after consecutive genuine provider failures (5xx)", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("upstream error", { status: 500 });
      }
    });

    const params = {
      code: "some-code",
      clientId: "client-abc",
      clientSecret: "secret-abc",
      redirectUri: "https://app.example.com/callback",
      tokenEndpoint: `http://127.0.0.1:${server.port}`
    };

    for (let i = 0; i < 5; i += 1) {
      await exchangeAuthorizationCode(params);
    }

    const sixth = await exchangeAuthorizationCode(params);
    expect(sixth).toEqual({ ok: false, retryable: true });
  });

  test("times out a wedged token endpoint instead of hanging forever", async () => {
    using server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(500);
        return Response.json({ id_token: "too-late" });
      }
    });

    const result = await exchangeAuthorizationCode({
      code: "some-code",
      clientId: "client-abc",
      clientSecret: "secret-abc",
      redirectUri: "https://app.example.com/callback",
      tokenEndpoint: `http://127.0.0.1:${server.port}`,
      timeoutMs: 20
    });

    expect(result).toEqual({ ok: false, retryable: true });
  });
});

describe("fetchGoogleJwks", () => {
  beforeEach(() => {
    resetProviderCircuitBreakersForTests();
    resetGoogleJwksCacheForTests();
  });

  afterEach(() => {
    resetProviderCircuitBreakersForTests();
    resetGoogleJwksCacheForTests();
  });

  test("succeeds and caches the result across calls", async () => {
    let callCount = 0;
    using server = Bun.serve({
      port: 0,
      fetch() {
        callCount += 1;
        return Response.json({ keys: [{ kty: "RSA", kid: "k1" }] });
      }
    });

    const first = await fetchGoogleJwks({
      jwksUri: `http://127.0.0.1:${server.port}`
    });
    const second = await fetchGoogleJwks({
      jwksUri: `http://127.0.0.1:${server.port}`
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(callCount).toBe(1);
  });

  test("fails cleanly on a malformed JWKS response", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ notKeys: [] });
      }
    });

    const result = await fetchGoogleJwks({
      jwksUri: `http://127.0.0.1:${server.port}`
    });
    expect(result.ok).toBe(false);
  });

  test("opens the circuit breaker after consecutive failures", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("upstream error", { status: 500 });
      }
    });

    for (let i = 0; i < 5; i += 1) {
      resetGoogleJwksCacheForTests();
      await fetchGoogleJwks({ jwksUri: `http://127.0.0.1:${server.port}` });
    }

    resetGoogleJwksCacheForTests();
    const sixth = await fetchGoogleJwks({
      jwksUri: `http://127.0.0.1:${server.port}`
    });
    expect(sixth.ok).toBe(false);
  });
});
