/**
 * Pure unit tests for `src/lib/tenant/public-host-tenant-resolver.ts`
 * (Issue #559, epic #555) — no database. `normalizePublicHost()` is tested
 * directly; `resolvePublicTenantFromRequest()`'s branching (mode gating,
 * fallback order, trustProxy header selection) is tested with mocked
 * `deps` so no DB-touching function actually runs. Real DB behavior
 * (RLS/SECURITY DEFINER bypass, status filtering, tenant activation) is
 * covered separately by
 * `tests/integration/public-tenant-resolution.integration.test.ts`.
 */
import { describe, expect, mock, test } from "bun:test";

import {
  normalizePublicHost,
  resolvePublicTenantByHost,
  resolvePublicTenantFromRequest,
  type PublicHostResolverDeps,
  type PublicTenantResolution
} from "../../src/lib/tenant/public-host-tenant-resolver";

const FAKE_SQL = {} as unknown as Bun.SQL;

const SAMPLE_TENANT: PublicTenantResolution = {
  tenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  tenantCode: "sample-tenant",
  tenantName: "Sample Tenant",
  defaultLocale: "en"
};

function makeDeps(overrides: Partial<PublicHostResolverDeps> = {}) {
  const resolvePublicTenantByHost = mock(
    async (): Promise<PublicTenantResolution | null> => null
  );
  const resolveDefaultPublicTenantFromEnv = mock(
    async (): Promise<PublicTenantResolution | null> => null
  );
  const resolveDefaultPublicTenantFromSetupState = mock(
    async (): Promise<PublicTenantResolution | null> => null
  );

  return {
    resolvePublicTenantByHost,
    resolveDefaultPublicTenantFromEnv,
    resolveDefaultPublicTenantFromSetupState,
    ...overrides
  } as PublicHostResolverDeps;
}

describe("normalizePublicHost", () => {
  test("lowercases and trims a plain hostname", () => {
    expect(normalizePublicHost("  Example.COM  ")).toBe("example.com");
  });

  test("strips a trailing port", () => {
    expect(normalizePublicHost("example.com:4321")).toBe("example.com");
  });

  test("resolves a subdomain the same way as a custom domain", () => {
    expect(normalizePublicHost("Blog.Platform.com:8080")).toBe(
      "blog.platform.com"
    );
  });

  test("throws on an empty string (caller contract violation)", () => {
    expect(() => normalizePublicHost("")).toThrow();
  });

  test("throws on a whitespace-only string", () => {
    expect(() => normalizePublicHost("   ")).toThrow();
  });

  for (const invalid of [
    "exa mple.com",
    "example..com",
    ".example.com",
    "example.com.",
    "example_.com",
    "-example.com",
    "example-.com",
    "[::1]:4321",
    "a".repeat(300),
    "a".repeat(70) + ".com"
  ]) {
    test(`rejects invalid host format (returns null, does not throw): ${JSON.stringify(invalid)}`, () => {
      expect(normalizePublicHost(invalid)).toBeNull();
    });
  }

  test("accepts a bare single-label host (e.g. localhost)", () => {
    expect(normalizePublicHost("localhost:4321")).toBe("localhost");
  });
});

