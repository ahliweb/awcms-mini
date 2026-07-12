/**
 * Integration tests for Issue #640 (epic `news_portal`): content quality
 * checklist gating `POST /api/v1/blog/posts/{id}/publish`,
 * `POST /api/v1/blog/posts/{id}/schedule`, the scheduled-publish worker
 * (`publishDueScheduledPosts`), and the read-only preview endpoints
 * (`GET .../quality-checklist` for posts and pages). Same
 * `activateFullOnlineR2Mode`/`seedNewsMediaObject` pattern as
 * `blog-content-news-media-r2-references.integration.test.ts` (Issue #636)
 * — the checklist is a no-op unless full-online R2-only mode is active for
 * the tenant, so every blocking scenario below activates it first.
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
  createCookieJar,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as createPost } from "../../src/pages/api/v1/blog/posts/index";
import { POST as publishPost } from "../../src/pages/api/v1/blog/posts/[id]/publish";
import { POST as schedulePost } from "../../src/pages/api/v1/blog/posts/[id]/schedule";
import { GET as getPostQualityChecklist } from "../../src/pages/api/v1/blog/posts/[id]/quality-checklist";
import { GET as getPageQualityChecklist } from "../../src/pages/api/v1/blog/pages/[id]/quality-checklist";
import { POST as createPage } from "../../src/pages/api/v1/blog/pages/index";
import { PATCH as updateBlogSettings } from "../../src/pages/api/v1/blog/settings/index";
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";
import { applyNewsPortalFullOnlineR2Preset } from "../../src/modules/news-portal/application/apply-news-portal-preset";
import type { NewsMediaR2Config } from "../../src/modules/news-portal/domain/news-media-r2-config";
import {
  createPendingNewsMediaObject,
  markNewsMediaObjectUploaded,
  markNewsMediaObjectVerified,
  type NewsMediaObjectView
} from "../../src/modules/news-portal/application/news-media-object-directory";
import { publishDueScheduledPosts } from "../../src/modules/blog-content/application/blog-scheduled-publish";
import { newsMediaPortAdapter } from "../../src/modules/news-portal/application/news-media-port-adapter";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

const FULLY_CONFIGURED_ENV = {
  NEWS_PORTAL_ENABLED: "true",
  NEWS_PORTAL_PROFILE: "full_online_r2",
  NEWS_MEDIA_R2_ENABLED: "true",
  NEWS_MEDIA_R2_ACCOUNT_ID: "acct",
  NEWS_MEDIA_R2_ACCESS_KEY_ID: "news-key",
  NEWS_MEDIA_R2_SECRET_ACCESS_KEY: "news-secret",
  NEWS_MEDIA_R2_BUCKET: "news-media-bucket",
  NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://media.example.test"
} as NodeJS.ProcessEnv;

const MEDIA_CONFIG: NewsMediaR2Config = {
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

type Bootstrap = { tenantId: string; token: string; tenantUserId: string };

async function bootstrap(
  tenantCode = "acme",
  tenantName = "Acme"
): Promise<Bootstrap> {
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName,
      tenantCode,
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: loginIdentifier,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  expect(setup.status).toBe(200);

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": setup.body.data.tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  const admin = getAdminSql();
  const tenantUserRows = (await admin`
    SELECT tu.id FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${setup.body.data.tenantId} AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id
  };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

/** Same helper as Issue #636's own suite — see that file's header comment. */
async function activateFullOnlineR2Mode(owner: Bootstrap): Promise<void> {
  Object.assign(process.env, FULLY_CONFIGURED_ENV);

  const sql = getDatabaseClient();
  const result = await withTenant(sql, owner.tenantId, (tx) =>
    applyNewsPortalFullOnlineR2Preset(
      tx,
      owner.tenantId,
      owner.tenantUserId,
      FULLY_CONFIGURED_ENV
    )
  );
  expect(result.outcome).toBe("applied");
}

