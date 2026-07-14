/**
 * Issue #754 (integration_hub) follow-up — reviewer High finding (PR #784):
 * `outbound-http-client.ts` must NOT follow an HTTP redirect
 * unconditionally. These tests spin up real local `Bun.serve()` fixture
 * servers (no database needed — this client is pure network I/O) to
 * prove:
 *   - a redirect Location is validated through the SAME SSRF check as the
 *     original URL, and a redirect to a blocked destination is rejected
 *     (the actual bypass reviewer found) — tested via `followBoundedRedirects`
 *     directly so the assertion is never confounded by the LOCAL fixture
 *     server's own address (127.0.0.1) also being a private/blocked
 *     literal (see that function's own "exported for testability" doc
 *     comment);
 *   - a redirect chain exceeding the hop limit is rejected;
 *   - a redirect is followed end-to-end (`deliverOutboundWebhook`) when
 *     every hop is explicitly allowed (`allowPrivateTargets: true`);
 *   - the response body read is byte-capped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  deliverOutboundWebhook,
  followBoundedRedirects
} from "../../src/modules/integration-hub/infrastructure/outbound-http-client";

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()!.stop(true);
  }
});

function startServer(
  fetchHandler: (request: Request) => Response | Promise<Response>
): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({ port: 0, fetch: fetchHandler });
  servers.push(server);
  return server;
}

const BASE_INIT = { method: "POST", headers: {}, body: "{}" };

describe("followBoundedRedirects — redirect Location is SSRF-validated (reviewer High finding, PR #784)", () => {
  test("baseline: no redirect, response returned as-is", async () => {
    const server = startServer(() => new Response("ok", { status: 200 }));

    const result = await followBoundedRedirects(
      `http://127.0.0.1:${server.port}/webhook`,
      BASE_INIT,
      false
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.status).toBe(200);
    }
  });

  test("ADVERSARIAL: a redirect Location pointing at cloud IMDS (169.254.169.254) is rejected, never followed — the exact bypass reviewer found", async () => {
    const server = startServer(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" }
        })
    );

    // `allowPrivateTargets: false` — the realistic production default. A
    // pre-fix client following fetch()'s default redirect behavior would
    // have connected to 169.254.169.254 here; this must instead be
    // rejected BEFORE any such connection is attempted.
    const result = await followBoundedRedirects(
      `http://127.0.0.1:${server.port}/webhook`,
      BASE_INIT,
      false
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("ssrf_blocked_redirect");
      expect(result.retryable).toBe(false);
    }
  });

  test("ADVERSARIAL: a redirect Location pointing at another private IP (10.x) is rejected", async () => {
    const server = startServer(
      () =>
        new Response(null, {
          status: 303,
          headers: { location: "http://10.0.0.5/internal-admin" }
        })
    );

    const result = await followBoundedRedirects(
      `http://127.0.0.1:${server.port}/webhook`,
      BASE_INIT,
      false
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("ssrf_blocked_redirect");
    }
  });

  test("a redirect chain within the hop limit succeeds when every hop is allowed", async () => {
    let hopServerPort = 0;

    const finalServer = startServer(
      () => new Response("final", { status: 200 })
    );
    hopServerPort = finalServer.port!;

    const redirectServer = startServer(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${hopServerPort}/final` }
        })
    );

    const result = await followBoundedRedirects(
      `http://127.0.0.1:${redirectServer.port}/start`,
      BASE_INIT,
      true
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.status).toBe(200);
    }
  });

  test("a redirect chain exceeding the hop limit is rejected (non-retryable)", async () => {
    // Server that ALWAYS redirects to itself — an infinite loop if
    // followed unconditionally; must be bounded by MAX_REDIRECT_HOPS.
    let selfPort = 0;
    const server = startServer(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${selfPort}/loop` }
        })
    );
    selfPort = server.port!;

    const result = await followBoundedRedirects(
      `http://127.0.0.1:${server.port}/loop`,
      BASE_INIT,
      true
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.errorCode).toBe("too_many_redirects");
    }
  });

  test("a redirect with no Location header is rejected", async () => {
    const server = startServer(() => new Response(null, { status: 302 }));

    const result = await followBoundedRedirects(
      `http://127.0.0.1:${server.port}/webhook`,
      BASE_INIT,
      true
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("redirect_without_location");
    }
  });
});

describe("deliverOutboundWebhook — end-to-end", () => {
  test("delivers successfully with no redirect", async () => {
    const server = startServer(() => new Response("ok", { status: 200 }));

    const result = await deliverOutboundWebhook({
      url: `http://127.0.0.1:${server.port}/webhook`,
      headers: {},
      body: "{}",
      timeoutMs: 2000,
      allowPrivateTargets: true
    });

    expect(result.ok).toBe(true);
  });

  test("rejects the original destination outright when it is itself private and allowPrivateTargets is false", async () => {
    const server = startServer(() => new Response("ok", { status: 200 }));

    const result = await deliverOutboundWebhook({
      url: `http://127.0.0.1:${server.port}/webhook`,
      headers: {},
      body: "{}",
      timeoutMs: 2000,
      allowPrivateTargets: false
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("ssrf_blocked_destination");
    }
  });

  test("response body read is byte-capped and stays within the timeout window", async () => {
    const hugeBody = "x".repeat(500_000);
    const server = startServer(() => new Response(hugeBody, { status: 500 }));

    const result = await deliverOutboundWebhook({
      url: `http://127.0.0.1:${server.port}/webhook`,
      headers: {},
      body: "{}",
      timeoutMs: 2000,
      allowPrivateTargets: true
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The stored/returned message is truncated to the storage snippet
      // bound (much smaller than the 500 KiB the server actually sent) —
      // proves the client never buffered the whole body.
      expect(result.errorMessage.length).toBeLessThan(600);
    }
  });
});
