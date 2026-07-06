import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetProviderCircuitBreakersForTests } from "../src/lib/database/circuit-breaker";
import {
  createNoopObjectUploader,
  createR2ObjectUploader
} from "../src/modules/sync-storage/infrastructure/object-storage-uploader";

async function sha256Hex(content: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

describe("createNoopObjectUploader", () => {
  test("always succeeds without touching the filesystem or network", async () => {
    const uploader = createNoopObjectUploader();

    const result = await uploader({
      objectKey: "does/not/matter",
      localPath: "/path/does/not/exist",
      checksumSha256: "a".repeat(64)
    });

    expect(result).toEqual({ ok: true });
  });
});

describe("createR2ObjectUploader", () => {
  let tmpDir: string;
  let requestCount = 0;
  let lastRequest: { method: string; pathname: string } | undefined;
  let serverBehavior: "ok" | "fail" | "slow" = "ok";
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(async () => {
    resetProviderCircuitBreakersForTests();
    tmpDir = await mkdtemp(path.join(tmpdir(), "awcms-mini-object-upload-"));
    requestCount = 0;
    lastRequest = undefined;
    serverBehavior = "ok";

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestCount += 1;
        lastRequest = {
          method: request.method,
          pathname: new URL(request.url).pathname
        };

        if (serverBehavior === "fail") {
          return new Response("boom", { status: 500 });
        }

        if (serverBehavior === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        return new Response("", { status: 200 });
      }
    });
  });

  afterEach(async () => {
    server.stop(true);
    await rm(tmpDir, { recursive: true, force: true });
    resetProviderCircuitBreakersForTests();
  });

  function makeUploader(timeoutMs = 5000) {
    return createR2ObjectUploader({
      accountId: "test-account",
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      bucket: "test-bucket",
      endpoint: `http://127.0.0.1:${server.port}`,
      timeoutMs
    });
  }

  test("uploads a local file whose checksum matches, via a real PUT round trip", async () => {
    const content = "hello world";
    const checksum = await sha256Hex(content);
    const localPath = path.join(tmpDir, "receipt.pdf");
    await writeFile(localPath, content);

    const uploader = makeUploader();
    const result = await uploader({
      objectKey: "receipts/1.pdf",
      localPath,
      checksumSha256: checksum
    });

    expect(result).toEqual({ ok: true });
    expect(requestCount).toBe(1);
    expect(lastRequest?.method).toBe("PUT");
    expect(lastRequest?.pathname).toBe("/test-bucket/receipts/1.pdf");
  });

  test("fails without ever calling the network when the local checksum does not match", async () => {
    const localPath = path.join(tmpDir, "receipt.pdf");
    await writeFile(localPath, "hello world");

    const uploader = makeUploader();
    const result = await uploader({
      objectKey: "receipts/1.pdf",
      localPath,
      checksumSha256: "f".repeat(64)
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/checksum/i);
    expect(requestCount).toBe(0);
  });

  test("fails cleanly when the local file does not exist", async () => {
    const uploader = makeUploader();
    const result = await uploader({
      objectKey: "receipts/missing.pdf",
      localPath: path.join(tmpDir, "does-not-exist.pdf"),
      checksumSha256: "a".repeat(64)
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/not found/i);
    expect(requestCount).toBe(0);
  });

  test("surfaces a provider error (5xx) as a failed result", async () => {
    serverBehavior = "fail";
    const content = "hello world";
    const checksum = await sha256Hex(content);
    const localPath = path.join(tmpDir, "receipt.pdf");
    await writeFile(localPath, content);

    const uploader = makeUploader();
    const result = await uploader({
      objectKey: "receipts/1.pdf",
      localPath,
      checksumSha256: checksum
    });

    expect(result.ok).toBe(false);
    expect(requestCount).toBe(1);
  });

  test("times out a wedged provider instead of hanging forever", async () => {
    serverBehavior = "slow";
    const content = "hello world";
    const checksum = await sha256Hex(content);
    const localPath = path.join(tmpDir, "receipt.pdf");
    await writeFile(localPath, content);

    const uploader = makeUploader(20);
    const result = await uploader({
      objectKey: "receipts/1.pdf",
      localPath,
      checksumSha256: checksum
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/timed out/i);
  });

  test("opens the circuit breaker after consecutive failures and short-circuits without calling the network", async () => {
    serverBehavior = "fail";
    const content = "hello world";
    const checksum = await sha256Hex(content);
    const localPath = path.join(tmpDir, "receipt.pdf");
    await writeFile(localPath, content);

    const uploader = makeUploader();

    // Default threshold is 5 consecutive failures (see circuit-breaker.ts).
    for (let i = 0; i < 5; i += 1) {
      const result = await uploader({
        objectKey: "receipts/1.pdf",
        localPath,
        checksumSha256: checksum
      });
      expect(result.ok).toBe(false);
    }

    expect(requestCount).toBe(5);

    const sixth = await uploader({
      objectKey: "receipts/1.pdf",
      localPath,
      checksumSha256: checksum
    });

    expect(sixth.ok).toBe(false);
    expect((sixth as { error: string }).error).toMatch(/circuit breaker/i);
    // The breaker short-circuited — no sixth network call was made.
    expect(requestCount).toBe(5);
  });
});
