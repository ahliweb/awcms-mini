/**
 * `createNewsMediaR2Client` against a real local fake S3-compatible HTTP
 * server (`Bun.serve`) — same convention
 * `tests/integration/object-dispatch.integration.test.ts` already
 * established for `Bun.S3Client` (a real client library talking to a real,
 * if fake, HTTP endpoint is far more trustworthy than mocking the client
 * itself). Not gated behind `DATABASE_URL` — no database involved, just an
 * HTTP server, so this lives in `tests/unit` and always runs.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { createNewsMediaR2Client } from "../../src/modules/news-portal/infrastructure/news-media-r2-client";
import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";

afterEach(() => {
  resetProviderCircuitBreakersForTests();
});

const BASE_CONFIG = {
  accountId: "test-account",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  bucket: "test-bucket"
};

describe("createNewsMediaR2Client (Issue #634)", () => {
  test("presignUploadUrl returns a scoped, expiring URL without a network call", () => {
    const client = createNewsMediaR2Client(BASE_CONFIG);
    const url = client.presignUploadUrl({
      objectKey: "news-media/tenant/2026/07/abc.jpg",
      mimeType: "image/jpeg",
      ttlSeconds: 300
    });

    expect(typeof url).toBe("string");
    expect(url).toContain("news-media/tenant/2026/07/abc.jpg");
    // Never leaks the raw secret access key into the URL string as-is —
    // presign signs, it does not embed the secret literally.
    expect(url).not.toContain(BASE_CONFIG.secretAccessKey);
  });

  test("headObject: exists=false for a key the fake server reports as missing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "HEAD") {
          return new Response(null, { status: 404 });
        }
        return new Response("", { status: 404 });
      }
    });

    try {
      const client = createNewsMediaR2Client({
        ...BASE_CONFIG,
        endpoint: `http://127.0.0.1:${server.port}`
      });
      const result = await client.headObject("missing.jpg");
      expect(result).toEqual({ ok: true, exists: false });
    } finally {
      server.stop(true);
    }
  });

  test("headObject: exists=true with the real Content-Length reported by R2", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": "12345" }
          });
        }
        return new Response("", { status: 200 });
      }
    });

    try {
      const client = createNewsMediaR2Client({
        ...BASE_CONFIG,
        endpoint: `http://127.0.0.1:${server.port}`
      });
      const result = await client.headObject("present.jpg");
      expect(result).toEqual({ ok: true, exists: true, sizeBytes: 12345 });
    } finally {
      server.stop(true);
    }
  });

  test("getObject: returns the real bytes read from R2 (a full GET, not a HEAD)", async () => {
    const payload = new TextEncoder().encode("fake jpeg bytes");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(payload.byteLength) }
          });
        }
        if (request.method === "GET") {
          return new Response(payload, { status: 200 });
        }
        return new Response("", { status: 404 });
      }
    });

    try {
      const client = createNewsMediaR2Client({
        ...BASE_CONFIG,
        endpoint: `http://127.0.0.1:${server.port}`
      });
      const result = await client.getObject("present.jpg");
      expect(result.ok).toBe(true);
      expect(result.ok && Array.from(result.bytes)).toEqual(
        Array.from(payload)
      );
    } finally {
      server.stop(true);
    }
  });

  test("headObject: a provider error (not a clean 404) trips the circuit breaker after repeated failures", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("simulated outage", { status: 500 });
      }
    });

    try {
      const client = createNewsMediaR2Client({
        ...BASE_CONFIG,
        endpoint: `http://127.0.0.1:${server.port}`,
        timeoutMs: 2000
      });

      let lastResult;
      for (let i = 0; i < 6; i += 1) {
        lastResult = await client.headObject("whatever.jpg");
      }

      expect(lastResult?.ok).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
