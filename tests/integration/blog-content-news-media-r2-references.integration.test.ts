/**
 * Integration tests for Issue #636 (epic `news_portal`): `blog_content`
 * post/page create/update requires featured image + image-gallery-block
 * references to be existing, same-tenant, `verified`/`attached` R2 media
 * registry objects (Issue #633) when full-online R2-only mode is active
 * FOR THE TENANT making the request — never a raw URL, never another
 * tenant's object, never an unverified/failed/deleted one. Also proves
 * the public detail routes (`/news/{slug}`, `/blog/{tenantCode}/{slug}`)
 * render gallery images and `og:image`/`twitter:image` from resolved,
 * verified media metadata only.
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
import { POST as restorePostRevision } from "../../src/pages/api/v1/blog/posts/[id]/revisions/[revisionId]/restore";
import { PATCH as updateTenantModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
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
  pendingTtlMinutes: 60
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

/**
 * `POST /api/v1/setup/initialize` is a one-time, system-wide setup wizard —
 * only the FIRST call in the process ever succeeds (every subsequent call
 * 403s with "Setup has already been completed"), so cross-tenant tests
 * cannot call `bootstrap()` twice. Tenant B here only needs to OWN a media
 * object, never log in — a raw tenant row (same minimal pattern
 * `news-media-object-registry.integration.test.ts` uses) is enough.
 */
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

/**
 * A SECOND fully-authenticated tenant (own login, own `blog_content.posts.create`
 * permission), built via direct SQL + `POST /api/v1/auth/login` — never via
 * `/setup/initialize` (one-time wizard, see `seedRawTenant`'s docblock).
 * Needed for the "tenant B never applied the preset" regression test below,
 * which requires B to actually make an authenticated write request, not just
 * own a media object.
 */
