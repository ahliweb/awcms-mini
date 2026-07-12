/**
 * Integration tests for the R2 media lifecycle cleanup & reconciliation job
 * (Issue #690, epic #679 platform-hardening — "runtime/worker hardening"
 * wave, following #691/#689/#694/#695/#687/#697), against a real PostgreSQL
 * (as the actual least-privilege `awcms_mini_worker` role, migration 046's
 * new grant) and a fake, real HTTP, S3-compatible local R2 server (same
 * "inject a real `Bun.S3Client` against a fake local server" convention
 * `tests/integration/news-media-upload-session-api.integration.test.ts`/
 * `tests/integration/object-dispatch.integration.test.ts` already
 * established).
 *
 * Fixture setup (creating/finalizing/attaching media rows) uses the APP role
 * (`getTestSql()`) — exactly what a real client's upload flow does via
 * `POST /api/v1/media/news-images/...`, which needs INSERT. The
 * reconciliation job itself (`reconcileNewsMediaForTenant`/
 * `reconcileNewsMediaForAllTenants`) is exercised via the WORKER role
 * (`getWorkerTestSql()`) — the actual least-privilege role
 * `scripts/news-media-r2-reconcile.ts` connects as in production (migration
 * 046's grant: SELECT/UPDATE/DELETE only, deliberately no INSERT — this job
 * never creates new media rows).
 *
 * Exercises `reconcileNewsMediaForTenant`/`reconcileNewsMediaForAllTenants`
 * (`news-media-reconciliation.ts`) directly — the exact functions
 * `scripts/news-media-r2-reconcile.ts` thinly wraps with `runJob` — proving
 * every acceptance criterion from Issue #690:
 *
 * - Cleanup NEVER deletes a currently-referenced/active object, including
 *   under a genuine race (a brand-new DB row for the same key appears
 *   between this run's DB snapshot and its physical-delete step).
 * - Reruns are idempotent (a second run after a first does nothing more).
 * - A provider (R2) outage/listing failure fails safely — no crash, no
 *   thrown exception, and does not block another tenant's reconciliation
 *   or unrelated DB work in the same process.
 * - Dry-run performs zero mutations.
 * - Partial upload (claimed but never fully committed), missing object
 *   (DB says present, R2 disagrees — "orphan-in-DB", report-only), R2
 *   listing pagination, and retry-after-transient-failure are all covered.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getTestSql,
  getWorkerTestSql,
  integrationEnabled,
  provisionAppRole,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { withTenant } from "../../src/lib/database/tenant-context";
import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";
import type { NewsMediaR2Config } from "../../src/modules/news-portal/domain/news-media-r2-config";
import {
  createNewsMediaR2Client,
  type NewsMediaR2Client
} from "../../src/modules/news-portal/infrastructure/news-media-r2-client";
import {
  createPendingNewsMediaObject,
  fetchNewsMediaObjectById,
  markNewsMediaObjectOrphaned,
  markNewsMediaObjectUploaded,
  markNewsMediaObjectVerified
} from "../../src/modules/news-portal/application/news-media-object-directory";
import {
  reconcileNewsMediaForAllTenants,
  reconcileNewsMediaForTenant
} from "../../src/modules/news-portal/application/news-media-reconciliation";

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_B = "aaaaaaaa-0000-0000-0000-000000000002";
const ACTOR_ID = "cccccccc-0000-0000-0000-000000000001";
const BUCKET = "news-media-reconcile-test-bucket";

const CONFIG: NewsMediaR2Config = {
  enabled: true,
  accountId: "test-account",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  bucket: BUCKET,
  publicBaseUrl: "https://media.example.test",
  presignedUploadTtlSeconds: 300,
  maxUploadBytes: 10_485_760,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  pendingTtlMinutes: 60,
  orphanGraceDays: 30
};

async function seedTenants(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${TENANT_A}, 'reconcile-tenant-a', 'Reconcile Tenant A', 'Legal A', 'active', 'en', 'light'),
      (${TENANT_B}, 'reconcile-tenant-b', 'Reconcile Tenant B', 'Legal B', 'active', 'en', 'light')
  `;
}

async function backdateCreatedAt(
  tenantId: string,
  objectId: string,
  ago: string
): Promise<void> {
  await getAdminSql().begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    await tx`
      UPDATE awcms_mini_news_media_objects
      SET created_at = now() - ${ago}::interval
      WHERE tenant_id = ${tenantId} AND id = ${objectId}
    `;
  });
}

async function backdateOrphanedAt(
  tenantId: string,
  objectId: string,
  ago: string
): Promise<void> {
  await getAdminSql().begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    await tx`
      UPDATE awcms_mini_news_media_objects
      SET orphaned_at = now() - ${ago}::interval
      WHERE tenant_id = ${tenantId} AND id = ${objectId}
    `;
  });
}

/**
 * Directly inserts a row for an EXACT, caller-chosen `object_key` (bypassing
 * the normal random-key-generating creation flow) — used only to simulate
 * the race scenario, where a NEW row must appear for the SAME key an
 * earlier snapshot already saw with no row, sitting in R2. Uses the ADMIN
 * connection (bypasses RLS/grants) — this simulates a real client's INSERT
 * (which would go through the app role in production), not the worker
 * role's own capabilities.
 */
