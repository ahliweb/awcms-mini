/**
 * Integration tests for the object sync queue dispatcher (Issue #436)
 * against a real PostgreSQL. Exercises the full three-phase claim/upload/
 * finalize cycle (`src/modules/sync-storage/application/object-dispatch.ts`)
 * — a real HTTP round trip against a local fake S3/R2-compatible server
 * standing in for Cloudflare R2 (there is no real R2 account in this
 * environment; `Bun.S3Client` talking to a real local HTTP server is a
 * genuine exercise of our own upload wiring, not a mock of it), and forces
 * real failures (server returns 500) to drive the exponential-backoff
 * retry schedule (`evaluateObjectRetry`, reused unmodified) through to
 * exhaustion and `failed`, then the existing manual-retry endpoint logic
 * (`POST /sync/object-queue/{id}/retry`, unchanged by this issue) to bring
 * it back to `pending` and succeed on the next dispatch.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { getDatabaseClient } from "../../src/lib/database/client";
import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";
import { dispatchObjectSyncQueue } from "../../src/modules/sync-storage/application/object-dispatch";
import {
  createNoopObjectUploader,
  createR2ObjectUploader
} from "../../src/modules/sync-storage/infrastructure/object-storage-uploader";

const TENANT_ID = "44444444-4444-4444-4444-444444444444";
const NODE_ID = "55555555-5555-5555-5555-555555555555";

type QueueRow = {
  id: string;
  status: string;
  retry_count: number;
  next_retry_at: Date | null;
  last_error: string | null;
  uploaded_at: Date | null;
};

async function fetchQueueRow(objectKey: string): Promise<QueueRow> {
  const admin = getAdminSql();
  const rows = (await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${TENANT_ID}'`);
    return tx`
      SELECT id, status, retry_count, next_retry_at, last_error, uploaded_at
      FROM awcms_mini_object_sync_queue
      WHERE tenant_id = ${TENANT_ID} AND object_key = ${objectKey}
    `;
  })) as QueueRow[];

  return rows[0]!;
}

async function seedQueueEntry(input: {
  objectKey: string;
  localPath: string;
  checksumSha256: string;
  requiresUpload: boolean;
}): Promise<void> {
  const admin = getAdminSql();
  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${TENANT_ID}'`);
    await tx`
      INSERT INTO awcms_mini_object_sync_queue
        (tenant_id, node_id, object_key, local_path, checksum_sha256, byte_size, requires_upload, status)
      VALUES (
        ${TENANT_ID}, ${NODE_ID}, ${input.objectKey}, ${input.localPath},
        ${input.checksumSha256}, 11, ${input.requiresUpload}, 'pending'
      )
    `;
  });
}

async function sha256Hex(content: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

const suite = integrationEnabled ? describe : describe.skip;

suite("Object sync queue dispatcher (real Postgres)", () => {
  let tmpDir: string;

  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetProviderCircuitBreakersForTests();
    tmpDir = await mkdtemp(path.join(tmpdir(), "awcms-mini-dispatch-"));

    await getAdminSql()`
      INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
      VALUES (${TENANT_ID}, 'dispatch-test-tenant', 'Dispatch Test Tenant')
      ON CONFLICT (id) DO NOTHING
    `;
    await getAdminSql().begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${TENANT_ID}'`);
      await tx`
        INSERT INTO awcms_mini_sync_nodes (id, tenant_id, node_code, node_name)
        VALUES (${NODE_ID}, ${TENANT_ID}, 'dispatch-test-node', 'Dispatch Test Node')
        ON CONFLICT (id) DO NOTHING
      `;
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    resetProviderCircuitBreakersForTests();
  });

  test("provider off (requires_upload = false): dispatched with zero network calls, marked sent", async () => {
    await seedQueueEntry({
      objectKey: "receipts/off.pdf",
      localPath: "/does/not/matter",
      checksumSha256: "a".repeat(64),
      requiresUpload: false
    });

    const sql = getDatabaseClient();
    const result = await dispatchObjectSyncQueue(sql, TENANT_ID);

    expect(result).toMatchObject({
      claimed: 1,
      sent: 1,
      retried: 0,
      failed: 0
    });

    const row = await fetchQueueRow("receipts/off.pdf");
    expect(row.status).toBe("sent");
    expect(row.uploaded_at).not.toBeNull();
  });

  test("provider on (requires_upload = true): real PUT round trip to a fake R2 endpoint marks sent", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requestCount += 1;
        return new Response("", { status: 200 });
      }
    });

    try {
      const content = "hello receipt";
      const checksum = await sha256Hex(content);
      const localPath = path.join(tmpDir, "on.pdf");
      await writeFile(localPath, content);
      await seedQueueEntry({
        objectKey: "receipts/on.pdf",
        localPath,
        checksumSha256: checksum,
        requiresUpload: true
      });

      const sql = getDatabaseClient();
      const result = await dispatchObjectSyncQueue(sql, TENANT_ID, {
        resolveUploader: () =>
          createR2ObjectUploader({
            accountId: "test-account",
            accessKeyId: "test-key",
            secretAccessKey: "test-secret",
            bucket: "test-bucket",
            endpoint: `http://127.0.0.1:${server.port}`
          })
      });

      expect(result).toMatchObject({
        claimed: 1,
        sent: 1,
        retried: 0,
        failed: 0
      });
      expect(requestCount).toBe(1);

      const row = await fetchQueueRow("receipts/on.pdf");
      expect(row.status).toBe("sent");
      expect(row.uploaded_at).not.toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("retry: forced failures back off, exhaust to failed+last_error, manual retry resets to pending, then succeeds", async () => {
    let behavior: "fail" | "ok" = "fail";
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requestCount += 1;
        return behavior === "fail"
          ? new Response("simulated provider outage", { status: 500 })
          : new Response("", { status: 200 });
      }
    });

    try {
      const content = "hello retry";
      const checksum = await sha256Hex(content);
      const localPath = path.join(tmpDir, "retry.pdf");
      await writeFile(localPath, content);
      await seedQueueEntry({
        objectKey: "receipts/retry.pdf",
        localPath,
        checksumSha256: checksum,
        requiresUpload: true
      });

      const sql = getDatabaseClient();
      const resolveUploader = () =>
        createR2ObjectUploader({
          accountId: "test-account",
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          bucket: "test-bucket",
          endpoint: `http://127.0.0.1:${server.port}`
        });

      // Drive real attempts through the full backoff schedule
      // (OBJECT_SYNC_MAX_RETRIES = 5 in domain/object-queue.ts) by
      // fast-forwarding the dispatcher's injected `now` past each
      // computed next_retry_at instead of really sleeping. The
      // object-storage circuit breaker (a separate, independent safety net
      // — see the dedicated "circuit breaker open" test below) is reset
      // before each attempt here so this test isolates per-row
      // backoff/exhaustion only; otherwise 5 consecutive failures would trip
      // the breaker at the same point the row's own retry budget is
      // exhausted, and the 6th attempt would be skipped (breaker-gated)
      // rather than actually attempted and marked `failed`.
      let now = new Date("2026-07-06T00:00:00.000Z");

      for (let attempt = 0; attempt < 6; attempt += 1) {
        resetProviderCircuitBreakersForTests();
        const result = await dispatchObjectSyncQueue(sql, TENANT_ID, {
          now,
          resolveUploader
        });
        expect(result.claimed).toBe(1);

        const row = await fetchQueueRow("receipts/retry.pdf");

        if (row.status === "failed") {
          break;
        }

        expect(row.status).toBe("pending");
        expect(row.next_retry_at).not.toBeNull();
        // Fast-forward just past the scheduled retry so the next pass's
        // claim query picks this row back up.
        now = new Date(row.next_retry_at!.getTime() + 1000);
      }

      const exhausted = await fetchQueueRow("receipts/retry.pdf");
      expect(exhausted.status).toBe("failed");
      expect(exhausted.last_error).toMatch(/simulated provider outage|boom/i);
      expect(requestCount).toBe(6); // OBJECT_SYNC_MAX_RETRIES (5) + the first attempt

      // A second dispatch pass at the same/later `now` does not re-attempt a
      // `failed` row on its own — only the manual retry endpoint's logic
      // (reused here directly rather than via HTTP, its own coverage lives
      // in sync-admin.integration.test.ts) can bring it back.
      const noOp = await dispatchObjectSyncQueue(sql, TENANT_ID, {
        now: new Date(now.getTime() + 60 * 60_000),
        resolveUploader
      });
      expect(noOp.claimed).toBe(0);

      // Manual admin retry: reset status/retry_count/next_retry_at/last_error
      // back to pending (same transition `POST
      // /sync/object-queue/{id}/retry` performs).
      await getAdminSql().begin(async (tx) => {
        await tx.unsafe(`SET LOCAL app.current_tenant_id = '${TENANT_ID}'`);
        await tx`
          UPDATE awcms_mini_object_sync_queue
          SET status = 'pending', retry_count = 0, next_retry_at = null, last_error = null
          WHERE tenant_id = ${TENANT_ID} AND id = ${exhausted.id} AND status = 'failed'
        `;
      });

      const resetRow = await fetchQueueRow("receipts/retry.pdf");
      expect(resetRow.status).toBe("pending");

      // Now the provider recovers, and the next dispatch succeeds.
      behavior = "ok";
      const recovered = await dispatchObjectSyncQueue(sql, TENANT_ID, {
        now: new Date(now.getTime() + 61 * 60_000),
        resolveUploader
      });
      expect(recovered).toMatchObject({
        claimed: 1,
        sent: 1,
        retried: 0,
        failed: 0
      });

      const finalRow = await fetchQueueRow("receipts/retry.pdf");
      expect(finalRow.status).toBe("sent");
      expect(finalRow.uploaded_at).not.toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("idempotency: re-dispatching after already sent does not re-invoke the uploader", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requestCount += 1;
        return new Response("", { status: 200 });
      }
    });

    try {
      const content = "idempotent";
      const checksum = await sha256Hex(content);
      const localPath = path.join(tmpDir, "idempotent.pdf");
      await writeFile(localPath, content);
      await seedQueueEntry({
        objectKey: "receipts/idempotent.pdf",
        localPath,
        checksumSha256: checksum,
        requiresUpload: true
      });

      const sql = getDatabaseClient();
      const resolveUploader = () =>
        createR2ObjectUploader({
          accountId: "test-account",
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          bucket: "test-bucket",
          endpoint: `http://127.0.0.1:${server.port}`
        });

      const first = await dispatchObjectSyncQueue(sql, TENANT_ID, {
        resolveUploader
      });
      expect(first).toMatchObject({ claimed: 1, sent: 1 });
      expect(requestCount).toBe(1);

      // Re-running the dispatcher (e.g. the CLI script's per-tenant loop,
      // or a second scheduled run before the queue has new work) must not
      // re-claim or re-upload an already-`sent` row.
      const second = await dispatchObjectSyncQueue(sql, TENANT_ID, {
        resolveUploader
      });
      expect(second).toMatchObject({ claimed: 0, sent: 0 });
      expect(requestCount).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("circuit breaker open: upload-required rows are left untouched, provider-off rows still dispatch", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("boom", { status: 500 });
      }
    });

    try {
      const content = "breaker";
      const checksum = await sha256Hex(content);
      const localPath = path.join(tmpDir, "breaker.pdf");
      await writeFile(localPath, content);

      const resolveUploader = (requiresUpload: boolean) =>
        requiresUpload
          ? createR2ObjectUploader({
              accountId: "test-account",
              accessKeyId: "test-key",
              secretAccessKey: "test-secret",
              bucket: "test-bucket",
              endpoint: `http://127.0.0.1:${server.port}`
            })
          : createNoopObjectUploader();

      // Trip the shared object-storage breaker open with five consecutive
      // failed uploads (one row at a time, forcing five separate dispatch
      // passes so the breaker accumulates failures the same way it would
      // in a real deployment with a genuinely down provider).
      let now = new Date("2026-07-06T00:00:00.000Z");
      for (let i = 0; i < 5; i += 1) {
        await seedQueueEntry({
          objectKey: `receipts/breaker-${i}.pdf`,
          localPath,
          checksumSha256: checksum,
          requiresUpload: true
        });
        await dispatchObjectSyncQueue(getDatabaseClient(), TENANT_ID, {
          now,
          resolveUploader
        });
        now = new Date(now.getTime() + 1000);
      }

      // Seed one more upload-required row and one provider-off row.
      await seedQueueEntry({
        objectKey: "receipts/breaker-gated.pdf",
        localPath,
        checksumSha256: checksum,
        requiresUpload: true
      });
      await seedQueueEntry({
        objectKey: "receipts/breaker-local.pdf",
        localPath,
        checksumSha256: checksum,
        requiresUpload: false
      });

      const result = await dispatchObjectSyncQueue(
        getDatabaseClient(),
        TENANT_ID,
        {
          now,
          resolveUploader
        }
      );

      // The breaker should now be open (5 consecutive failures, default
      // threshold) — the upload-required row is not even claimed...
      expect(result.uploadBreakerOpen).toBe(true);
      const gated = await fetchQueueRow("receipts/breaker-gated.pdf");
      expect(gated.status).toBe("pending");

      // ...but the provider-off row is unaffected and still dispatches.
      expect(result.claimed).toBe(1);
      expect(result.sent).toBe(1);
      const local = await fetchQueueRow("receipts/breaker-local.pdf");
      expect(local.status).toBe("sent");
    } finally {
      server.stop(true);
    }
  });
});
