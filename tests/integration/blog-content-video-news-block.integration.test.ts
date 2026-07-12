/**
 * Integration tests for Issue #639 (epic `news_portal`): the `video_news`
 * content block. Covers provider allowlisting, videoId validation/
 * normalization, rejection of raw iframe/script content, the custom
 * thumbnail's R2-only-mode-gated verification (cross-tenant/unverified/
 * deleted rejection — same policy as featured images and gallery images,
 * Issue #636), and public rendering as a safe provider embed (never a raw
 * stored iframe).
 *
 * Deliberately a SEPARATE file from
 * `blog-content-news-media-r2-references.integration.test.ts` (Issue
 * #636's own hardened test file, three review rounds) — this issue's
 * checks are additive (new block type), so a new file keeps that file's
 * diff untouched and avoids merge collision with any other in-flight
 * issue also extending it.
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
  invokeRaw,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as createPost } from "../../src/pages/api/v1/blog/posts/index";
import { PATCH as updatePost } from "../../src/pages/api/v1/blog/posts/[id]";
import { POST as publishPost } from "../../src/pages/api/v1/blog/posts/[id]/publish";
import { GET as getNewsDetail } from "../../src/pages/news/[slug]";
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";
import { applyNewsPortalFullOnlineR2Preset } from "../../src/modules/news-portal/application/apply-news-portal-preset";
import type { NewsMediaR2Config } from "../../src/modules/news-portal/domain/news-media-r2-config";
import {
  createPendingNewsMediaObject,
  markNewsMediaObjectFailed,
  markNewsMediaObjectUploaded,
  markNewsMediaObjectVerified,
  softDeleteNewsMediaObject,
  type NewsMediaObjectView
} from "../../src/modules/news-portal/application/news-media-object-directory";

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

/** Same minimal raw-tenant seeding as the #636 integration suite — only needs to OWN a media object for cross-tenant tests, never log in. */
async function seedRawTenant(tenantCode: string): Promise<string> {
  const tenantId = crypto.randomUUID();
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${tenantId}, ${tenantCode}, ${tenantCode}, ${tenantCode}, 'active', 'en', 'light')
  `;
  return tenantId;
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

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

async function seedNewsMediaObject(
  tenantId: string,
  actorTenantUserId: string,
  status: "pending_upload" | "uploaded" | "verified" | "failed"
): Promise<NewsMediaObjectView> {
  const sql = getDatabaseClient();

  return withTenant(sql, tenantId, async (tx) => {
    const created = await createPendingNewsMediaObject(
      tx,
      tenantId,
      actorTenantUserId,
      MEDIA_CONFIG,
      { mimeType: "image/jpeg" }
    );

    if (status === "pending_upload") {
      return created;
    }

    const uploaded = await markNewsMediaObjectUploaded(
      tx,
      tenantId,
      created.id,
      { sizeBytes: 12_345, checksumSha256: "a".repeat(64) }
    );

    if (status === "uploaded") {
      return uploaded!;
    }

    if (status === "failed") {
      return (await markNewsMediaObjectFailed(tx, tenantId, created.id))!;
    }

    return (await markNewsMediaObjectVerified(
      tx,
      tenantId,
      actorTenantUserId,
      created.id,
      {}
    ))!;
  });
}

function videoNewsContentJson(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    blocks: [
      {
        type: "video_news",
        provider: "youtube",
        videoId: "dQw4w9WgXcQ",
        ...overrides
      }
    ]
  };
}

function validCreatePostBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "Hello",
    slug: `hello-${Math.random().toString(36).slice(2, 8)}`,
    excerpt: null,
    contentJson: { blocks: [{ type: "paragraph", text: "Body" }] },
    contentText: "Body",
    locale: "en",
    ...overrides
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("blog_content video_news content block (Issue #639)", () => {
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

  test("a well-formed video_news block (no thumbnail) is accepted, with no R2 mode active", async () => {
    const owner = await bootstrap();

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({ contentJson: videoNewsContentJson() })
    });

    expect(response.status).toBe(200);
  });

  test("videoId is normalized server-side from a full YouTube URL to the bare id", async () => {
    const owner = await bootstrap();

    const response = await invoke<{
      data: { contentJson: { blocks: Array<Record<string, unknown>> } };
    }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: videoNewsContentJson({
          videoId: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s"
        })
      })
    });

    expect(response.status).toBe(200);
    expect(response.body.data.contentJson.blocks[0]?.videoId).toBe(
      "dQw4w9WgXcQ"
    );
  });

  test("an unsupported provider is rejected 400", async () => {
    const owner = await bootstrap();

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: videoNewsContentJson({ provider: "vimeo" })
      })
    });

    expect(response.status).toBe(400);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("an invalid/malformed videoId is rejected 400", async () => {
    const owner = await bootstrap();

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: videoNewsContentJson({ videoId: "not-a-video-id" })
      })
    });

    expect(response.status).toBe(400);
  });

  test("a raw iframe embed anywhere in contentJson is rejected 400, even nested in a video_news block's field", async () => {
    const owner = await bootstrap();

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: videoNewsContentJson({
          title: '"><iframe src="https://evil.example.com"></iframe>'
        })
      })
    });

    // Rejected by the pre-existing, unconditional containsUnsafeHtml
    // regex scan over the whole stringified contentJson (Issue #538) —
    // applies to every block type, including this new one.
    expect(response.status).toBe(400);
  });

  test("a raw script tag anywhere in contentJson is rejected 400", async () => {
    const owner = await bootstrap();

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: videoNewsContentJson({
          caption: "<script>alert(1)</script>"
        })
      })
    });

    expect(response.status).toBe(400);
  });

  test("an unrecognized field (e.g. a smuggled rawEmbedHtml) on a video_news block is silently dropped, not persisted", async () => {
    const owner = await bootstrap();

    const response = await invoke<{
      data: { contentJson: { blocks: Array<Record<string, unknown>> } };
    }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: videoNewsContentJson({
          sourceLabel: "Reuters",
          unexpectedField: "should be dropped"
        })
      })
    });

    expect(response.status).toBe(200);
    expect(response.body.data.contentJson.blocks[0]).not.toHaveProperty(
      "unexpectedField"
    );
    expect(response.body.data.contentJson.blocks[0]?.sourceLabel).toBe(
      "Reuters"
    );
  });

  test("R2-only mode NOT active: a video_news block with an arbitrary thumbnailMediaObjectId (never a real registry row) is accepted unchanged", async () => {
    const owner = await bootstrap();

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: videoNewsContentJson({
          thumbnailMediaObjectId: "99999999-9999-9999-9999-999999999999"
        })
      })
    });

    expect(response.status).toBe(200);
  });

  test("R2-only mode active: a video_news block with NO thumbnailMediaObjectId is accepted (custom thumbnail is optional)", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({ contentJson: videoNewsContentJson() })
    });

    expect(response.status).toBe(200);
  });

  test("R2-only mode active: thumbnailMediaObjectId referencing a verified, same-tenant media object is accepted", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);
    const media = await seedNewsMediaObject(
      owner.tenantId,
      owner.tenantUserId,
      "verified"
    );

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: videoNewsContentJson({
          thumbnailMediaObjectId: media.id
        })
      })
    });

    expect(response.status).toBe(200);
  });

  test("R2-only mode active: thumbnailMediaObjectId that does not exist at all is rejected 422", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: videoNewsContentJson({
          thumbnailMediaObjectId: "99999999-9999-9999-9999-999999999999"
        })
      })
    });

    expect(response.status).toBe(422);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "NEWS_MEDIA_REFERENCE_INVALID"
    );
  });

  test("R2-only mode active: thumbnailMediaObjectId referencing another tenant's media object is rejected 422 (cross-tenant)", async () => {
    const owner = await bootstrap("videotenanta");
    await activateFullOnlineR2Mode(owner);
    const otherTenantId = await seedRawTenant("videotenantb");
    const otherMedia = await seedNewsMediaObject(
      otherTenantId,
      crypto.randomUUID(),
      "verified"
    );

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: videoNewsContentJson({
          thumbnailMediaObjectId: otherMedia.id
        })
      })
    });

    expect(response.status).toBe(422);
  });

  test.each(["pending_upload", "uploaded", "failed"] as const)(
    "R2-only mode active: thumbnailMediaObjectId referencing a %s (not yet verified) media object is rejected 422",
    async (status) => {
      const owner = await bootstrap();
      await activateFullOnlineR2Mode(owner);
      const media = await seedNewsMediaObject(
        owner.tenantId,
        owner.tenantUserId,
        status
      );

      const response = await invoke(createPost, {
        method: "POST",
        path: "/api/v1/blog/posts",
        headers: authHeaders(owner),
        body: validCreatePostBody({
          contentJson: videoNewsContentJson({
            thumbnailMediaObjectId: media.id
          })
        })
      });

      expect(response.status).toBe(422);
    }
  );

  test("R2-only mode active: thumbnailMediaObjectId referencing a soft-deleted media object is rejected 422", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);
    const media = await seedNewsMediaObject(
      owner.tenantId,
      owner.tenantUserId,
      "verified"
    );
    const sql = getDatabaseClient();
    await withTenant(sql, owner.tenantId, (tx) =>
      softDeleteNewsMediaObject(
        tx,
        owner.tenantId,
        owner.tenantUserId,
        media.id,
        "no longer needed"
      )
    );

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: videoNewsContentJson({
          thumbnailMediaObjectId: media.id
        })
      })
    });

    expect(response.status).toBe(422);
  });

  test("PATCH update also enforces the same validation on a changed video_news block", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody()
    });
    expect(created.status).toBe(200);

    const response = await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${created.body.data.id}`,
      headers: authHeaders(owner),
      params: { id: created.body.data.id },
      body: {
        contentJson: videoNewsContentJson({
          thumbnailMediaObjectId: "99999999-9999-9999-9999-999999999999"
        })
      }
    });

    expect(response.status).toBe(422);
  });

  test("public detail route (/news/{slug}) renders the video_news block as a safe youtube-nocookie.com iframe embed and its resolved thumbnail, never a raw stored iframe", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);
    const thumbnail = await seedNewsMediaObject(
      owner.tenantId,
      owner.tenantUserId,
      "verified"
    );

    const slug = `video-news-render-${Math.random().toString(36).slice(2, 8)}`;
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        slug,
        contentJson: videoNewsContentJson({
          title: "Breaking news",
          thumbnailMediaObjectId: thumbnail.id
        })
      })
    });
    expect(created.status).toBe(200);

    const published = await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${created.body.data.id}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-key-1" },
      params: { id: created.body.data.id }
    });
    expect(published.status).toBe(200);

    const response = await invokeRaw(getNewsDetail, {
      method: "GET",
      path: `/news/${slug}`,
      params: { slug }
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"'
    );
    expect(response.text).toContain(
      `<img class="video-news-thumbnail" src="${thumbnail.publicUrl}"`
    );
    // The video_news block itself must never echo a raw stored <script>/
    // iframe (Issue #639's actual safety property) — the page's ONLY
    // <script> tag is the unrelated, safe, same-origin news-share widget
    // script (Issue #642, merged after this test was first written), so
    // assert that specifically rather than banning all <script> tags
    // outright.
    const scriptTags = [...response.text.matchAll(/<script\b[^>]*>/gi)];
    expect(scriptTags.length).toBe(1);
    expect(scriptTags[0]![0]).toContain('src="/js/news-share.js"');
  });
});
