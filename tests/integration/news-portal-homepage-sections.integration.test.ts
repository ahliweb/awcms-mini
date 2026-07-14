/**
 * Integration tests for Issue #637 (epic `news_portal`): the editorial
 * homepage section composer — tenant-scoped/RLS-protected CRUD
 * (`/api/v1/news-portal/homepage-sections`), reference validation (every
 * post/category/media id in `config` must exist for the SAME tenant, and
 * for `gallery_block` be a verified R2 media object), and public rendering
 * on `/news` (page 1 only, additive — a tenant with zero sections sees the
 * exact pre-#637 page).
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

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

import { getDatabaseClient } from "../../src/lib/database/client";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as createPost } from "../../src/pages/api/v1/blog/posts/index";
import { POST as publishPost } from "../../src/pages/api/v1/blog/posts/[id]/publish";
import { POST as createTerm } from "../../src/pages/api/v1/blog/terms/index";
import {
  GET as listSections,
  POST as createSection
} from "../../src/pages/api/v1/news-portal/homepage-sections/index";
import {
  DELETE as deleteSection,
  PATCH as updateSection
} from "../../src/pages/api/v1/news-portal/homepage-sections/[id]";
import { GET as newsIndex } from "../../src/pages/news/index";

import { withTenant } from "../../src/lib/database/tenant-context";
import {
  createPendingNewsMediaObject,
  markNewsMediaObjectUploaded,
  markNewsMediaObjectVerified
} from "../../src/modules/news-portal/application/news-media-object-directory";
import type { NewsMediaR2Config } from "../../src/modules/news-portal/domain/news-media-r2-config";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

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

type Bootstrap = {
  tenantId: string;
  tenantCode: string;
  token: string;
  tenantUserId: string;
};

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
    tenantCode,
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

/** A second, fully-independent tenant — `/setup/initialize` is a one-time wizard (only the first call in the process succeeds), so a second tenant must be seeded via raw SQL + a real login, never the wizard again. */
async function seedSecondTenant(tenantCode: string): Promise<Bootstrap> {
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
      VALUES (${tenantId}, 'full_access', 'Full Access') RETURNING id
    `) as { id: string }[];
    const permissions = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE (module_key = 'news_portal' AND activity_code = 'homepage_sections')
         OR (module_key = 'blog_content' AND activity_code = 'posts' AND action IN ('create', 'publish'))
    `) as { id: string }[];

    for (const permission of permissions) {
      await tx`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        VALUES (${tenantId}, ${role[0]!.id}, ${permission.id})
      `;
    }

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

  return { tenantId, tenantCode, token: login.body.data.token, tenantUserId };
}

async function createAndPublishPost(
  owner: Bootstrap,
  overrides: Record<string, unknown> = {}
): Promise<{ id: string; slug: string }> {
  const slug = (overrides.slug as string) ?? `post-${crypto.randomUUID()}`;
  const created = await invoke<{ data: { id: string; slug: string } }>(
    createPost,
    {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "Test Post",
        slug,
        contentJson: { blocks: [{ type: "paragraph", text: "Hello world" }] },
        contentText: "Hello world",
        locale: "en",
        ...overrides
      }
    }
  );
  expect(created.status).toBe(200);
  const postId = created.body.data.id;

  const published = await invoke(publishPost, {
    method: "POST",
    path: `/api/v1/blog/posts/${postId}/publish`,
    headers: { ...authHeaders(owner), "idempotency-key": crypto.randomUUID() },
    params: { id: postId }
  });
  expect(published.status).toBe(200);

  return { id: postId, slug: created.body.data.slug };
}

async function createCategoryTerm(
  owner: Bootstrap,
  slug: string
): Promise<{ id: string; slug: string }> {
  const result = await invoke<{ data: { id: string; slug: string } }>(
    createTerm,
    {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: {
        taxonomyType: "category",
        parentId: null,
        name: slug,
        slug,
        description: null
      }
    }
  );
  expect(result.status).toBe(200);
  return result.body.data;
}

async function seedVerifiedMediaObject(tenantId: string): Promise<string> {
  const sql = getDatabaseClient();

  return withTenant(sql, tenantId, async (tx) => {
    const created = await createPendingNewsMediaObject(
      tx,
      tenantId,
      crypto.randomUUID(),
      MEDIA_CONFIG,
      { mimeType: "image/jpeg" }
    );
    await markNewsMediaObjectUploaded(tx, tenantId, created.id, {
      sizeBytes: 12_345,
      checksumSha256: "a".repeat(64)
    });
    const verified = await markNewsMediaObjectVerified(
      tx,
      tenantId,
      crypto.randomUUID(),
      created.id,
      {}
    );
    return verified!.id;
  });
}