async function seedVerifiedMediaObject(
  tenantId: string,
  actorTenantUserId: string,
  overrides: {
    altText?: string | null;
    width?: number;
    height?: number;
  } = {}
): Promise<NewsMediaObjectView> {
  const sql = getDatabaseClient();

  return withTenant(sql, tenantId, async (tx) => {
    const created = await createPendingNewsMediaObject(
      tx,
      tenantId,
      actorTenantUserId,
      MEDIA_CONFIG,
      { mimeType: "image/jpeg", altText: overrides.altText ?? undefined }
    );

    await markNewsMediaObjectUploaded(tx, tenantId, created.id, {
      sizeBytes: 12_345,
      checksumSha256: "a".repeat(64)
    });

    return (await markNewsMediaObjectVerified(
      tx,
      tenantId,
      actorTenantUserId,
      created.id,
      { width: overrides.width, height: overrides.height }
    ))!;
  });
}

function validCreatePostBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "Hello",
    slug: `hello-${Math.random().toString(36).slice(2, 8)}`,
    excerpt: "An excerpt",
    contentJson: { blocks: [{ type: "paragraph", text: "Body" }] },
    contentText: "Body",
    metaDescription: "A meta description",
    locale: "en",
    ...overrides
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("content quality checklist (Issue #640)", () => {
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
    process.env = { ...previousEnv };
  });

  test("R2-only mode NOT active: publish succeeds unchanged, qualityChecklist reports applicable: false", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody()
    });

    const response = await invoke<{
      data: { qualityChecklist: { applicable: boolean; passed: boolean } };
    }>(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${created.body.data.id}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-1" },
      params: { id: created.body.data.id }
    });

    expect(response.status).toBe(200);
    expect(response.body.data.qualityChecklist.applicable).toBe(false);
    expect(response.body.data.qualityChecklist.passed).toBe(true);
  });

  test("R2-only mode active: publish is blocked (422) when featuredMediaId is not a verified R2 object, and an audit event is recorded", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody()
    });
    const postId = created.body.data.id;

    // Directly set featuredMediaId to an arbitrary (never-registered) UUID
    // via raw SQL — the create/update route's own gate (Issue #636) would
    // already reject this at write time, so this simulates the residual
    // gap this issue's checklist closes (e.g. a media object later
    // purged/unverified after the post was last saved).
    await getAdminSql()`
      UPDATE awcms_mini_blog_posts
      SET featured_media_id = '99999999-9999-9999-9999-999999999999'
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `;

    const response = await invoke<{
      error: { code: string; details: { field: string; message: string }[] };
    }>(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-2" },
      params: { id: postId }
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("CONTENT_QUALITY_CHECKLIST_BLOCKED");
    expect(
      response.body.error.details.some(
        (d) => d.field === "featured_image_verified_r2"
      )
    ).toBe(true);

    const rows = (await getAdminSql()`
      SELECT status FROM awcms_mini_blog_posts
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `) as { status: string }[];
    expect(rows[0]?.status).toBe("draft");

    const auditRows = (await getAdminSql()`
      SELECT count(*)::int AS count FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND resource_id = ${postId}
        AND action = 'blog.post.publish_blocked_by_checklist'
    `) as { count: number }[];
    expect(auditRows[0]?.count).toBe(1);
  });

  test("R2-only mode active: publish succeeds with a verified featured image, missing alt text is only a warning", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);
    const media = await seedVerifiedMediaObject(
      owner.tenantId,
      owner.tenantUserId,
      { altText: null }
    );

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({ featuredMediaId: media.id })
    });
    const postId = created.body.data.id;

    const response = await invoke<{
      data: {
        qualityChecklist: {
          passed: boolean;
          warnings: { ruleId: string }[];
        };
      };
    }>(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-3" },
      params: { id: postId }
    });

    expect(response.status).toBe(200);
    expect(response.body.data.qualityChecklist.passed).toBe(true);
    expect(
      response.body.data.qualityChecklist.warnings.some(
        (w) => w.ruleId === "featured_image_alt_text"
      )
    ).toBe(true);
  });

  test("tenant policy override escalates featured_image_alt_text to blocking", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const settingsResponse = await invoke(updateBlogSettings, {
      method: "PATCH",
      path: "/api/v1/blog/settings",
      headers: authHeaders(owner),
      body: {
        contentQualityChecklistPolicy: { featured_image_alt_text: "blocking" }
      }
    });
    expect(settingsResponse.status).toBe(200);

    const media = await seedVerifiedMediaObject(
      owner.tenantId,
      owner.tenantUserId,
      { altText: null }
    );

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({ featuredMediaId: media.id })
    });
    const postId = created.body.data.id;

    const response = await invoke<{ error: { code: string } }>(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-4" },
      params: { id: postId }
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("CONTENT_QUALITY_CHECKLIST_BLOCKED");
  });

  test("tenant policy CANNOT override a security rule id — PATCH /api/v1/blog/settings rejects it with 400", async () => {
    const owner = await bootstrap();

    const response = await invoke(updateBlogSettings, {
      method: "PATCH",
      path: "/api/v1/blog/settings",
      headers: authHeaders(owner),
      body: {
        contentQualityChecklistPolicy: { unsafe_html_rejected: "info" }
      }
    });

    expect(response.status).toBe(400);
  });

  test("R2-only mode active: publish is blocked when a gallery item uses a local image path", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody()
    });
    const postId = created.body.data.id;

    // Same rationale as the featuredMediaId test above — bypass the
    // create/update route's own write-time gate via raw SQL to simulate a
    // pre-existing row (e.g. from before R2-only mode was activated).
    await getAdminSql()`
      UPDATE awcms_mini_blog_posts
      SET content_json = ${{
        blocks: [
          {
            type: "gallery",
            items: [{ mediaType: "image", url: "/uploads/local-photo.jpg" }]
          }
        ]
      }}
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `;

    const response = await invoke<{
      error: { details: { field: string }[] };
    }>(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-5" },
      params: { id: postId }
    });

    expect(response.status).toBe(422);
    expect(
      response.body.error.details.some((d) => d.field === "no_local_image_path")
    ).toBe(true);
  });

  test("R2-only mode active: publish is blocked when a gallery item uses an arbitrary external URL", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody()
    });
    const postId = created.body.data.id;

    await getAdminSql()`
      UPDATE awcms_mini_blog_posts
      SET content_json = ${{
        blocks: [
          {
            type: "gallery",
            items: [
              { mediaType: "image", url: "https://example.com/photo.jpg" }
            ]
          }
        ]
      }}
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `;

    const response = await invoke<{
      error: { details: { field: string }[] };
    }>(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-6" },
      params: { id: postId }
    });

    expect(response.status).toBe(422);
    expect(
      response.body.error.details.some(
        (d) => d.field === "no_external_image_url"
      )
    ).toBe(true);
  });

  test("R2-only mode active: publish is blocked when contentText contains unsafe HTML (simulated pre-existing row)", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody()
    });
    const postId = created.body.data.id;

    await getAdminSql()`
      UPDATE awcms_mini_blog_posts
      SET content_text = '<script>alert(1)</script>'
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `;

    const response = await invoke<{
      error: { details: { field: string }[] };
    }>(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-7" },
      params: { id: postId }
    });

    expect(response.status).toBe(422);
    expect(
      response.body.error.details.some(
        (d) => d.field === "unsafe_html_rejected"
      )
    ).toBe(true);
  });

  test("R2-only mode active: schedule is blocked by the same checklist and leaves the post in draft", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody()
    });
    const postId = created.body.data.id;

    await getAdminSql()`
      UPDATE awcms_mini_blog_posts
      SET featured_media_id = '99999999-9999-9999-9999-999999999999'
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `;

    const future = new Date(Date.now() + 60 * 60 * 1000);
    const response = await invoke<{ error: { code: string } }>(schedulePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/schedule`,
      headers: { ...authHeaders(owner), "idempotency-key": "sched-1" },
      params: { id: postId },
      body: { scheduledAt: future.toISOString() }
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("CONTENT_QUALITY_CHECKLIST_BLOCKED");

    const rows = (await getAdminSql()`
      SELECT status FROM awcms_mini_blog_posts
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `) as { status: string }[];
    expect(rows[0]?.status).toBe("draft");
  });

  test("scheduled-publish worker blocks a due post that fails the checklist, leaves it scheduled, and audits it", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody()
    });
    const postId = created.body.data.id;

    // Seed a due, scheduled post directly (bypassing the schedule endpoint,
    // which would itself now block this — same "raw SQL fixture setup"
    // convention `blog-content-scheduled-publish.integration.test.ts` uses),
    // with a featuredMediaId that fails checklist verification.
    const past = new Date(Date.now() - 60 * 1000);
    await getAdminSql()`
      UPDATE awcms_mini_blog_posts
      SET status = 'scheduled', scheduled_at = ${past},
          featured_media_id = '99999999-9999-9999-9999-999999999999'
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `;

    const result = await publishDueScheduledPosts(
      getDatabaseClient(),
      owner.tenantId,
      newsMediaPortAdapter
    );

    expect(result.publishedCount).toBe(0);
    expect(result.blockedCount).toBe(1);
    expect(result.blockedPostIds).toEqual([postId]);

    const rows = (await getAdminSql()`
      SELECT status FROM awcms_mini_blog_posts
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `) as { status: string }[];
    expect(rows[0]?.status).toBe("scheduled");

    const auditRows = (await getAdminSql()`
      SELECT count(*)::int AS count FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND resource_id = ${postId}
        AND action = 'blog.post.scheduled_publish_blocked'
    `) as { count: number }[];
    expect(auditRows[0]?.count).toBe(1);
  });

  test("GET /api/v1/blog/posts/{id}/quality-checklist previews the same result without mutating anything", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody()
    });
    const postId = created.body.data.id;

    await getAdminSql()`
      UPDATE awcms_mini_blog_posts
      SET featured_media_id = '99999999-9999-9999-9999-999999999999'
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `;

    const response = await invoke<{
      data: {
        postId: string;
        qualityChecklist: { passed: boolean; blockers: { ruleId: string }[] };
      };
    }>(getPostQualityChecklist, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}/quality-checklist`,
      headers: authHeaders(owner),
      params: { id: postId }
    });

    expect(response.status).toBe(200);
    expect(response.body.data.qualityChecklist.passed).toBe(false);
    expect(
      response.body.data.qualityChecklist.blockers.some(
        (b) => b.ruleId === "featured_image_verified_r2"
      )
    ).toBe(true);

    const rows = (await getAdminSql()`
      SELECT status FROM awcms_mini_blog_posts
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `) as { status: string }[];
    expect(rows[0]?.status).toBe("draft");
  });

  test("GET /api/v1/blog/pages/{id}/quality-checklist previews the checklist for a page (taxonomy_exists not applicable)", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const created = await invoke<{ data: { id: string } }>(createPage, {
      method: "POST",
      path: "/api/v1/blog/pages",
      headers: authHeaders(owner),
      body: {
        title: "About",
        slug: "about",
        contentJson: { blocks: [{ type: "paragraph", text: "About us" }] },
        contentText: "About us"
      }
    });
    const pageId = created.body.data.id;

    const response = await invoke<{
      data: {
        pageId: string;
        qualityChecklist: { rules: { ruleId: string; applicable: boolean }[] };
      };
    }>(getPageQualityChecklist, {
      method: "GET",
      path: `/api/v1/blog/pages/${pageId}/quality-checklist`,
      headers: authHeaders(owner),
      params: { id: pageId }
    });

    expect(response.status).toBe(200);
    const taxonomyRule = response.body.data.qualityChecklist.rules.find(
      (r) => r.ruleId === "taxonomy_exists"
    );
    expect(taxonomyRule?.applicable).toBe(false);
  });
});
