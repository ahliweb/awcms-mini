import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";
import {
  enforceTurnstileIfRequired,
  isTurnstileEnabled,
  isTurnstileRequired,
  resolveTurnstileConfig,
  resolveTurnstileTimeoutMs,
  verifyTurnstileToken
} from "../../src/lib/security/turnstile";

const FULL_ONLINE_ENV = {
  AUTH_ONLINE_SECURITY_ENABLED: "true",
  AUTH_ONLINE_SECURITY_PROFILE: "full_online"
} as const;

describe("isTurnstileEnabled", () => {
  test("false when unset", () => {
    expect(isTurnstileEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test('true only for the literal string "true"', () => {
    expect(
      isTurnstileEnabled({ TURNSTILE_ENABLED: "true" } as NodeJS.ProcessEnv)
    ).toBe(true);
    expect(
      isTurnstileEnabled({ TURNSTILE_ENABLED: "TRUE" } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe("resolveTurnstileTimeoutMs", () => {
  test("defaults to 5000ms when unset", () => {
    expect(resolveTurnstileTimeoutMs({} as NodeJS.ProcessEnv)).toBe(5000);
  });

  test("uses a valid positive override", () => {
    expect(
      resolveTurnstileTimeoutMs({
        TURNSTILE_VERIFY_TIMEOUT_MS: "2000"
      } as NodeJS.ProcessEnv)
    ).toBe(2000);
  });

  test("falls back to the default for non-numeric/zero/negative values", () => {
    expect(
      resolveTurnstileTimeoutMs({
        TURNSTILE_VERIFY_TIMEOUT_MS: "not-a-number"
      } as NodeJS.ProcessEnv)
    ).toBe(5000);
    expect(
      resolveTurnstileTimeoutMs({
        TURNSTILE_VERIFY_TIMEOUT_MS: "0"
      } as NodeJS.ProcessEnv)
    ).toBe(5000);
  });
});

describe("isTurnstileRequired — the shared gate every endpoint checks", () => {
  test("false when the full-online gate (#587) is off, even if TURNSTILE_ENABLED=true", () => {
    expect(
      isTurnstileRequired({
        TURNSTILE_ENABLED: "true"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  test("false when TURNSTILE_ENABLED is not set, even if the full-online gate is on", () => {
    expect(
      isTurnstileRequired({ ...FULL_ONLINE_ENV } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  test("true only when both the full-online gate and TURNSTILE_ENABLED agree", () => {
    expect(
      isTurnstileRequired({
        ...FULL_ONLINE_ENV,
        TURNSTILE_ENABLED: "true"
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });
});

describe("resolveTurnstileConfig", () => {
  test("null when TURNSTILE_SECRET_KEY is missing", () => {
    expect(resolveTurnstileConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  test("returns a config when the secret key is set", () => {
    const config = resolveTurnstileConfig({
      TURNSTILE_SECRET_KEY: "a-secret"
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({ secretKey: "a-secret", timeoutMs: 5000 });
  });
});

describe("verifyTurnstileToken", () => {
  beforeEach(() => {
    resetProviderCircuitBreakersForTests();
  });

  afterEach(() => {
    resetProviderCircuitBreakersForTests();
  });

  test("succeeds when Cloudflare reports success", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ success: true });
      }
    });

    const result = await verifyTurnstileToken("a-real-token", {
      secretKey: "super-secret-turnstile-value",
      verifyUrl: `http://127.0.0.1:${server.port}`
    });

    expect(result).toEqual({ ok: true });
  });

  test("fails cleanly when Cloudflare reports success=false, with error codes surfaced", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          success: false,
          "error-codes": ["invalid-input-response"]
        });
      }
    });

    const result = await verifyTurnstileToken("bad-token", {
      secretKey: "super-secret-turnstile-value",
      verifyUrl: `http://127.0.0.1:${server.port}`
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain(
      "invalid-input-response"
    );
  });

  test("never includes the configured secret in a failure error message, even from a server that echoes it back", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        // A deliberately adversarial server that echoes the posted secret
        // back in its response body — the built error message only ever
        // uses the HTTP status and Cloudflare's own numeric error-codes
        // array, never the raw response text, so this can't leak either
        // way; `redact()` is defense in depth for the catch-block path
        // below, not this one.
        return new Response("super-secret-turnstile-value not authorized", {
          status: 401
        });
      }
    });

    const result = await verifyTurnstileToken("some-token", {
      secretKey: "super-secret-turnstile-value",
      verifyUrl: `http://127.0.0.1:${server.port}`
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).not.toContain(
      "super-secret-turnstile-value"
    );
  });

  test("redacts the configured secret out of a thrown network-error message", async () => {
    const result = await verifyTurnstileToken("some-token", {
      secretKey: "super-secret-turnstile-value",
      // No server listening on this port — fetch() rejects, exercising the
      // catch block's redact() call directly.
      verifyUrl: "http://127.0.0.1:1"
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).not.toContain(
      "super-secret-turnstile-value"
    );
  });

  test("times out a wedged provider instead of hanging forever", async () => {
    using server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(500);
        return Response.json({ success: true });
      }
    });

    const result = await verifyTurnstileToken("some-token", {
      secretKey: "super-secret-turnstile-value",
      verifyUrl: `http://127.0.0.1:${server.port}`,
      timeoutMs: 20
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/timed out/i);
  });

  test("opens the circuit breaker after consecutive PROVIDER failures (5xx), not client-rejected tokens", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("upstream error", { status: 500 });
      }
    });

    const config = {
      secretKey: "super-secret-turnstile-value",
      verifyUrl: `http://127.0.0.1:${server.port}`
    };

    for (let i = 0; i < 5; i += 1) {
      await verifyTurnstileToken("some-token", config);
    }

    const sixth = await verifyTurnstileToken("some-token", config);

    expect(sixth.ok).toBe(false);
    expect((sixth as { error: string }).error).toMatch(/circuit breaker/i);
  });

  test("never trips the circuit breaker on repeated client-rejected tokens (success:false) — an unauthenticated caller must not be able to lock out every tenant's login/reset/setup by submitting garbage tokens", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          success: false,
          "error-codes": ["invalid-input-response"]
        });
      }
    });

    const config = {
      secretKey: "super-secret-turnstile-value",
      verifyUrl: `http://127.0.0.1:${server.port}`
    };

    let lastResult:
      Awaited<ReturnType<typeof verifyTurnstileToken>> | undefined;

    for (let i = 0; i < 10; i += 1) {
      lastResult = await verifyTurnstileToken("bad-token", config);
    }

    expect(lastResult?.ok).toBe(false);
    expect((lastResult as { error: string }).error).not.toMatch(
      /circuit breaker/i
    );
    expect((lastResult as { error: string }).error).toMatch(
      /invalid-input-response/
    );
  });
});

describe("enforceTurnstileIfRequired", () => {
  test("skips (ok:true) without any network call when the gate is not active", async () => {
    const result = await enforceTurnstileIfRequired(
      undefined,
      "1.2.3.4",
      {} as NodeJS.ProcessEnv
    );

    expect(result).toEqual({ ok: true });
  });

  test("rejects with TURNSTILE_REQUIRED when the gate is active but no token was submitted", async () => {
    const result = await enforceTurnstileIfRequired(undefined, "1.2.3.4", {
      ...FULL_ONLINE_ENV,
      TURNSTILE_ENABLED: "true",
      TURNSTILE_SECRET_KEY: "a-secret"
    } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, code: "TURNSTILE_REQUIRED" });
  });

  test("rejects with TURNSTILE_REQUIRED when the token is an empty string", async () => {
    const result = await enforceTurnstileIfRequired("", "1.2.3.4", {
      ...FULL_ONLINE_ENV,
      TURNSTILE_ENABLED: "true",
      TURNSTILE_SECRET_KEY: "a-secret"
    } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, code: "TURNSTILE_REQUIRED" });
  });

  test("fails closed with TURNSTILE_INVALID when the gate is active but misconfigured (no secret key)", async () => {
    const result = await enforceTurnstileIfRequired("a-token", "1.2.3.4", {
      ...FULL_ONLINE_ENV,
      TURNSTILE_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result).toEqual({ ok: false, code: "TURNSTILE_INVALID" });
  });
});