async function seedSecondTenantWithCreateAccess(
  tenantCode: string
): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const password = "integration-test-tenant-b-password";
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${tenantId}, ${tenantCode}, ${tenantCode}, ${tenantCode}, 'active', 'en', 'light')
  `;

  const passwordHash = await Bun.password.hash(password);
  let tenantUserId = "";

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Tenant B User') RETURNING id
    `) as { id: string }[];
    const identity = (await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, ${loginIdentifier}, ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    const tenantUser = (await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
    `) as { id: string }[];
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'post_creator', 'Post Creator') RETURNING id
    `) as { id: string }[];
    const permission = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'blog_content' AND activity_code = 'posts' AND action = 'create'
    `) as { id: string }[];

    await tx`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
      VALUES (${tenantId}, ${role[0]!.id}, ${permission[0]!.id})
    `;
    await tx`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
      VALUES (${tenantId}, ${tenantUser[0]!.id}, ${role[0]!.id})
    `;

    tenantUserId = tenantUser[0]!.id;
  });

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, token: login.body.data.token, tenantUserId };
}

/**
 * Enables the `news_portal_full_online_r2` preset for `owner`'s tenant —
 * full-online R2-only mode is then active for THAT tenant. Also sets
 * `process.env` to `FULLY_CONFIGURED_ENV`: the preset-activation call
 * itself only uses the env it's explicitly given, but the REAL request
 * path (`validateNewsMediaReferencesForFullOnlineR2Mode`, called from the
 * route handlers with no explicit `env` argument) reads `process.env` by
 * default — this must actually be set for the tenant+env composite gate
 * to be active for the requests this test makes next. Reset every test by
 * this suite's own `beforeEach`.
 */
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

/** Creates a news media object in the given tenant, advances it to `status`. */
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
      {
        sizeBytes: 12_345,
        checksumSha256: "a".repeat(64)
      }
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

suite("blog_content news media R2 reference validation (Issue #636)", () => {
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
    // Reset to the pre-suite env before every test — `activateFullOnlineR2Mode`
    // mutates `process.env` (see its own comment) and must never leak into a
    // later test, including the very first test below which specifically
    // asserts behavior when R2-only mode is NOT active.
    process.env = { ...previousEnv };
  });

  test("R2-only mode NOT active for the tenant: an arbitrary featuredMediaId (never a real registry row) is accepted unchanged (backward compatible)", async () => {
    const owner = await bootstrap();
    // Deliberately never call activateFullOnlineR2Mode.

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        featuredMediaId: "99999999-9999-9999-9999-999999999999"
      })
    });

    expect(response.status).toBe(200);
  });

  test("R2-only mode active for tenant A does NOT leak into tenant B, which never applied the preset (reviewer finding, PR #666 review — env is process-wide, so the tenant-scoping here must come entirely from the explicit-enable-record check, not from env alone)", async () => {
    const tenantA = await bootstrap("modeleaktesta");
    await activateFullOnlineR2Mode(tenantA);

    // Tenant B never calls activateFullOnlineR2Mode/applyNewsPortalFullOnlineR2Preset
    // — it should behave exactly as if full-online R2-only mode did not
    // exist, even though process.env now has every NEWS_MEDIA_R2_*/
    // NEWS_PORTAL_* var set globally (mutated by tenant A's activation
    // above) — the ONLY thing that must matter is tenant B's own
    // awcms_mini_tenant_modules state (or lack thereof) for news_portal.
    const tenantB = await seedSecondTenantWithCreateAccess("modeleaktestb");

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(tenantB),
      body: validCreatePostBody({
        featuredMediaId: "99999999-9999-9999-9999-999999999999"
      })
    });

    expect(response.status).toBe(200);
  });

  test("security-auditor finding, PR #666 second re-review: the generic PATCH /api/v1/tenant/modules/{moduleKey}/settings endpoint CANNOT disable R2-only validation for a tenant that genuinely applied the preset", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    // Same generic permission an Owner already holds by default seed RBAC
    // (module_management.settings.update) — entirely unrelated to
    // blog_content/news_portal permissions. Previously (when the marker
    // lived in awcms_mini_module_settings) this exact call could null out
    // the marker and disable all R2-only validation. The marker now lives
    // in a dedicated table with no route anywhere that can write to it, so
    // this PATCH either 404s (moduleKey exists but has no settings
    // defaults to touch) or succeeds while having ZERO effect on the real
    // signal.
    await invoke(updateTenantModuleSettings, {
      method: "PATCH",
      path: "/api/v1/tenant/modules/news_portal/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "news_portal" },
      body: { fullOnlineR2ModeAppliedAt: null }
    });

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        featuredMediaId: "99999999-9999-9999-9999-999999999999"
      })
    });

    // Still rejected — the PATCH above had no effect on the real,
    // dedicated-table signal.
    expect(response.status).toBe(422);
  });

  test("R2-only mode active: featuredMediaId referencing a verified, same-tenant media object is accepted", async () => {
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
      body: validCreatePostBody({ featuredMediaId: media.id })
    });

    expect(response.status).toBe(200);
  });

  test("R2-only mode active: featuredMediaId that does not exist at all is rejected 422", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        featuredMediaId: "99999999-9999-9999-9999-999999999999"
      })
    });

    expect(response.status).toBe(422);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "NEWS_MEDIA_REFERENCE_INVALID"
    );
  });

  test("R2-only mode active: featuredMediaId referencing another tenant's media object is rejected 422 (cross-tenant)", async () => {
    const owner = await bootstrap("tenanta");
    await activateFullOnlineR2Mode(owner);
    const otherTenantId = await seedRawTenant("tenantb");
    const otherMedia = await seedNewsMediaObject(
      otherTenantId,
      crypto.randomUUID(),
      "verified"
    );

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({ featuredMediaId: otherMedia.id })
    });

    expect(response.status).toBe(422);
  });

  test.each(["pending_upload", "uploaded", "failed"] as const)(
    "R2-only mode active: featuredMediaId referencing a %s (not yet verified) media object is rejected 422",
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
        body: validCreatePostBody({ featuredMediaId: media.id })
      });

      expect(response.status).toBe(422);
    }
  );

  test("R2-only mode active: featuredMediaId referencing a soft-deleted media object is rejected 422", async () => {
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
      body: validCreatePostBody({ featuredMediaId: media.id })
    });

    expect(response.status).toBe(422);
  });

  test("R2-only mode active: an image gallery block item using a raw url is rejected 422", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: {
          blocks: [
            {
              type: "gallery",
              items: [
                {
                  mediaType: "image",
                  url: "https://untrusted.example.com/a.jpg"
                }
              ]
            }
          ]
        }
      })
    });

    expect(response.status).toBe(422);
    const body = response.body as {
      error: { code: string; details?: { message?: string }[] };
    };
    expect(body.error.code).toBe("NEWS_MEDIA_REFERENCE_INVALID");
    expect(
      body.error.details?.some((detail) => detail.message?.includes("raw"))
    ).toBe(true);
  });

  test("R2-only mode active: an image gallery block item with a valid, verified mediaObjectId is accepted", async () => {
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
        contentJson: {
          blocks: [
            {
              type: "gallery",
              items: [{ mediaType: "image", mediaObjectId: media.id }]
            }
          ]
        }
      })
    });

    expect(response.status).toBe(200);
  });

  test("R2-only mode active: a video gallery item keeps using a raw url unaffected (Issue #639's scope, not #636)", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const response = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        contentJson: {
          blocks: [
            {
              type: "gallery",
              items: [
                { mediaType: "video", url: "https://cdn.example.com/a.mp4" }
              ]
            }
          ]
        }
      })
    });

    expect(response.status).toBe(200);
  });

  test("R2-only mode active: PATCH update also enforces the same validation on a changed featuredMediaId", async () => {
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
      body: { featuredMediaId: "99999999-9999-9999-9999-999999999999" }
    });

    expect(response.status).toBe(422);
  });

  test("R2-only mode active: POST .../revisions/{id}/restore also enforces the same validation (security-auditor finding, PR #666 review) — cannot silently reintroduce a stale raw-url gallery reference from before the mode was activated", async () => {
    const owner = await bootstrap();
    const admin = getAdminSql();

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody()
    });
    const postId = created.body.data.id;

    // Step 1 (BEFORE R2-only mode is active — legal at the time): a
    // significant-content-change PATCH to a raw-url gallery item snapshots
    // the POST-patch state as revision #1 (this codebase's revision
    // convention: `createBlogRevision` captures `updated`, i.e. AFTER the
    // patch is applied, not before).
    const rawUrlContentJson = {
      blocks: [
        {
          type: "gallery",
          items: [
            {
              mediaType: "image",
              url: "https://untrusted.example.com/old-pre-r2-mode.jpg"
            }
          ]
        }
      ]
    };
    const patchToRawUrl = await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { contentJson: rawUrlContentJson }
    });
    expect(patchToRawUrl.status).toBe(200);

    const revisionRows = (await admin`
      SELECT id FROM awcms_mini_blog_revisions
      WHERE tenant_id = ${owner.tenantId} AND resource_type = 'post' AND resource_id = ${postId}
      ORDER BY revision_number ASC LIMIT 1
    `) as { id: string }[];
    const staleRevisionId = revisionRows[0]!.id;

    // Step 2 (still BEFORE R2-only mode): edit the post AGAIN to benign
    // content — the live post no longer has the raw url anywhere, only the
    // now-superseded revision #1 does.
    const patchToBenign = await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: {
        contentJson: { blocks: [{ type: "paragraph", text: "Benign body" }] }
      }
    });
    expect(patchToBenign.status).toBe(200);

    // Step 3: NOW activate R2-only mode for this tenant.
    await activateFullOnlineR2Mode(owner);

    // Step 4: restoring the stale revision must be rejected — the live
    // post's current (benign) content must remain untouched, never
    // silently overwritten with the stale raw-url gallery content.
    const restoreResponse = await invoke(restorePostRevision, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/revisions/${staleRevisionId}/restore`,
      headers: { ...authHeaders(owner), "idempotency-key": "restore-key-1" },
      params: { id: postId, revisionId: staleRevisionId }
    });

    expect(restoreResponse.status).toBe(422);
    const restoreBody = restoreResponse.body as { error: { code: string } };
    expect(restoreBody.error.code).toBe("NEWS_MEDIA_REFERENCE_INVALID");

    const postRow = (await admin`
      SELECT content_json FROM awcms_mini_blog_posts WHERE id = ${postId}
    `) as { content_json: unknown }[];
    expect(JSON.stringify(postRow[0]!.content_json)).not.toContain(
      "untrusted.example.com"
    );
    expect(JSON.stringify(postRow[0]!.content_json)).toContain("Benign body");

    // No new "Restored from revision N" revision should have been created
    // either — the restore never reached that point.
    const revisionCountRows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_blog_revisions
      WHERE tenant_id = ${owner.tenantId} AND resource_type = 'post' AND resource_id = ${postId}
    `) as { count: number }[];
    expect(revisionCountRows[0]!.count).toBe(2);
  });

  test("public detail route (/news/{slug}) renders og:image + gallery <img> from resolved, verified R2 media metadata only", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);
    const featuredMedia = await seedNewsMediaObject(
      owner.tenantId,
      owner.tenantUserId,
      "verified"
    );
    const galleryMedia = await seedNewsMediaObject(
      owner.tenantId,
      owner.tenantUserId,
      "verified"
    );

    const slug = `news-render-${Math.random().toString(36).slice(2, 8)}`;
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody({
        slug,
        featuredMediaId: featuredMedia.id,
        contentJson: {
          blocks: [
            {
              type: "gallery",
              items: [{ mediaType: "image", mediaObjectId: galleryMedia.id }]
            }
          ]
        }
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
      `og:image" content="${featuredMedia.publicUrl}"`
    );
    expect(response.text).toContain(`<img src="${galleryMedia.publicUrl}"`);
  });
});