const suite = integrationEnabled ? describe : describe.skip;

suite("news_portal homepage sections (Issue #637)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("create a headline section referencing an existing post succeeds", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner);

    const response = await invoke<{
      data: { sectionKey: string; sectionType: string };
    }>(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-headline",
        sectionType: "headline",
        config: { postId: post.id }
      }
    });

    expect(response.status).toBe(200);
    expect(response.body.data.sectionKey).toBe("front-page-headline");
    expect(response.body.data.sectionType).toBe("headline");
  });

  test("rejects a headline section referencing a post that does not exist (422)", async () => {
    const owner = await bootstrap();

    const response = await invoke<{ error: { code: string } }>(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-headline",
        sectionType: "headline",
        config: { postId: "99999999-9999-9999-9999-999999999999" }
      }
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("HOMEPAGE_SECTION_REFERENCE_INVALID");
  });

  test("rejects a headline section referencing another tenant's post (cross-tenant reference is indistinguishable from nonexistent)", async () => {
    const owner = await bootstrap("crossa");
    const otherTenant = await seedSecondTenant("crossb");
    const otherPost = await createAndPublishPost(otherTenant);

    const response = await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-headline",
        sectionType: "headline",
        config: { postId: otherPost.id }
      }
    });

    expect(response.status).toBe(422);
  });

  test("rejects duplicate sectionKey for the same tenant (409)", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner);
    const body = {
      sectionKey: "front-page-headline",
      sectionType: "headline",
      config: { postId: post.id }
    };

    const first = await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body
    });
    expect(first.status).toBe(200);

    const second = await invoke<{ error: { code: string } }>(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("HOMEPAGE_SECTION_KEY_CONFLICT");
  });

  test("gallery_block accepts a verified same-tenant media object and rejects an unverified/cross-tenant one", async () => {
    const owner = await bootstrap("gallerya");
    const verifiedMediaId = await seedVerifiedMediaObject(owner.tenantId);

    const accepted = await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-gallery",
        sectionType: "gallery_block",
        config: { mediaObjectIds: [verifiedMediaId] }
      }
    });
    expect(accepted.status).toBe(200);

    const otherTenant = await seedSecondTenant("galleryb");
    const otherMediaId = await seedVerifiedMediaObject(otherTenant.tenantId);

    const rejected = await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-gallery-2",
        sectionType: "gallery_block",
        config: { mediaObjectIds: [otherMediaId] }
      }
    });
    expect(rejected.status).toBe(422);
  });

  test("category_grid accepts a categorySlug that exists for this tenant", async () => {
    const owner = await bootstrap();
    const category = await createCategoryTerm(owner, "front-page-category");

    const response = await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-categories-ok",
        sectionType: "category_grid",
        config: { categorySlugs: [category.slug] }
      }
    });
    expect(response.status).toBe(200);
  });

  test("category_grid rejects a categorySlug that does not exist for this tenant", async () => {
    const owner = await bootstrap();

    const response = await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-categories",
        sectionType: "category_grid",
        config: { categorySlugs: ["does-not-exist"] }
      }
    });
    expect(response.status).toBe(422);
  });

  test("PATCH updates title/sortOrder/isEnabled and rejects changing sectionType", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner);
    const created = await invoke<{ data: { id: string } }>(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-headline",
        sectionType: "headline",
        config: { postId: post.id }
      }
    });
    const id = created.body.data.id;

    const updated = await invoke<{
      data: { title: string; sortOrder: number; isEnabled: boolean };
    }>(updateSection, {
      method: "PATCH",
      path: `/api/v1/news-portal/homepage-sections/${id}`,
      headers: authHeaders(owner),
      params: { id },
      body: { title: "Top Story", sortOrder: 5, isEnabled: false }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.title).toBe("Top Story");
    expect(updated.body.data.sortOrder).toBe(5);
    expect(updated.body.data.isEnabled).toBe(false);

    const rejected = await invoke(updateSection, {
      method: "PATCH",
      path: `/api/v1/news-portal/homepage-sections/${id}`,
      headers: authHeaders(owner),
      params: { id },
      body: { sectionType: "gallery_block" }
    });
    expect(rejected.status).toBe(400);
  });

  test("DELETE soft-deletes a section; it disappears from the list and 404s on further update", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner);
    const created = await invoke<{ data: { id: string } }>(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-headline",
        sectionType: "headline",
        config: { postId: post.id }
      }
    });
    const id = created.body.data.id;

    const deleted = await invoke(deleteSection, {
      method: "DELETE",
      path: `/api/v1/news-portal/homepage-sections/${id}`,
      headers: authHeaders(owner),
      params: { id },
      body: { reason: "no longer needed" }
    });
    expect(deleted.status).toBe(200);

    const list = await invoke<{ data: { sections: { id: string }[] } }>(
      listSections,
      {
        method: "GET",
        path: "/api/v1/news-portal/homepage-sections",
        headers: authHeaders(owner)
      }
    );
    expect(list.body.data.sections.map((s) => s.id)).not.toContain(id);

    const updateAfterDelete = await invoke(updateSection, {
      method: "PATCH",
      path: `/api/v1/news-portal/homepage-sections/${id}`,
      headers: authHeaders(owner),
      params: { id },
      body: { title: "still here?" }
    });
    expect(updateAfterDelete.status).toBe(404);
  });

  test("cross-tenant isolation: tenant B cannot see or update tenant A's section (404, not 403 — RLS makes it invisible, not merely forbidden)", async () => {
    const owner = await bootstrap("isoa");
    const post = await createAndPublishPost(owner);
    const created = await invoke<{ data: { id: string } }>(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-headline",
        sectionType: "headline",
        config: { postId: post.id }
      }
    });
    const id = created.body.data.id;

    const tenantB = await seedSecondTenant("isob");

    const list = await invoke<{ data: { sections: { id: string }[] } }>(
      listSections,
      {
        method: "GET",
        path: "/api/v1/news-portal/homepage-sections",
        headers: authHeaders(tenantB)
      }
    );
    expect(list.body.data.sections.map((s) => s.id)).not.toContain(id);

    const update = await invoke(updateSection, {
      method: "PATCH",
      path: `/api/v1/news-portal/homepage-sections/${id}`,
      headers: authHeaders(tenantB),
      params: { id },
      body: { title: "hijacked" }
    });
    expect(update.status).toBe(404);
  });

  test("a tenant user without homepage_sections permissions is denied (403) on read and create", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner);
    const admin = getAdminSql();
    const passwordHash = await Bun.password.hash("no-permissions-password");
    const noPermLogin = "no-perm@example.com";
    let noPermTenantUserId = "";

    await admin.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${owner.tenantId}'`);
      const profile = (await tx`
        INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
        VALUES (${owner.tenantId}, 'person', 'No Perm User') RETURNING id
      `) as { id: string }[];
      const identity = (await tx`
        INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
        VALUES (${owner.tenantId}, ${profile[0]!.id}, ${noPermLogin}, ${passwordHash})
        RETURNING id
      `) as { id: string }[];
      const tenantUser = (await tx`
        INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
        VALUES (${owner.tenantId}, ${identity[0]!.id}) RETURNING id
      `) as { id: string }[];
      noPermTenantUserId = tenantUser[0]!.id;
    });

    const login = await invoke<{ data: { token: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId
      },
      body: {
        loginIdentifier: noPermLogin,
        password: "no-permissions-password"
      },
      cookies: createCookieJar()
    });
    expect(login.status).toBe(200);

    const noPermUser: Bootstrap = {
      tenantId: owner.tenantId,
      tenantCode: owner.tenantCode,
      token: login.body.data.token,
      tenantUserId: noPermTenantUserId
    };

    const list = await invoke(listSections, {
      method: "GET",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(noPermUser)
    });
    expect(list.status).toBe(403);

    const create = await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(noPermUser),
      body: {
        sectionKey: "front-page-headline",
        sectionType: "headline",
        config: { postId: post.id }
      }
    });
    expect(create.status).toBe(403);
  });

  test("a tenant with zero homepage sections renders /news exactly as before Issue #637 (no homepage-section markup)", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, { slug: "plain-post" });

    const index = await invokeRaw(newsIndex, { method: "GET", path: "/news" });
    expect(index.status).toBe(200);
    expect(index.text).toContain("plain-post");
    expect(index.text).not.toContain("homepage-section");
  });

  test("an enabled headline section renders on /news; a disabled one does not", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, { slug: "headline-post" });

    await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-headline",
        sectionType: "headline",
        title: "Top Story",
        config: { postId: post.id }
      }
    });

    const enabled = await invokeRaw(newsIndex, {
      method: "GET",
      path: "/news"
    });
    expect(enabled.status).toBe(200);
    expect(enabled.text).toContain("homepage-section-headline");
    expect(enabled.text).toContain("Top Story");
    expect(enabled.text).toContain("headline-post");

    const sections = await invoke<{ data: { sections: { id: string }[] } }>(
      listSections,
      {
        method: "GET",
        path: "/api/v1/news-portal/homepage-sections",
        headers: authHeaders(owner)
      }
    );
    const sectionId = sections.body.data.sections[0]!.id;

    await invoke(updateSection, {
      method: "PATCH",
      path: `/api/v1/news-portal/homepage-sections/${sectionId}`,
      headers: authHeaders(owner),
      params: { id: sectionId },
      body: { isEnabled: false }
    });

    const disabled = await invokeRaw(newsIndex, {
      method: "GET",
      path: "/news"
    });
    expect(disabled.text).not.toContain("homepage-section-headline");
  });

  test("a curated post that becomes unpublished/removed after configuration silently disappears from the section (degrade, don't 500)", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, { slug: "curated-post" });

    await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-featured",
        sectionType: "featured_posts",
        config: { postIds: [post.id] }
      }
    });

    const sql = getDatabaseClient();
    await withTenant(
      sql,
      owner.tenantId,
      (tx) =>
        tx`UPDATE awcms_mini_blog_posts SET status = 'draft' WHERE id = ${post.id}`
    );

    const response = await invokeRaw(newsIndex, {
      method: "GET",
      path: "/news"
    });
    expect(response.status).toBe(200);
    expect(response.text).not.toContain("curated-post");
  });

  test("gallery_block section renders the resolved image on /news via the shared whitelisted gallery renderer", async () => {
    const owner = await bootstrap();
    const mediaId = await seedVerifiedMediaObject(owner.tenantId);

    await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-gallery",
        sectionType: "gallery_block",
        config: { mediaObjectIds: [mediaId], caption: "Gallery Caption" }
      }
    });

    const response = await invokeRaw(newsIndex, {
      method: "GET",
      path: "/news"
    });
    expect(response.status).toBe(200);
    expect(response.text).toContain("media.example.test");
    expect(response.text).toContain("Gallery Caption");
  });

  test("a section with a future startsAt or a past endsAt is hidden from /news (schedule window)", async () => {
    const owner = await bootstrap();
    const futurePost = await createAndPublishPost(owner, {
      slug: "future-section-post"
    });
    const expiredPost = await createAndPublishPost(owner, {
      slug: "expired-section-post"
    });

    await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-future",
        sectionType: "headline",
        config: { postId: futurePost.id },
        startsAt: "2099-01-01T00:00:00.000Z"
      }
    });

    await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-expired",
        sectionType: "headline",
        config: { postId: expiredPost.id },
        endsAt: "2000-01-01T00:00:00.000Z"
      }
    });

    const response = await invokeRaw(newsIndex, {
      method: "GET",
      path: "/news"
    });
    expect(response.status).toBe(200);
    // Both posts remain reachable via the plain chronological list below the
    // (empty, since neither section is in-window) composed section area —
    // the schedule window only hides the SECTION wrapper, not the post
    // itself. Absence of the section markup is what this test proves.
    expect(response.text).not.toContain("homepage-section-headline");
  });

  test("sort_order controls the rendered order of multiple simultaneously-active sections on /news", async () => {
    const owner = await bootstrap();
    const firstPost = await createAndPublishPost(owner, {
      slug: "first-section-post"
    });
    const secondPost = await createAndPublishPost(owner, {
      slug: "second-section-post"
    });

    // Created out of visual order on purpose — sortOrder, not creation
    // order, must determine render order.
    await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-second",
        sectionType: "headline",
        config: { postId: secondPost.id },
        sortOrder: 2
      }
    });
    await invoke(createSection, {
      method: "POST",
      path: "/api/v1/news-portal/homepage-sections",
      headers: authHeaders(owner),
      body: {
        sectionKey: "front-page-first",
        sectionType: "headline",
        config: { postId: firstPost.id },
        sortOrder: 1
      }
    });

    const response = await invokeRaw(newsIndex, {
      method: "GET",
      path: "/news"
    });
    expect(response.status).toBe(200);
    const firstIndex = response.text.indexOf("first-section-post");
    const secondIndex = response.text.indexOf("second-section-post");
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(-1);
    expect(firstIndex).toBeLessThan(secondIndex);
  });
});
