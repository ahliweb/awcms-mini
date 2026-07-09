import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  discoverOidcConfiguration,
  fetchProviderJwks,
  resetGenericOidcCachesForTests
} from "../../src/lib/auth/generic-oidc-client";
import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";

const ISSUER_URL = "https://issuer.example.com";
const JWKS_URI = "https://issuer.example.com/keys";

describe("generic-oidc-client negative-TTL failure cache (Issue #610)", () => {
  let originalFetch: typeof fetch;
  let fetchCallCount: number;

  beforeEach(() => {
    resetGenericOidcCachesForTests();
    resetProviderCircuitBreakersForTests();
    originalFetch = globalThis.fetch;
    fetchCallCount = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetGenericOidcCachesForTests();
    resetProviderCircuitBreakersForTests();
  });

  test("discoverOidcConfiguration: a second call for the same providerKey right after a failed fetch does NOT hit the network again", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      fetchCallCount += 1;
      return new Response("internal error", { status: 500 });
    }) as typeof fetch;

    const first = await discoverOidcConfiguration("provider-a", ISSUER_URL);
    expect(first.ok).toBe(false);
    expect(fetchCallCount).toBe(1);

    const second = await discoverOidcConfiguration("provider-a", ISSUER_URL);
    expect(second.ok).toBe(false);
    // The negative cache should have satisfied this call without a new
    // fetch attempt — this is exactly the "no real throttling" gap Issue
    // #610 closes.
    expect(fetchCallCount).toBe(1);
  });

  test("discoverOidcConfiguration: the negative cache is scoped per providerKey, not global", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      fetchCallCount += 1;
      return new Response("internal error", { status: 500 });
    }) as typeof fetch;

    await discoverOidcConfiguration("provider-a", ISSUER_URL);
    expect(fetchCallCount).toBe(1);

    const otherProvider = await discoverOidcConfiguration(
      "provider-b",
      ISSUER_URL
    );
    expect(otherProvider.ok).toBe(false);
    // A different providerKey must get its own independent attempt, not
    // be silently satisfied by provider-a's cached failure.
    expect(fetchCallCount).toBe(2);
  });

  test("discoverOidcConfiguration: a successful fetch is NOT affected by a stale negative cache entry from a prior provider key", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCallCount += 1;
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("provider-fails")) {
        return new Response("internal error", { status: 500 });
      }
      return Response.json({
        issuer: ISSUER_URL,
        authorization_endpoint: `${ISSUER_URL}/authorize`,
        token_endpoint: `${ISSUER_URL}/token`,
        jwks_uri: JWKS_URI
      });
    }) as typeof fetch;

    await discoverOidcConfiguration(
      "provider-fails",
      "https://provider-fails.example.com"
    );
    expect(fetchCallCount).toBe(1);

    const success = await discoverOidcConfiguration("provider-ok", ISSUER_URL);
    expect(success.ok).toBe(true);
    expect(fetchCallCount).toBe(2);
  });

  test("fetchProviderJwks: a second call for the same providerKey right after a failed fetch does NOT hit the network again", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      fetchCallCount += 1;
      return new Response("internal error", { status: 500 });
    }) as typeof fetch;

    const first = await fetchProviderJwks("provider-a", JWKS_URI);
    expect(first.ok).toBe(false);
    expect(fetchCallCount).toBe(1);

    const second = await fetchProviderJwks("provider-a", JWKS_URI);
    expect(second.ok).toBe(false);
    expect(fetchCallCount).toBe(1);
  });

  test("fetchProviderJwks: a successful fetch after a failure for a DIFFERENT providerKey is unaffected", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCallCount += 1;
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("fails")) {
        return new Response("internal error", { status: 500 });
      }
      return Response.json({ keys: [{ kid: "test-key-1" }] });
    }) as typeof fetch;

    await fetchProviderJwks("provider-a", "https://fails.example.com/keys");
    expect(fetchCallCount).toBe(1);

    const success = await fetchProviderJwks("provider-b", JWKS_URI);
    expect(success.ok).toBe(true);
    expect(fetchCallCount).toBe(2);
  });
});