async function rawInsertVerifiedRowForKey(
  tenantId: string,
  objectKey: string
): Promise<string> {
  return getAdminSql().begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    const rows = (await tx`
      INSERT INTO awcms_mini_news_media_objects
        (tenant_id, bucket_name, object_key, public_url, mime_type, status,
         created_by_tenant_user_id)
      VALUES (
        ${tenantId}, ${BUCKET}, ${objectKey},
        ${"https://media.example.test/" + objectKey}, 'image/jpeg', 'verified',
        ${ACTOR_ID}
      )
      RETURNING id
    `) as { id: string }[];
    return rows[0]!.id;
  });
}

type FakeR2Object = { bytes: Uint8Array; lastModified: string };

/**
 * Minimal in-memory fake S3-compatible HTTP server supporting HEAD/GET/
 * DELETE and a real `ListObjectsV2` (`list-type=2`) XML response with
 * pagination — path-style `/{bucket}/{objectKey}`, confirmed empirically to
 * be what `Bun.S3Client` requests (same convention as the existing fake R2
 * servers in this test suite, e.g.
 * `news-media-upload-session-api.integration.test.ts`).
 */
function startFakeR2Server(options: { failListForPrefix?: string } = {}): {
  server: ReturnType<typeof Bun.serve>;
  put: (key: string, lastModified?: string) => void;
  has: (key: string) => boolean;
  deletedKeys: string[];
} {
  const store = new Map<string, FakeR2Object>();
  const deletedKeys: string[] = [];
  const bucketRootPath = `/${BUCKET}/`;
  const bytes = new TextEncoder().encode("fake-bytes");

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (
        url.pathname === bucketRootPath &&
        url.searchParams.get("list-type") === "2"
      ) {
        const listPrefix = url.searchParams.get("prefix") ?? "";

        if (
          options.failListForPrefix &&
          listPrefix.startsWith(options.failListForPrefix)
        ) {
          return new Response("simulated R2 outage", { status: 500 });
        }

        const maxKeys = Number(url.searchParams.get("max-keys") ?? "1000");
        const continuationToken = url.searchParams.get("continuation-token");
        const startIndex = continuationToken ? Number(continuationToken) : 0;
        const allKeys = [...store.keys()]
          .filter((key) => key.startsWith(listPrefix))
          .sort();
        const page = allKeys.slice(startIndex, startIndex + maxKeys);
        const isTruncated = startIndex + maxKeys < allKeys.length;
        const nextToken = isTruncated ? String(startIndex + maxKeys) : null;

        const contentsXml = page
          .map((key) => {
            const object = store.get(key)!;
            return `<Contents><Key>${key}</Key><LastModified>${object.lastModified}</LastModified><Size>${object.bytes.byteLength}</Size></Contents>`;
          })
          .join("");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${BUCKET}</Name>
  <KeyCount>${page.length}</KeyCount>
  <MaxKeys>${maxKeys}</MaxKeys>
  <IsTruncated>${isTruncated}</IsTruncated>
  ${nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : ""}
  ${contentsXml}
</ListBucketResult>`;

        return new Response(xml, {
          status: 200,
          headers: { "content-type": "application/xml" }
        });
      }

      if (!url.pathname.startsWith(bucketRootPath)) {
        return new Response("not found", { status: 404 });
      }

      const key = url.pathname.slice(bucketRootPath.length);

      if (request.method === "HEAD") {
        const object = store.get(key);
        if (!object) return new Response(null, { status: 404 });
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(object.bytes.byteLength) }
        });
      }

      if (request.method === "GET") {
        const object = store.get(key);
        if (!object) return new Response(null, { status: 404 });
        const arrayBuffer = object.bytes.buffer.slice(
          object.bytes.byteOffset,
          object.bytes.byteOffset + object.bytes.byteLength
        ) as ArrayBuffer;
        return new Response(arrayBuffer, { status: 200 });
      }

      if (request.method === "DELETE") {
        store.delete(key);
        deletedKeys.push(key);
        return new Response(null, { status: 204 });
      }

      return new Response("method not supported by fake server", {
        status: 405
      });
    }
  });

  return {
    server,
    put: (key, lastModified) =>
      store.set(key, {
        bytes,
        lastModified: lastModified ?? new Date().toISOString()
      }),
    has: (key) => store.has(key),
    deletedKeys
  };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function buildClient(port: number | undefined): NewsMediaR2Client {
  return createNewsMediaR2Client({
    accountId: CONFIG.accountId,
    accessKeyId: CONFIG.accessKeyId,
    secretAccessKey: CONFIG.secretAccessKey,
    bucket: CONFIG.bucket,
    endpoint: `http://127.0.0.1:${port}`
  });
}

