/**
 * Integration test for `checkNewsMediaR2NoStalePendingObjects` (Issue #635,
 * epic `news_portal`).
 *
 * The check counts `awcms_mini_news_media_objects` rows stuck in
 * `pending_upload` past `NEWS_MEDIA_R2_PENDING_TTL_MINUTES` ACROSS ALL
 * TENANTS — that cross-tenant aggregation cannot be exercised by a unit
 * test against a fake/mocked `Bun.SQL` without either bypassing RLS (which
 * would stop testing the real per-tenant `SET LOCAL app.current_tenant_id`
 * scan this check actually performs) or faking so much of `Bun.SQL` that
 * the query itself is no longer under test. It needs a real Postgres round
 * trip — same rationale `security-readiness-break-glass.integration.test.ts`
 * documents for `checkSsoBreakGlassReady`.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

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
import { createPendingNewsMediaObject } from "../../src/modules/news-portal/application/news-media-object-directory";
import { checkNewsMediaR2NoStalePendingObjects } from "../../scripts/security-readiness";

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
  pendingTtlMinutes: 60
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

async function ageObject(objectId: string, minutesAgo: number): Promise<void> {
  const admin = getAdminSql();
  await admin`
    UPDATE awcms_mini_news_media_objects
    SET created_at = now() - (${minutesAgo} || ' minutes')::interval
    WHERE id = ${objectId}
  `;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("checkNewsMediaR2NoStalePendingObjects (Issue #635)", () => {
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  afterAll(() => {
    process.env = previousEnv;
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenants();
    process.env.NEWS_MEDIA_R2_ENABLED = "true";
    process.env.NEWS_MEDIA_R2_PENDING_TTL_MINUTES = "60";
  });

  test('passes when NEWS_MEDIA_R2_ENABLED is not "true" (no registry in use)', async () => {
    process.env.NEWS_MEDIA_R2_ENABLED = "false";

    const result = await checkNewsMediaR2NoStalePendingObjects();

    expect(result.status).toBe("pass");
    expect(result.severity).toBe("warning");
  });

  test("passes when no tenant has any pending_upload object at all", async () => {
    const result = await checkNewsMediaR2NoStalePendingObjects();

    expect(result.status).toBe("pass");
  });

  test("passes when a pending_upload object exists but is still within the TTL", async () => {
    const sql = getDatabaseClient();
    await withTenant(sql, TENANT_A, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
        mimeType: "image/jpeg"
      })
    );

    const result = await checkNewsMediaR2NoStalePendingObjects();

    expect(result.status).toBe("pass");
  });

  test("fails when a pending_upload object is older than the TTL — the missing r2-backup-lifecycle.md §2 cleanup job has not run", async () => {
    const sql = getDatabaseClient();
    const created = await withTenant(sql, TENANT_A, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
        mimeType: "image/jpeg"
      })
    );
    await ageObject(created.id, 61);

    const result = await checkNewsMediaR2NoStalePendingObjects();

    expect(result.status).toBe("fail");
    expect(result.severity).toBe("warning");
    expect(result.evidence).toContain("1 object(s)");
  });

  test("aggregates stale objects across multiple tenants (cross-tenant scan, not just the first tenant)", async () => {
    const sql = getDatabaseClient();
    const createdA = await withTenant(sql, TENANT_A, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
        mimeType: "image/jpeg"
      })
    );
    const createdB = await withTenant(sql, TENANT_B, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_B, ACTOR_ID, CONFIG, {
        mimeType: "image/png"
      })
    );
    await ageObject(createdA.id, 61);
    await ageObject(createdB.id, 90);

    const result = await checkNewsMediaR2NoStalePendingObjects();

    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("2 object(s)");
  });

  test("does not flag a stale object that already moved past pending_upload (e.g. verified)", async () => {
    const sql = getDatabaseClient();
    const created = await withTenant(sql, TENANT_A, (tx) =>
      createPendingNewsMediaObject(tx, TENANT_A, ACTOR_ID, CONFIG, {
        mimeType: "image/jpeg"
      })
    );
    await ageObject(created.id, 120);

    const admin = getAdminSql();
    await admin`
      UPDATE awcms_mini_news_media_objects
      SET status = 'uploaded'
      WHERE id = ${created.id}
    `;

    const result = await checkNewsMediaR2NoStalePendingObjects();

    expect(result.status).toBe("pass");
  });
});