describe("resolvePublicTenantFromRequest — mode gating and fallback order", () => {
  test("mode=host_default: resolves via host lookup, never touches env/setup fallback", async () => {
    const deps = makeDeps({
      resolvePublicTenantByHost: mock(async () => SAMPLE_TENANT)
    });

    const request = new Request("http://ignored.test/", {
      headers: { host: "tenant-one.example.com" }
    });

    const result = await resolvePublicTenantFromRequest(
      FAKE_SQL,
      request,
      { mode: "host_default" },
      deps
    );

    expect(result).toEqual(SAMPLE_TENANT);
    expect(deps.resolvePublicTenantByHost).toHaveBeenCalledTimes(1);
    expect(
      (deps.resolvePublicTenantByHost as ReturnType<typeof mock>).mock.calls[0]
    ).toEqual([FAKE_SQL, "tenant-one.example.com"]);
    expect(deps.resolveDefaultPublicTenantFromEnv).not.toHaveBeenCalled();
    expect(
      deps.resolveDefaultPublicTenantFromSetupState
    ).not.toHaveBeenCalled();
  });

  test("mode=host_default but host does not resolve: falls through to env default", async () => {
    const deps = makeDeps({
      resolveDefaultPublicTenantFromEnv: mock(async () => SAMPLE_TENANT)
    });

    const request = new Request("http://ignored.test/", {
      headers: { host: "unknown-host.example.com" }
    });

    const result = await resolvePublicTenantFromRequest(
      FAKE_SQL,
      request,
      { mode: "host_default" },
      deps
    );

    expect(result).toEqual(SAMPLE_TENANT);
    expect(deps.resolvePublicTenantByHost).toHaveBeenCalledTimes(1);
    expect(deps.resolveDefaultPublicTenantFromEnv).toHaveBeenCalledTimes(1);
    expect(
      deps.resolveDefaultPublicTenantFromSetupState
    ).not.toHaveBeenCalled();
  });

  test("mode=host_default, host+env both fail: falls through to setup state", async () => {
    const deps = makeDeps({
      resolveDefaultPublicTenantFromSetupState: mock(async () => SAMPLE_TENANT)
    });

    const request = new Request("http://ignored.test/", {
      headers: { host: "unknown-host.example.com" }
    });

    const result = await resolvePublicTenantFromRequest(
      FAKE_SQL,
      request,
      { mode: "host_default" },
      deps
    );

    expect(result).toEqual(SAMPLE_TENANT);
    expect(deps.resolveDefaultPublicTenantFromEnv).toHaveBeenCalledTimes(1);
    expect(deps.resolveDefaultPublicTenantFromSetupState).toHaveBeenCalledTimes(
      1
    );
  });

  test("every step fails: returns null (generic 404), never throws", async () => {
    const deps = makeDeps();

    const request = new Request("http://ignored.test/", {
      headers: { host: "unknown-host.example.com" }
    });

    const result = await resolvePublicTenantFromRequest(
      FAKE_SQL,
      request,
      { mode: "host_default" },
      deps
    );

    expect(result).toBeNull();
  });

  test("mode unset: host lookup step is never attempted, only env/setup fallback runs", async () => {
    const deps = makeDeps({
      resolveDefaultPublicTenantFromEnv: mock(async () => SAMPLE_TENANT)
    });

    const request = new Request("http://ignored.test/", {
      headers: { host: "tenant-one.example.com" }
    });

    const result = await resolvePublicTenantFromRequest(
      FAKE_SQL,
      request,
      {},
      deps
    );

    expect(result).toEqual(SAMPLE_TENANT);
    expect(deps.resolvePublicTenantByHost).not.toHaveBeenCalled();
  });

  describe("mode=tenant_code_legacy (Issue #560 decision)", () => {
    test("returns null unconditionally, without attempting the host lookup step", async () => {
      const deps = makeDeps({
        resolvePublicTenantByHost: mock(async () => SAMPLE_TENANT)
      });

      const request = new Request("http://ignored.test/", {
        headers: { host: "tenant-one.example.com" }
      });

      const result = await resolvePublicTenantFromRequest(
        FAKE_SQL,
        request,
        { mode: "tenant_code_legacy" },
        deps
      );

      expect(result).toBeNull();
      expect(deps.resolvePublicTenantByHost).not.toHaveBeenCalled();
    });

    test("returns null even when PUBLIC_DEFAULT_TENANT_ID/CODE fallback would otherwise resolve — the whole fallback chain is skipped, not just host lookup", async () => {
      const deps = makeDeps({
        resolveDefaultPublicTenantFromEnv: mock(async () => SAMPLE_TENANT)
      });

      const request = new Request("http://ignored.test/", {
        headers: { host: "tenant-one.example.com" }
      });

      const result = await resolvePublicTenantFromRequest(
        FAKE_SQL,
        request,
        { mode: "tenant_code_legacy" },
        deps
      );

      expect(result).toBeNull();
      expect(deps.resolveDefaultPublicTenantFromEnv).not.toHaveBeenCalled();
    });

    test("returns null even when setup_state fallback would otherwise resolve", async () => {
      const deps = makeDeps({
        resolveDefaultPublicTenantFromSetupState: mock(
          async () => SAMPLE_TENANT
        )
      });

      const request = new Request("http://ignored.test/", {
        headers: { host: "tenant-one.example.com" }
      });

      const result = await resolvePublicTenantFromRequest(
        FAKE_SQL,
        request,
        { mode: "tenant_code_legacy" },
        deps
      );

      expect(result).toBeNull();
      expect(
        deps.resolveDefaultPublicTenantFromSetupState
      ).not.toHaveBeenCalled();
    });

    test("returns null for a bare host string input too (not only Request)", async () => {
      const deps = makeDeps({
        resolvePublicTenantByHost: mock(async () => SAMPLE_TENANT),
        resolveDefaultPublicTenantFromEnv: mock(async () => SAMPLE_TENANT),
        resolveDefaultPublicTenantFromSetupState: mock(
          async () => SAMPLE_TENANT
        )
      });

      const result = await resolvePublicTenantFromRequest(
        FAKE_SQL,
        "direct-host.example.com",
        { mode: "tenant_code_legacy" },
        deps
      );

      expect(result).toBeNull();
      expect(deps.resolvePublicTenantByHost).not.toHaveBeenCalled();
      expect(deps.resolveDefaultPublicTenantFromEnv).not.toHaveBeenCalled();
      expect(
        deps.resolveDefaultPublicTenantFromSetupState
      ).not.toHaveBeenCalled();
    });

    test("is distinct from mode=undefined: unset mode still resolves via the fallback chain", async () => {
      const deps = makeDeps({
        resolveDefaultPublicTenantFromEnv: mock(async () => SAMPLE_TENANT)
      });

      const request = new Request("http://ignored.test/");

      const unsetResult = await resolvePublicTenantFromRequest(
        FAKE_SQL,
        request,
        {},
        deps
      );
      expect(unsetResult).toEqual(SAMPLE_TENANT);

      const legacyResult = await resolvePublicTenantFromRequest(
        FAKE_SQL,
        request,
        { mode: "tenant_code_legacy" },
        deps
      );
      expect(legacyResult).toBeNull();
    });
  });

  for (const otherMode of ["env_default", "setup_default"]) {
    test(`mode=${otherMode}: host lookup step is never attempted (only host_default enables it)`, async () => {
      const deps = makeDeps({
        resolveDefaultPublicTenantFromSetupState: mock(
          async () => SAMPLE_TENANT
        )
      });

      const request = new Request("http://ignored.test/", {
        headers: { host: "tenant-one.example.com" }
      });

      const result = await resolvePublicTenantFromRequest(
        FAKE_SQL,
        request,
        { mode: otherMode },
        deps
      );

      expect(result).toEqual(SAMPLE_TENANT);
      expect(deps.resolvePublicTenantByHost).not.toHaveBeenCalled();
    });
  }

  test("trustProxy=false (default): X-Forwarded-Host is ignored, plain Host header used", async () => {
    const deps = makeDeps({
      resolvePublicTenantByHost: mock(async () => SAMPLE_TENANT)
    });

    const request = new Request("http://ignored.test/", {
      headers: {
        host: "real-host.example.com",
        "x-forwarded-host": "attacker-controlled.example.com"
      }
    });

    await resolvePublicTenantFromRequest(
      FAKE_SQL,
      request,
      { mode: "host_default" },
      deps
    );

    expect(
      (deps.resolvePublicTenantByHost as ReturnType<typeof mock>).mock.calls[0]
    ).toEqual([FAKE_SQL, "real-host.example.com"]);
  });

  test("trustProxy=true: a single-value X-Forwarded-Host is used when present", async () => {
    const deps = makeDeps({
      resolvePublicTenantByHost: mock(async () => SAMPLE_TENANT)
    });

    const request = new Request("http://ignored.test/", {
      headers: {
        host: "edge-proxy.internal",
        "x-forwarded-host": "public-facing.example.com"
      }
    });

    await resolvePublicTenantFromRequest(
      FAKE_SQL,
      request,
      { mode: "host_default", trustProxy: true },
      deps
    );

    expect(
      (deps.resolvePublicTenantByHost as ReturnType<typeof mock>).mock.calls[0]
    ).toEqual([FAKE_SQL, "public-facing.example.com"]);
  });

  test("trustProxy=true: a multi-value X-Forwarded-Host (unexpected for this repo's single-trusted-proxy topology) falls back to the plain Host header, not the leftmost/client-controllable entry", async () => {
    const deps = makeDeps({
      resolvePublicTenantByHost: mock(async () => SAMPLE_TENANT)
    });

    const request = new Request("http://ignored.test/", {
      headers: {
        host: "real-edge-proxy.internal",
        // A well-behaved single overwriting proxy never produces more than
        // one value — this simulates either a spoofing attempt (client
        // pre-seeded the header) or a misconfigured proxy chain that
        // appends instead of overwriting. Either way, the leftmost value
        // ("attacker-controlled.example.com") must NOT be trusted.
        "x-forwarded-host":
          "attacker-controlled.example.com, real-edge-proxy.internal"
      }
    });

    await resolvePublicTenantFromRequest(
      FAKE_SQL,
      request,
      { mode: "host_default", trustProxy: true },
      deps
    );

    expect(
      (deps.resolvePublicTenantByHost as ReturnType<typeof mock>).mock.calls[0]
    ).toEqual([FAKE_SQL, "real-edge-proxy.internal"]);
  });

  test("accepts a raw host string instead of a Request", async () => {
    const deps = makeDeps({
      resolvePublicTenantByHost: mock(async () => SAMPLE_TENANT)
    });

    const result = await resolvePublicTenantFromRequest(
      FAKE_SQL,
      "direct-host.example.com:9999",
      { mode: "host_default" },
      deps
    );

    expect(result).toEqual(SAMPLE_TENANT);
    expect(
      (deps.resolvePublicTenantByHost as ReturnType<typeof mock>).mock.calls[0]
    ).toEqual([FAKE_SQL, "direct-host.example.com"]);
  });

  test("a malformed host from the request never throws — falls through to the fallback chain", async () => {
    const deps = makeDeps({
      resolveDefaultPublicTenantFromEnv: mock(async () => SAMPLE_TENANT)
    });

    const request = new Request("http://ignored.test/", {
      headers: { host: "exa mple.com" }
    });

    const result = await resolvePublicTenantFromRequest(
      FAKE_SQL,
      request,
      { mode: "host_default" },
      deps
    );

    expect(result).toEqual(SAMPLE_TENANT);
    expect(deps.resolvePublicTenantByHost).not.toHaveBeenCalled();
  });

  test("no Host header at all: does not throw, skips straight to fallback chain", async () => {
    const deps = makeDeps({
      resolveDefaultPublicTenantFromSetupState: mock(async () => SAMPLE_TENANT)
    });

    const request = new Request("http://ignored.test/");

    const result = await resolvePublicTenantFromRequest(
      FAKE_SQL,
      request,
      { mode: "host_default" },
      deps
    );

    expect(result).toEqual(SAMPLE_TENANT);
    expect(deps.resolvePublicTenantByHost).not.toHaveBeenCalled();
  });
});

