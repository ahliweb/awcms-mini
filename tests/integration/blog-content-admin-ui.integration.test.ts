/**
 * Integration tests for the admin-UI-only read functions Issue #543 added
 * to `blog-content`'s application layer — `listBlogPostsForAdmin` and
 * `listBlogPagesForAdmin` (`blog-post-directory.ts`/`blog-page-directory.ts`,
 * backing `/admin/blog/posts` and `/admin/blog/pages`'s search/filter/
 * pagination) and `fetchAuthorDisplayNames` (`author-lookup.ts`, backing the
 * "author" column/field on those same screens). None of these are exposed
 * as new JSON API endpoints (no OpenAPI change needed — see the module
 * README), so they are called directly here the same way
 * `blog-content-pages-taxonomy-search.integration.test.ts` calls
 * `searchPublicBlogContent` directly.
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
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as createPost } from "../../src/pages/api/v1/blog/posts/index";
import { PATCH as updatePost } from "../../src/pages/api/v1/blog/posts/[id]";
import { POST as archivePostTransition } from "../../src/pages/api/v1/blog/posts/[id]/archive";
import { POST as createPage } from "../../src/pages/api/v1/blog/pages/index";
import { POST as createTerm } from "../../src/pages/api/v1/blog/terms/index";
import { withTenant } from "../../src/lib/database/tenant-context";
import { getDatabaseClient } from "../../src/lib/database/client";
import { listBlogPostsForAdmin } from "../../src/modules/blog-content/application/blog-post-directory";
import { listBlogPagesForAdmin } from "../../src/modules/blog-content/application/blog-page-directory";
import { fetchAuthorDisplayNames } from "../../src/modules/blog-content/application/author-lookup";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string; tenantUserId: string };

async function bootstrap(
  tenantCode = "acme",
  tenantName = "Acme"
): Promise<Bootstrap> {
  const setup = await invoke<{
    data: { tenantId: string; ownerTenantUserId: string };
  }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName,
      tenantCode,
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: `${tenantCode}-${OWNER_LOGIN}`,
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
    body: {
      loginIdentifier: `${tenantCode}-${OWNER_LOGIN}`,
      password: OWNER_PASSWORD
    },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId: setup.body.data.ownerTenantUserId
  };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

function corePostBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "Hello World",
    slug: "hello-world",
    excerpt: null,
    contentJson: { blocks: [] },
    contentText: "Hello world body.",
    locale: "en",
    ...overrides
  };
}

function corePageBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "About Us",
    slug: "about-us",
    contentJson: { blocks: [] },
    contentText: "About us body.",
    locale: "en",
    ...overrides
  };
}

/**
 * `POST /setup/initialize` is a once-per-database singleton lock — it
 * cannot be called twice to bootstrap two tenants in the same test (same
 * constraint `email-templates.integration.test.ts`'s
 * `provisionSecondTenantWithTemplateReadAccess` and
 * `blog-content-posts-api.integration.test.ts`'s docblock both document).
 * A second tenant is provisioned directly via `getAdminSql()` instead,
 * granted `blog_content.posts.{create,read}` so the RLS-isolation test
 * proves row-level tenant scoping specifically, not an ABAC 403.
 */