const suite = integrationEnabled ? describe : describe.skip;

suite("news media R2 lifecycle cleanup & reconciliation (Issue #690)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenants();
    resetProviderCircuitBreakersForTests();
  });

  test("race condition: a brand-new pending row (within TTL) is never touched", async () => {
    const { server } = startFakeR2Server();
    const appSql = getTestSql();
    const workerSql = getWorkerTestSql();
    const r2Client = buildClient(server.port);

    try {
      const created = await withTenant(appSql, TENANT_A, (tx) =>
        createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
          mimeType: "image/jpeg"
        })
      );

      const result = await reconcileNewsMediaForTenant(
        workerSql,
        TENANT_A,
        CONFIG,
        r2Client,
        { dryRun: false }
      );

      expect(result.expiredPending.total).toBe(0);
      expect(result.expiredPending.deleted).toBe(0);

      const stillThere = await withTenant(appSql, TENANT_A, (tx) =>
        fetchNewsMediaObjectById(tx, TENANT_A, created.id)
      );
      expect(stillThere).not.toBeNull();
      expect(stillThere?.status).toBe("pending_upload");
    } finally {
      server.stop(true);
    }
  });

  test("race condition (critical): an orphan-in-R2 candidate is averted if a new DB row appears for the same key before the delete step", async () => {
    const { server, put, has } = startFakeR2Server();
    const workerSql = getWorkerTestSql();
    const objectKey = `news-media/${TENANT_A}/2020/01/11111111-1111-1111-1111-111111111111.jpg`;

    // The object already exists in R2, well past the grace period, with NO
    // matching DB row at the moment the reconciliation snapshot is taken —
    // a genuine orphan-in-R2 candidate, eligible for deletion.
    put(objectKey, isoDaysAgo(CONFIG.orphanGraceDays + 10));

    const realClient = buildClient(server.port);
    let racingRowInserted = false;

    // Wraps the real client so that its FIRST `listObjects` call (which
    // happens right after this run's DB snapshot has already been taken)
    // ALSO inserts a brand-new row for the SAME key — simulating "a client
    // legitimately created a new upload for this exact object key a moment
    // after the snapshot, before the delete step's own re-check runs".
    const racingClient: NewsMediaR2Client = {
      ...realClient,
      async listObjects(input) {
        if (!racingRowInserted) {
          racingRowInserted = true;
          await rawInsertVerifiedRowForKey(TENANT_A, objectKey);
        }
        return realClient.listObjects(input);
      }
    };

    try {
      const result = await reconcileNewsMediaForTenant(
        workerSql,
        TENANT_A,
        CONFIG,
        racingClient,
        { dryRun: false }
      );

      expect(result.orphanInR2.deleted).toBe(0);
      expect(result.orphanInR2.raceAverted).toBeGreaterThanOrEqual(1);
      // The object must still be physically present in R2 — never deleted.
      expect(has(objectKey)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("partial upload: a claimed-but-never-finalized ('uploaded') row past the TTL is cleaned up (R2 delete + DB hard delete)", async () => {
    const { server, has } = startFakeR2Server();
    const appSql = getTestSql();
    const workerSql = getWorkerTestSql();
    const r2Client = buildClient(server.port);

    try {
      const created = await withTenant(appSql, TENANT_A, (tx) =>
        createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
          mimeType: "image/jpeg"
        })
      );
      // Client claimed the row (finalize() started) but the object was
      // never actually written to R2 (fake bucket has nothing for this
      // key) — a genuine "partial upload".
      await withTenant(appSql, TENANT_A, (tx) =>
        markNewsMediaObjectUploaded(tx, TENANT_A, created.id)
      );
      await backdateCreatedAt(TENANT_A, created.id, "2 hours");

      const result = await reconcileNewsMediaForTenant(
        workerSql,
        TENANT_A,
        CONFIG,
        r2Client,
        { dryRun: false }
      );

      expect(result.expiredPending.total).toBe(1);
      expect(result.expiredPending.deleted).toBe(1);
      expect(has(created.objectKey)).toBe(false);

      const gone = await withTenant(appSql, TENANT_A, (tx) =>
        fetchNewsMediaObjectById(tx, TENANT_A, created.id, {
          includeDeleted: true
        })
      );
      expect(gone).toBeNull();

      const auditRows = (await withTenant(
        appSql,
        TENANT_A,
        (tx) =>
          tx`
          SELECT action FROM awcms_mini_audit_events
          WHERE tenant_id = ${TENANT_A} AND resource_id = ${created.id}
        `
      )) as { action: string }[];
      expect(
        auditRows.some(
          (row) => row.action === "news_media.object.pending_expired_purged"
        )
      ).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("missing object: a verified/attached row whose R2 object is gone is reported as orphan-in-DB — never mutated", async () => {
    const { server } = startFakeR2Server();
    const appSql = getTestSql();
    const workerSql = getWorkerTestSql();
    const r2Client = buildClient(server.port);

    try {
      const created = await withTenant(appSql, TENANT_A, (tx) =>
        createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
          mimeType: "image/jpeg"
        })
      );
      await withTenant(appSql, TENANT_A, (tx) =>
        markNewsMediaObjectUploaded(tx, TENANT_A, created.id)
      );
      await withTenant(appSql, TENANT_A, (tx) =>
        markNewsMediaObjectVerified(tx, TENANT_A, ACTOR_ID, created.id, {
          sizeBytes: 100,
          checksumSha256: "a".repeat(64)
        })
      );
      // Deliberately never `put()` this key into the fake R2 store — the
      // DB says `verified` (should physically exist), R2 disagrees.

      const result = await reconcileNewsMediaForTenant(
        workerSql,
        TENANT_A,
        CONFIG,
        r2Client,
        { dryRun: false }
      );

      expect(result.orphanInDb).toHaveLength(1);
      expect(result.orphanInDb[0]?.objectKey).toBe(created.objectKey);

      const unchanged = await withTenant(appSql, TENANT_A, (tx) =>
        fetchNewsMediaObjectById(tx, TENANT_A, created.id)
      );
      expect(unchanged?.status).toBe("verified");
      expect(unchanged?.deletedAt).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("stale orphaned: a status='orphaned' row past its grace period gets its R2 object deleted and the row soft-deleted", async () => {
    const { server, has } = startFakeR2Server();
    const appSql = getTestSql();
    const workerSql = getWorkerTestSql();
    const r2Client = buildClient(server.port);

    try {
      const created = await withTenant(appSql, TENANT_A, (tx) =>
        createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
          mimeType: "image/jpeg"
        })
      );
      await withTenant(appSql, TENANT_A, (tx) =>
        markNewsMediaObjectOrphaned(tx, TENANT_A, created.id)
      );
      await backdateOrphanedAt(TENANT_A, created.id, "31 days");

      const result = await reconcileNewsMediaForTenant(
        workerSql,
        TENANT_A,
        CONFIG,
        r2Client,
        { dryRun: false }
      );

      expect(result.staleOrphaned.total).toBe(1);
      expect(result.staleOrphaned.deleted).toBe(1);

      const softDeleted = await withTenant(appSql, TENANT_A, (tx) =>
        fetchNewsMediaObjectById(tx, TENANT_A, created.id, {
          includeDeleted: true
        })
      );
      expect(softDeleted).not.toBeNull();
      expect(softDeleted?.status).toBe("orphaned");
      expect(softDeleted?.deletedAt).not.toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("pagination: R2 listing spanning multiple pages is fully merged before categorization", async () => {
    const { server, put } = startFakeR2Server();
    const appSql = getTestSql();
    const workerSql = getWorkerTestSql();
    const r2Client = buildClient(server.port);

    try {
      const created: { id: string; objectKey: string }[] = [];
      for (let i = 0; i < 5; i += 1) {
        const row = await withTenant(appSql, TENANT_A, (tx) =>
          createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
            mimeType: "image/jpeg"
          })
        );
        await withTenant(appSql, TENANT_A, (tx) =>
          markNewsMediaObjectUploaded(tx, TENANT_A, row.id)
        );
        const verified = await withTenant(appSql, TENANT_A, (tx) =>
          markNewsMediaObjectVerified(tx, TENANT_A, ACTOR_ID, row.id, {
            sizeBytes: 10,
            checksumSha256: "b".repeat(64)
          })
        );
        put(verified!.objectKey);
        created.push({ id: row.id, objectKey: verified!.objectKey });
      }

      // Force pagination: 5 objects, 2 per page => 3 pages.
      const result = await reconcileNewsMediaForTenant(
        workerSql,
        TENANT_A,
        CONFIG,
        r2Client,
        { dryRun: true, pageSize: 2 }
      );

      expect(result.r2ListTruncated).toBe(false);
      expect(result.healthyCount).toBe(5);
      expect(result.orphanInDb).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("retry: a transient R2 listing failure is reported safely, then a subsequent run (retry) succeeds", async () => {
    const { server, put } = startFakeR2Server({
      failListForPrefix: `news-media/${TENANT_A}/`
    });
    const appSql = getTestSql();
    const workerSql = getWorkerTestSql();
    const r2Client = buildClient(server.port);

    try {
      const created = await withTenant(appSql, TENANT_A, (tx) =>
        createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
          mimeType: "image/jpeg"
        })
      );
      put(created.objectKey);

      const firstAttempt = await reconcileNewsMediaForTenant(
        workerSql,
        TENANT_A,
        CONFIG,
        r2Client,
        { dryRun: true }
      );

      expect(firstAttempt.r2ListFailed).toBe(true);
      expect(firstAttempt.r2ListError).toBeTruthy();

      server.stop(true);
    } catch (error) {
      server.stop(true);
      throw error;
    }

    // A fresh, healthy server simulates the NEXT scheduled run (this
    // runner does not retry in-process — see job-runner.ts's own header —
    // recovery happens on the next tick).
    const healthyServer = startFakeR2Server();
    healthyServer.put(`news-media/${TENANT_A}/2026/07/anything.jpg`);
    const retryClient = buildClient(healthyServer.server.port);

    try {
      const retryAttempt = await reconcileNewsMediaForTenant(
        workerSql,
        TENANT_A,
        CONFIG,
        retryClient,
        { dryRun: true }
      );

      expect(retryAttempt.r2ListFailed).toBe(false);
    } finally {
      healthyServer.server.stop(true);
    }
  });

  test("provider outage: one tenant's R2 listing failure never blocks another tenant's reconciliation or unrelated DB work", async () => {
    const { server, put } = startFakeR2Server({
      failListForPrefix: `news-media/${TENANT_A}/`
    });
    const appSql = getTestSql();
    const workerSql = getWorkerTestSql();
    const r2Client = buildClient(server.port);

    try {
      const rowA = await withTenant(appSql, TENANT_A, (tx) =>
        createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
          mimeType: "image/jpeg"
        })
      );
      const rowB = await withTenant(appSql, TENANT_B, (tx) =>
        createPendingNewsMediaObject(tx, TENANT_B, ACTOR_ID, CONFIG, {
          mimeType: "image/jpeg"
        })
      );
      await withTenant(appSql, TENANT_B, (tx) =>
        markNewsMediaObjectUploaded(tx, TENANT_B, rowB.id)
      );
      await withTenant(appSql, TENANT_B, (tx) =>
        markNewsMediaObjectVerified(tx, TENANT_B, ACTOR_ID, rowB.id, {
          sizeBytes: 10,
          checksumSha256: "c".repeat(64)
        })
      );
      put(rowB.objectKey);
      void rowA;

      const summary = await reconcileNewsMediaForAllTenants(
        workerSql,
        CONFIG,
        r2Client,
        { dryRun: true }
      );

      expect(summary.totals.tenantsChecked).toBe(2);
      expect(summary.totals.tenantsWithR2ListFailure).toBe(1);

      const tenantAResult = summary.tenantResults.find(
        (result) => result.tenantId === TENANT_A
      );
      const tenantBResult = summary.tenantResults.find(
        (result) => result.tenantId === TENANT_B
      );
      expect(tenantAResult?.r2ListFailed).toBe(true);
      expect(tenantBResult?.r2ListFailed).toBe(false);
      expect(tenantBResult?.healthyCount).toBe(1);

      // Unrelated DB work in the same process is completely unaffected —
      // no lingering lock/transaction from the failed tenant's attempt.
      const tenants = (await getAdminSql()`
        SELECT count(*)::int AS count FROM awcms_mini_tenants WHERE status = 'active'
      `) as { count: number }[];
      expect(tenants[0]?.count).toBeGreaterThanOrEqual(2);
    } finally {
      server.stop(true);
    }
  });

  test("dry-run performs zero mutations even when every category has eligible candidates", async () => {
    const { server, has, put } = startFakeR2Server();
    const appSql = getTestSql();
    const workerSql = getWorkerTestSql();
    const r2Client = buildClient(server.port);

    try {
      const pending = await withTenant(appSql, TENANT_A, (tx) =>
        createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
          mimeType: "image/jpeg"
        })
      );
      await backdateCreatedAt(TENANT_A, pending.id, "2 hours");

      const orphaned = await withTenant(appSql, TENANT_A, (tx) =>
        createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
          mimeType: "image/jpeg"
        })
      );
      await withTenant(appSql, TENANT_A, (tx) =>
        markNewsMediaObjectOrphaned(tx, TENANT_A, orphaned.id)
      );
      await backdateOrphanedAt(TENANT_A, orphaned.id, "31 days");

      const untrackedKey = `news-media/${TENANT_A}/2020/01/22222222-2222-2222-2222-222222222222.jpg`;
      put(untrackedKey, isoDaysAgo(CONFIG.orphanGraceDays + 10));

      const result = await reconcileNewsMediaForTenant(
        workerSql,
        TENANT_A,
        CONFIG,
        r2Client,
        { dryRun: true }
      );

      expect(result.expiredPending.total).toBe(1);
      expect(result.staleOrphaned.total).toBe(1);
      expect(result.orphanInR2.eligible).toBe(1);

      // Nothing was actually mutated/deleted.
      expect(has(untrackedKey)).toBe(true);
      const pendingRow = await withTenant(appSql, TENANT_A, (tx) =>
        fetchNewsMediaObjectById(tx, TENANT_A, pending.id)
      );
      expect(pendingRow?.status).toBe("pending_upload");
      const orphanedRow = await withTenant(appSql, TENANT_A, (tx) =>
        fetchNewsMediaObjectById(tx, TENANT_A, orphaned.id)
      );
      expect(orphanedRow?.deletedAt).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("idempotent reruns: a second run after a real cleanup run performs zero further mutations", async () => {
    const { server, has } = startFakeR2Server();
    const appSql = getTestSql();
    const workerSql = getWorkerTestSql();
    const r2Client = buildClient(server.port);

    try {
      const pending = await withTenant(appSql, TENANT_A, (tx) =>
        createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
          mimeType: "image/jpeg"
        })
      );
      await backdateCreatedAt(TENANT_A, pending.id, "2 hours");

      const first = await reconcileNewsMediaForTenant(
        workerSql,
        TENANT_A,
        CONFIG,
        r2Client,
        { dryRun: false }
      );
      expect(first.expiredPending.deleted).toBe(1);
      expect(has(pending.objectKey)).toBe(false);

      const second = await reconcileNewsMediaForTenant(
        workerSql,
        TENANT_A,
        CONFIG,
        r2Client,
        { dryRun: false }
      );

      expect(second.expiredPending.total).toBe(0);
      expect(second.expiredPending.deleted).toBe(0);
      expect(second.staleOrphaned.total).toBe(0);
      expect(second.orphanInR2.deleted).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