describe("resolvePublicTenantByHost — defense-in-depth shape validation", () => {
  // `resolvePublicTenantByHost` is exported and documented as directly
  // callable (e.g. by Issue #560), not only reachable through
  // `normalizePublicHost()` first. These prove it re-validates hostname
  // shape itself and short-circuits BEFORE ever touching `sql` — the fake
  // `sql` below throws if invoked at all, so a passing test is direct
  // proof no query was attempted for a malformed/oversized value.
  function throwingSql(): Bun.SQL {
    return (() => {
      throw new Error(
        "sql must not be called — resolvePublicTenantByHost should reject this input before querying."
      );
    }) as unknown as Bun.SQL;
  }

  test("rejects an oversized host (>253 chars) without querying the database", async () => {
    const result = await resolvePublicTenantByHost(
      throwingSql(),
      "a".repeat(300)
    );

    expect(result).toBeNull();
  });

  test("rejects a host containing whitespace without querying the database", async () => {
    const result = await resolvePublicTenantByHost(
      throwingSql(),
      "not a valid host"
    );

    expect(result).toBeNull();
  });

  test("rejects an empty string without querying the database", async () => {
    const result = await resolvePublicTenantByHost(throwingSql(), "");

    expect(result).toBeNull();
  });

  test("rejects a host with an invalid label (leading hyphen) without querying the database", async () => {
    const result = await resolvePublicTenantByHost(
      throwingSql(),
      "-bad-label.example.com"
    );

    expect(result).toBeNull();
  });
});