async function provisionSecondTenantWithBlogPostAccess(): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const password = "integration-test-tenant-b-password";
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
    VALUES (${tenantId}, 'tenant-b-raw', 'Tenant B Raw')
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
      VALUES (${tenantId}, ${profile[0]!.id}, 'tenant-b-user@example.com', ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    const tenantUser = (await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
    `) as { id: string }[];
    tenantUserId = tenantUser[0]!.id;
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'blog_post_writer', 'Blog Post Writer') RETURNING id
    `) as { id: string }[];
    const permissions = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'blog_content' AND activity_code = 'posts' AND action IN ('create', 'read')
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
  });

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier: "tenant-b-user@example.com", password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, token: login.body.data.token, tenantUserId };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("blog admin UI list/lookup functions (Issue #543)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("listBlogPostsForAdmin: search, status filter, and pagination", async () => {
    const owner = await bootstrap();

    const alpha = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: corePostBody({ title: "Alpha release notes", slug: "alpha-notes" })
    });
    expect(alpha.status).toBe(200);

    const beta = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: corePostBody({
        title: "Beta announcement",
        slug: "beta-announcement"
      })
    });
    expect(beta.status).toBe(200);

    // Move one post to `archived` so the status filter has something to
    // distinguish (draft -> archived is a valid transition).
    const archived = await invoke(archivePostTransition, {
      method: "POST",
      path: `/api/v1/blog/posts/${beta.body.data.id}/archive`,
      params: { id: beta.body.data.id },
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      body: {}
    });
    expect(archived.status).toBe(200);

    const sql = getDatabaseClient();

    // Unfiltered listing sees both posts, newest-updated first.
    const all = await withTenant(sql, owner.tenantId, (tx) =>
      listBlogPostsForAdmin(tx, owner.tenantId, {})
    );
    expect(all.total).toBe(2);
    expect(all.items.map((item) => item.slug).sort()).toEqual([
      "alpha-notes",
      "beta-announcement"
    ]);

    // Search matches title via ILIKE, case-insensitive substring.
    const searched = await withTenant(sql, owner.tenantId, (tx) =>
      listBlogPostsForAdmin(tx, owner.tenantId, { search: "alpha" })
    );
    expect(searched.total).toBe(1);
    expect(searched.items[0]!.slug).toBe("alpha-notes");

    // Status filter isolates the archived post.
    const archivedOnly = await withTenant(sql, owner.tenantId, (tx) =>
      listBlogPostsForAdmin(tx, owner.tenantId, { status: "archived" })
    );
    expect(archivedOnly.total).toBe(1);
    expect(archivedOnly.items[0]!.slug).toBe("beta-announcement");

    // Pagination: pageSize 1 returns one item per page, total stays 2.
    const page1 = await withTenant(sql, owner.tenantId, (tx) =>
      listBlogPostsForAdmin(tx, owner.tenantId, { pageSize: 1, page: 1 })
    );
    const page2 = await withTenant(sql, owner.tenantId, (tx) =>
      listBlogPostsForAdmin(tx, owner.tenantId, { pageSize: 1, page: 2 })
    );
    expect(page1.items).toHaveLength(1);
    expect(page2.items).toHaveLength(1);
    expect(page1.total).toBe(2);
    expect(page2.total).toBe(2);
    expect(page1.items[0]!.id).not.toBe(page2.items[0]!.id);
  });

  test("listBlogPostsForAdmin: termId filter matches only posts assigned that term", async () => {
    const owner = await bootstrap();

    const term = await invoke<{ data: { id: string } }>(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: {
        taxonomyType: "category",
        name: "News",
        slug: "news",
        description: null,
        parentId: null
      }
    });
    expect(term.status).toBe(200);
    const termId = term.body.data.id;

    const tagged = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: corePostBody({
        title: "Tagged post",
        slug: "tagged-post",
        termIds: [termId]
      })
    });
    expect(tagged.status).toBe(200);

    const untagged = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: corePostBody({ title: "Untagged post", slug: "untagged-post" })
    });
    expect(untagged.status).toBe(200);

    const sql = getDatabaseClient();
    const filtered = await withTenant(sql, owner.tenantId, (tx) =>
      listBlogPostsForAdmin(tx, owner.tenantId, { termId })
    );

    expect(filtered.total).toBe(1);
    expect(filtered.items[0]!.slug).toBe("tagged-post");
  });

  test("listBlogPostsForAdmin: tenant isolation (RLS) — one tenant never sees another's posts", async () => {
    const tenantA = await bootstrap();
    const tenantB = await provisionSecondTenantWithBlogPostAccess();

    await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(tenantA),
      body: corePostBody({ title: "Tenant A post", slug: "tenant-a-post" })
    });
    await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(tenantB),
      body: corePostBody({ title: "Tenant B post", slug: "tenant-b-post" })
    });

    const sql = getDatabaseClient();
    const forA = await withTenant(sql, tenantA.tenantId, (tx) =>
      listBlogPostsForAdmin(tx, tenantA.tenantId, {})
    );

    expect(forA.total).toBe(1);
    expect(forA.items[0]!.slug).toBe("tenant-a-post");
  });

  test("listBlogPagesForAdmin: search, status filter, pageType filter, and pagination", async () => {
    const owner = await bootstrap();

    const standard = await invoke<{ data: { id: string } }>(createPage, {
      method: "POST",
      path: "/api/v1/blog/pages",
      headers: authHeaders(owner),
      body: corePageBody({ title: "About the team", slug: "about-team" })
    });
    expect(standard.status).toBe(200);

    const legal = await invoke<{ data: { id: string } }>(createPage, {
      method: "POST",
      path: "/api/v1/blog/pages",
      headers: authHeaders(owner),
      body: corePageBody({
        title: "Privacy policy",
        slug: "privacy-policy",
        pageType: "legal"
      })
    });
    expect(legal.status).toBe(200);

    const sql = getDatabaseClient();

    const all = await withTenant(sql, owner.tenantId, (tx) =>
      listBlogPagesForAdmin(tx, owner.tenantId, {})
    );
    expect(all.total).toBe(2);

    const searched = await withTenant(sql, owner.tenantId, (tx) =>
      listBlogPagesForAdmin(tx, owner.tenantId, { search: "privacy" })
    );
    expect(searched.total).toBe(1);
    expect(searched.items[0]!.slug).toBe("privacy-policy");

    const legalOnly = await withTenant(sql, owner.tenantId, (tx) =>
      listBlogPagesForAdmin(tx, owner.tenantId, { pageType: "legal" })
    );
    expect(legalOnly.total).toBe(1);
    expect(legalOnly.items[0]!.slug).toBe("privacy-policy");

    const draftOnly = await withTenant(sql, owner.tenantId, (tx) =>
      listBlogPagesForAdmin(tx, owner.tenantId, { status: "draft" })
    );
    expect(draftOnly.total).toBe(2);

    const page1 = await withTenant(sql, owner.tenantId, (tx) =>
      listBlogPagesForAdmin(tx, owner.tenantId, { pageSize: 1, page: 1 })
    );
    expect(page1.items).toHaveLength(1);
    expect(page1.total).toBe(2);
  });

  test("fetchAuthorDisplayNames: resolves known tenant-user ids, omits unknown ones", async () => {
    const owner = await bootstrap();

    const sql = getDatabaseClient();
    const names = await withTenant(sql, owner.tenantId, (tx) =>
      fetchAuthorDisplayNames(tx, owner.tenantId, [
        owner.tenantUserId,
        "00000000-0000-0000-0000-000000000000"
      ])
    );

    expect(names.get(owner.tenantUserId)).toBe("Owner");
    expect(names.has("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  test("fetchAuthorDisplayNames: empty id list returns an empty map without querying", async () => {
    const owner = await bootstrap();

    const sql = getDatabaseClient();
    const names = await withTenant(sql, owner.tenantId, (tx) =>
      fetchAuthorDisplayNames(tx, owner.tenantId, [])
    );

    expect(names.size).toBe(0);
  });

  test("listBlogPostsForAdmin PATCH-updated title is searchable immediately", async () => {
    const owner = await bootstrap();

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: corePostBody({ title: "Original title", slug: "original-title" })
    });
    expect(created.status).toBe(200);

    const updated = await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${created.body.data.id}`,
      headers: authHeaders(owner),
      params: { id: created.body.data.id },
      body: { title: "Renamed title" }
    });
    expect(updated.status).toBe(200);

    const sql = getDatabaseClient();
    const searched = await withTenant(sql, owner.tenantId, (tx) =>
      listBlogPostsForAdmin(tx, owner.tenantId, { search: "Renamed" })
    );

    expect(searched.total).toBe(1);
    expect(searched.items[0]!.title).toBe("Renamed title");
  });
});
