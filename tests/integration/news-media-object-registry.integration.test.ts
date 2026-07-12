/**
 * Integration tests for the R2-only news media object registry (Issue #633,
 * epic `news_portal`) against a real PostgreSQL: schema/RLS/constraint
 * enforcement (migration 041) plus the directory/application helpers
 * (`news-media-object-directory.ts`) that create/verify/attach/detach/
 * delete/restore/purge rows and their audit trail.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";
import type { NewsMediaR2Config } from "../../src/modules/news-portal/domain/news-media-r2-config";
import {
  attachNewsMediaObject,
  createPendingNewsMediaObject,
  detachNewsMediaObject,
  fetchNewsMediaObjectById,
  markNewsMediaObjectFailed,
  markNewsMediaObjectOrphaned,
  markNewsMediaObjectUploaded,
  markNewsMediaObjectVerified,
  purgeNewsMediaObject,
  restoreNewsMediaObject,
  revertNewsMediaObjectUploadClaim,
  softDeleteNewsMediaObject,
  UnsupportedNewsMediaMimeTypeInputError
} from "../../src/modules/news-portal/application/news-media-object-directory";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ACTOR_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const CONFIG: NewsMediaR2Config = {
  enabled: true,
  accountId: "acct",
  accessKeyId: "news-key",
  secretAccessKey: "news-secret",
  bucket: "news-media-bucket",
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
      (${TENANT_A}, 'tenant-a', 'Tenant A', 'Tenant A Legal', 'active', 'en', 'light'),
      (${TENANT_B}, 'tenant-b', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
  `;
}

async function fetchAuditRows(
  tenantId: string
): Promise<{ action: string; severity: string }[]> {
  const admin = getAdminSql();
  return (await admin`
    SELECT action, severity FROM awcms_mini_audit_events
    WHERE tenant_id = ${tenantId} AND module_key = 'news_portal'
    ORDER BY created_at ASC
  `) as { action: string; severity: string }[];
}

const suite = integrationEnabled ? describe : describe.skip;

suite("news media object registry — schema, RLS, constraints", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenants();
  });

  test("tenant A cannot see tenant B's media objects (RLS isolation)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_news_media_objects
        (tenant_id, bucket_name, object_key, public_url, mime_type, created_by_tenant_user_id)
      VALUES
        (${TENANT_A}, 'bucket',
         'news-media/' || ${TENANT_A} || '/2026/03/11111111-1111-1111-1111-111111111111.jpg',
         'https://media.example.test/a.jpg', 'image/jpeg', ${ACTOR_ID}),
        (${TENANT_B}, 'bucket',
         'news-media/' || ${TENANT_B} || '/2026/03/22222222-2222-2222-2222-222222222222.jpg',
         'https://media.example.test/b.jpg', 'image/jpeg', ${ACTOR_ID})
    `;

    const sql = getDatabaseClient();
    const rowsForA = await withTenant(
      sql,
      TENANT_A,
      (tx) => tx`SELECT object_key FROM awcms_mini_news_media_objects`
    );
    expect(rowsForA).toHaveLength(1);
    expect((rowsForA as { object_key: string }[])[0]?.object_key).toContain(
      TENANT_A
    );
  });

  test("querying without a tenant GUC set returns no rows (fail-closed)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_news_media_objects
        (tenant_id, bucket_name, object_key, public_url, mime_type, created_by_tenant_user_id)
      VALUES (${TENANT_A}, 'bucket',
         'news-media/' || ${TENANT_A} || '/2026/03/11111111-1111-1111-1111-111111111111.jpg',
         'https://media.example.test/a.jpg', 'image/jpeg', ${ACTOR_ID})
    `;

    const sql = getDatabaseClient();
    const rows =
      await sql`SELECT object_key FROM awcms_mini_news_media_objects`;
    expect(rows).toHaveLength(0);
  });

  test("rejects a non-cloudflare_r2 storage_driver", async () => {
    const admin = getAdminSql();
    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_news_media_objects
          (tenant_id, storage_driver, bucket_name, object_key, public_url, mime_type, created_by_tenant_user_id)
        VALUES (${TENANT_A}, 'aws_s3', 'bucket',
          'news-media/' || ${TENANT_A} || '/2026/03/11111111-1111-1111-1111-111111111111.jpg',
          'https://media.example.test/a.jpg', 'image/jpeg', ${ACTOR_ID})
      `;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });

  test("rejects an object key that doesn't match the tenant-prefixed §6 format", async () => {
    const admin = getAdminSql();
    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_news_media_objects
          (tenant_id, bucket_name, object_key, public_url, mime_type, created_by_tenant_user_id)
        VALUES (${TENANT_A}, 'bucket', '/uploads/photo.jpg',
          'https://media.example.test/a.jpg', 'image/jpeg', ${ACTOR_ID})
      `;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });

  test("rejects a missing bucket_name", async () => {
    const admin = getAdminSql();
    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_news_media_objects
          (tenant_id, object_key, public_url, mime_type, created_by_tenant_user_id)
        VALUES (${TENANT_A},
          'news-media/' || ${TENANT_A} || '/2026/03/11111111-1111-1111-1111-111111111111.jpg',
          'https://media.example.test/a.jpg', 'image/jpeg', ${ACTOR_ID})
      `;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });

  test("rejects an unknown status", async () => {
    const admin = getAdminSql();
    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_news_media_objects
          (tenant_id, bucket_name, object_key, public_url, mime_type, created_by_tenant_user_id, status)
        VALUES (${TENANT_A}, 'bucket',
          'news-media/' || ${TENANT_A} || '/2026/03/11111111-1111-1111-1111-111111111111.jpg',
          'https://media.example.test/a.jpg', 'image/jpeg', ${ACTOR_ID}, 'bogus')
      `;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });

  test("rejects status='attached' without owner_resource_type/id", async () => {
    const admin = getAdminSql();
    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_news_media_objects
          (tenant_id, bucket_name, object_key, public_url, mime_type, created_by_tenant_user_id, status)
        VALUES (${TENANT_A}, 'bucket',
          'news-media/' || ${TENANT_A} || '/2026/03/11111111-1111-1111-1111-111111111111.jpg',
          'https://media.example.test/a.jpg', 'image/jpeg', ${ACTOR_ID}, 'attached')
      `;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });
});

suite("news media object directory — lifecycle + audit trail", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenants();
  });

  test("createPendingNewsMediaObject rejects a mime type outside the configured allow-list", async () => {
    const sql = getDatabaseClient();

    await expect(
      withTenant(sql, TENANT_A, (tx) =>
        createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
          mimeType: "image/svg+xml"
        })
      )
    ).rejects.toBeInstanceOf(UnsupportedNewsMediaMimeTypeInputError);
  });

  test("full lifecycle: create -> uploaded -> verified -> attached -> detached -> deleted -> restored -> purged, with the required audit trail", async () => {
    const sql = getDatabaseClient();

    const created = await withTenant(sql, TENANT_A, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
        mimeType: "image/jpeg",
        originalFilename: "photo-lapangan.jpg",
        altText: "A field photo"
      })
    );
    expect(created.status).toBe("pending_upload");
    expect(created.objectKey).toContain(`news-media/${TENANT_A}/`);
    expect(created.objectKey).not.toContain("photo-lapangan");
    expect(created.publicUrl).toBe(
      `https://media.example.test/${created.objectKey}`
    );
    expect(created.bucketName).toBe(CONFIG.bucket);
    expect(created.storageDriver).toBe("cloudflare_r2");

    const uploaded = await withTenant(sql, TENANT_A, (tx) =>
      markNewsMediaObjectUploaded(tx, TENANT_A, created.id, {
        sizeBytes: 12_345,
        checksumSha256: "a".repeat(64)
      })
    );
    expect(uploaded?.status).toBe("uploaded");
    expect(uploaded?.sizeBytes).toBe(12_345);

    const verified = await withTenant(sql, TENANT_A, (tx) =>
      markNewsMediaObjectVerified(tx, TENANT_A, ACTOR_ID, created.id, {
        width: 800,
        height: 600
      })
    );
    expect(verified?.status).toBe("verified");
    expect(verified?.width).toBe(800);

    const attached = await withTenant(sql, TENANT_A, (tx) =>
      attachNewsMediaObject(tx, TENANT_A, ACTOR_ID, created.id, {
        ownerResourceType: "blog_post",
        ownerResourceId: "dddddddd-dddd-dddd-dddd-dddddddddddd"
      })
    );
    expect(attached?.status).toBe("attached");
    expect(attached?.ownerResourceType).toBe("blog_post");

    const detached = await withTenant(sql, TENANT_A, (tx) =>
      detachNewsMediaObject(tx, TENANT_A, ACTOR_ID, created.id)
    );
    expect(detached?.status).toBe("verified");
    expect(detached?.ownerResourceType).toBeNull();
    expect(detached?.ownerResourceId).toBeNull();

    const deletedOk = await withTenant(sql, TENANT_A, (tx) =>
      softDeleteNewsMediaObject(
        tx,
        TENANT_A,
        ACTOR_ID,
        created.id,
        "no longer needed"
      )
    );
    expect(deletedOk).toBe(true);

    // Default read hides soft-deleted rows (fail-closed convention, same
    // as blog-content's fetchBlogPostById).
    const hiddenAfterDelete = await withTenant(sql, TENANT_A, (tx) =>
      fetchNewsMediaObjectById(tx, TENANT_A, created.id)
    );
    expect(hiddenAfterDelete).toBeNull();

    const afterDelete = await withTenant(sql, TENANT_A, (tx) =>
      fetchNewsMediaObjectById(tx, TENANT_A, created.id, {
        includeDeleted: true
      })
    );
    expect(afterDelete?.deletedAt).not.toBeNull();
    // status is untouched by soft delete (orthogonal, same as blog_posts).
    expect(afterDelete?.status).toBe("verified");

    const restored = await withTenant(sql, TENANT_A, (tx) =>
      restoreNewsMediaObject(tx, TENANT_A, ACTOR_ID, created.id)
    );
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.status).toBe("verified");

    // Purge requires soft-deleted first.
    const purgeBeforeDelete = await withTenant(sql, TENANT_A, (tx) =>
      purgeNewsMediaObject(tx, TENANT_A, ACTOR_ID, created.id)
    );
    expect(purgeBeforeDelete).toBe(false);

    await withTenant(sql, TENANT_A, (tx) =>
      softDeleteNewsMediaObject(tx, TENANT_A, ACTOR_ID, created.id, "cleanup")
    );
    const purged = await withTenant(sql, TENANT_A, (tx) =>
      purgeNewsMediaObject(tx, TENANT_A, ACTOR_ID, created.id)
    );
    expect(purged).toBe(true);

    const gone = await withTenant(sql, TENANT_A, (tx) =>
      fetchNewsMediaObjectById(tx, TENANT_A, created.id)
    );
    expect(gone).toBeNull();

    const auditActions = (await fetchAuditRows(TENANT_A)).map((r) => r.action);
    expect(auditActions).toEqual([
      "news_media.object.created",
      "news_media.object.verified",
      "news_media.object.attached",
      "news_media.object.detached",
      "news_media.object.deleted",
      "news_media.object.restored",
      "news_media.object.deleted",
      "news_media.object.purged"
    ]);
  });

  test("attach requires status='verified' — rejects attaching straight from pending_upload", async () => {
    const sql = getDatabaseClient();
    const created = await withTenant(sql, TENANT_A, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
        mimeType: "image/png"
      })
    );

    const attached = await withTenant(sql, TENANT_A, (tx) =>
      attachNewsMediaObject(tx, TENANT_A, ACTOR_ID, created.id, {
        ownerResourceType: "blog_post",
        ownerResourceId: "dddddddd-dddd-dddd-dddd-dddddddddddd"
      })
    );
    expect(attached).toBeNull();

    const auditActions = (await fetchAuditRows(TENANT_A)).map((r) => r.action);
    expect(auditActions).toEqual(["news_media.object.created"]);
  });

  test("markNewsMediaObjectOrphaned and markNewsMediaObjectFailed transition without emitting an audit event", async () => {
    const sql = getDatabaseClient();
    const created = await withTenant(sql, TENANT_A, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
        mimeType: "image/gif"
      })
    );

    const orphaned = await withTenant(sql, TENANT_A, (tx) =>
      markNewsMediaObjectOrphaned(tx, TENANT_A, created.id)
    );
    expect(orphaned?.status).toBe("orphaned");

    const second = await withTenant(sql, TENANT_A, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
        mimeType: "image/gif"
      })
    );
    const failed = await withTenant(sql, TENANT_A, (tx) =>
      markNewsMediaObjectFailed(tx, TENANT_A, second.id)
    );
    expect(failed?.status).toBe("failed");

    const auditActions = (await fetchAuditRows(TENANT_A)).map((r) => r.action);
    expect(auditActions).toEqual([
      "news_media.object.created",
      "news_media.object.created"
    ]);
  });

  test("markNewsMediaObjectUploaded with no input claims the row atomically (WHERE status='pending_upload' guard) — a second claim attempt on the same row gets null, no audit event", async () => {
    const sql = getDatabaseClient();
    const created = await withTenant(sql, TENANT_A, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
        mimeType: "image/jpeg"
      })
    );

    const firstClaim = await withTenant(sql, TENANT_A, (tx) =>
      markNewsMediaObjectUploaded(tx, TENANT_A, created.id)
    );
    expect(firstClaim?.status).toBe("uploaded");
    // No sizeBytes/checksumSha256 given at claim time — COALESCE leaves the
    // columns untouched (NULL for a fresh row), per PR #653.
    expect(firstClaim?.sizeBytes).toBeNull();
    expect(firstClaim?.checksumSha256).toBeNull();

    // Simulates a second concurrent `finalize` call's claim attempt losing
    // the race — the row is no longer `pending_upload`, so this matches
    // zero rows.
    const secondClaim = await withTenant(sql, TENANT_A, (tx) =>
      markNewsMediaObjectUploaded(tx, TENANT_A, created.id)
    );
    expect(secondClaim).toBeNull();

    const auditActions = (await fetchAuditRows(TENANT_A)).map((r) => r.action);
    expect(auditActions).toEqual(["news_media.object.created"]);
  });

  test("revertNewsMediaObjectUploadClaim: uploaded -> pending_upload, retryable via a fresh claim afterwards, no audit event", async () => {
    const sql = getDatabaseClient();
    const created = await withTenant(sql, TENANT_A, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
        mimeType: "image/jpeg"
      })
    );

    await withTenant(sql, TENANT_A, (tx) =>
      markNewsMediaObjectUploaded(tx, TENANT_A, created.id)
    );

    const reverted = await withTenant(sql, TENANT_A, (tx) =>
      revertNewsMediaObjectUploadClaim(tx, TENANT_A, created.id)
    );
    expect(reverted?.status).toBe("pending_upload");

    // The whole point of reverting — the session is retryable via a fresh
    // claim, not permanently stuck.
    const reclaimed = await withTenant(sql, TENANT_A, (tx) =>
      markNewsMediaObjectUploaded(tx, TENANT_A, created.id)
    );
    expect(reclaimed?.status).toBe("uploaded");

    const auditActions = (await fetchAuditRows(TENANT_A)).map((r) => r.action);
    expect(auditActions).toEqual(["news_media.object.created"]);
  });

  test("revertNewsMediaObjectUploadClaim is a no-op (returns null) for a row not currently in 'uploaded' status", async () => {
    const sql = getDatabaseClient();
    const created = await withTenant(sql, TENANT_A, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
        mimeType: "image/jpeg"
      })
    );

    // Still `pending_upload` — never claimed.
    const revertedPending = await withTenant(sql, TENANT_A, (tx) =>
      revertNewsMediaObjectUploadClaim(tx, TENANT_A, created.id)
    );
    expect(revertedPending).toBeNull();

    await withTenant(sql, TENANT_A, (tx) =>
      markNewsMediaObjectUploaded(tx, TENANT_A, created.id)
    );
    await withTenant(sql, TENANT_A, (tx) =>
      markNewsMediaObjectVerified(tx, TENANT_A, ACTOR_ID, created.id, {})
    );

    // Already resolved to `verified` — reverting must not undo that.
    const revertedVerified = await withTenant(sql, TENANT_A, (tx) =>
      revertNewsMediaObjectUploadClaim(tx, TENANT_A, created.id)
    );
    expect(revertedVerified).toBeNull();

    const row = await withTenant(sql, TENANT_A, (tx) =>
      fetchNewsMediaObjectById(tx, TENANT_A, created.id)
    );
    expect(row?.status).toBe("verified");
  });

  test("a tenant A media object is invisible to tenant B's directory calls (cross-tenant rejection)", async () => {
    const sql = getDatabaseClient();
    const created = await withTenant(sql, TENANT_A, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
        mimeType: "image/jpeg"
      })
    );

    const fromTenantB = await withTenant(sql, TENANT_B, (tx) =>
      fetchNewsMediaObjectById(tx, TENANT_B, created.id)
    );
    expect(fromTenantB).toBeNull();

    const verifiedFromTenantB = await withTenant(sql, TENANT_B, (tx) =>
      markNewsMediaObjectVerified(tx, TENANT_B, ACTOR_ID, created.id)
    );
    expect(verifiedFromTenantB).toBeNull();
  });
});
