import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  discoverOidcConfiguration,
  fetchProviderJwks,
  resetGenericOidcCachesForTests
} from "../../src/lib/auth/generic-oidc-client";
import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";

const ISSUER_URL = "https://issuer.example.com";
const JWKS_URI = "https://issuer.example.com/keys";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

describe("generic-oidc-client: tenant-scoped cache/breaker keys (Issue #610)", () => {
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

  test("discoverOidcConfiguration: a second call for the same tenant+providerKey right after a failed fetch does NOT hit the network again", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      fetchCallCount += 1;
      return new Response("internal error", { status: 500 });
    }) as typeof fetch;

    const first = await discoverOidcConfiguration(TENANT_A, "okta", ISSUER_URL);
    expect(first.ok).toBe(false);
    expect(fetchCallCount).toBe(1);

    const second = await discoverOidcConfiguration(
      TENANT_A,
      "okta",
      ISSUER_URL
    );
    expect(second.ok).toBe(false);
    // The negative cache should have satisfied this call without a new
    // fetch attempt — this is exactly the "no real throttling" gap Issue
    // #610 closes.
    expect(fetchCallCount).toBe(1);
  });

  test("discoverOidcConfiguration: the negative cache is scoped per tenant+providerKey, not by providerKey alone", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      fetchCallCount += 1;
      return new Response("internal error", { status: 500 });
    }) as typeof fetch;

    await discoverOidcConfiguration(TENANT_A, "okta", ISSUER_URL);
    expect(fetchCallCount).toBe(1);

    const otherProvider = await discoverOidcConfiguration(
      TENANT_A,
      "azure-ad",
      ISSUER_URL
    );
    expect(otherProvider.ok).toBe(false);
    // A different providerKey (same tenant) must get its own independent
    // attempt, not be silently satisfied by another provider's cached
    // failure.
    expect(fetchCallCount).toBe(2);
  });

  test("CRITICAL: two DIFFERENT tenants using the SAME providerKey (e.g. both named 'okta') get fully independent cache/breaker state — a security-auditor finding on an earlier draft of this fix", async () => {
    // `provider_key` is only unique PER TENANT (migration 036's unique
    // index is `(tenant_id, provider_key)`) — two tenants naming their
    // provider "okta" is normal, expected, and common. Before Issue #610's
    // own review caught this, every cache/breaker in this file was keyed
    // by `providerKey` ALONE, so tenant A's discovery result (successful
    // OR failed) for "okta" would be served straight to tenant B's
    // completely unrelated "okta" provider — a cross-tenant cache-
    // poisoning bug that could redirect tenant B's real SSO login to an
    // attacker-controlled authorization_endpoint/jwks_uri that tenant A's
    // admin configured. This test proves that bug is fixed: same
    // `providerKey` string, different `tenantId`, fully independent
    // results.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCallCount += 1;
      const url = typeof input === "string" ? input : input.toString();

      // Tenant A's "okta" points at an attacker-controlled/broken target.
      if (new URL(url).origin === "https://attacker.example.com") {
        return new Response("internal error", { status: 500 });
      }

      // Tenant B's "okta" points at a real, healthy Okta org.
      return Response.json({
        issuer: ISSUER_URL,
        authorization_endpoint: `${ISSUER_URL}/authorize`,
        token_endpoint: `${ISSUER_URL}/token`,
        jwks_uri: JWKS_URI
      });
    }) as typeof fetch;

    const tenantAResult = await discoverOidcConfiguration(
      TENANT_A,
      "okta",
      "https://attacker.example.com"
    );
    expect(tenantAResult.ok).toBe(false);

    // Tenant B's "okta" must NOT be affected by tenant A's failed/hostile
    // "okta" in any way — no shared cache hit, no shared breaker trip.
    const tenantBResult = await discoverOidcConfiguration(
      TENANT_B,
      "okta",
      ISSUER_URL
    );
    expect(tenantBResult.ok).toBe(true);
    expect(
      tenantBResult.ok && tenantBResult.document.authorization_endpoint
    ).toBe(`${ISSUER_URL}/authorize`);
    // Two independent live fetches — tenant B's success was never served
    // from (or blocked by) tenant A's cache entry.
    expect(fetchCallCount).toBe(2);

    // Repeat tenant A's call — still independently cached-failed, still
    // never leaking into tenant B's now-cached success.
    const tenantAAgain = await discoverOidcConfiguration(
      TENANT_A,
      "okta",
      "https://attacker.example.com"
    );
    expect(tenantAAgain.ok).toBe(false);
    expect(fetchCallCount).toBe(2); // satisfied by tenant A's own negative cache

    const tenantBAgain = await discoverOidcConfiguration(
      TENANT_B,
      "okta",
      ISSUER_URL
    );
    expect(tenantBAgain.ok).toBe(true);
    expect(fetchCallCount).toBe(2); // satisfied by tenant B's own positive cache
  });

  test("discoverOidcConfiguration: a successful fetch is NOT affected by a stale negative cache entry from a different providerKey", async () => {
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
      TENANT_A,
      "provider-fails",
      "https://provider-fails.example.com"
    );
    expect(fetchCallCount).toBe(1);

    const success = await discoverOidcConfiguration(
      TENANT_A,
      "provider-ok",
      ISSUER_URL
    );
    expect(success.ok).toBe(true);
    expect(fetchCallCount).toBe(2);
  });

  test("fetchProviderJwks: a second call for the same tenant+providerKey right after a failed fetch does NOT hit the network again", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      fetchCallCount += 1;
      return new Response("internal error", { status: 500 });
    }) as typeof fetch;

    const first = await fetchProviderJwks(TENANT_A, "okta", JWKS_URI);
    expect(first.ok).toBe(false);
    expect(fetchCallCount).toBe(1);

    const second = await fetchProviderJwks(TENANT_A, "okta", JWKS_URI);
    expect(second.ok).toBe(false);
    expect(fetchCallCount).toBe(1);
  });

  test("fetchProviderJwks: two different tenants with the same providerKey get independent results", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCallCount += 1;
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("fails")) {
        return new Response("internal error", { status: 500 });
      }
      return Response.json({ keys: [{ kid: "test-key-1" }] });
    }) as typeof fetch;

    await fetchProviderJwks(TENANT_A, "okta", "https://fails.example.com/keys");
    expect(fetchCallCount).toBe(1);

    const success = await fetchProviderJwks(TENANT_B, "okta", JWKS_URI);
    expect(success.ok).toBe(true);
    expect(fetchCallCount).toBe(2);
  });
});
