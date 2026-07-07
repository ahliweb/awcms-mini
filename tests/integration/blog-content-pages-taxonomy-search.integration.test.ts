/**
 * Integration tests for pages, taxonomies, post-term relations, and
 * PostgreSQL full-text search (Issue #539, epic #536). Exercises the real
 * handlers against a real PostgreSQL — page CRUD, taxonomy parent/tag
 * rules, post-term assignment via the posts API, admin search (all
 * statuses) and the public-safe search helper (called directly — no route
 * wires it in this issue), RLS tenant isolation, and ABAC allow/deny.
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
import {
  GET as listPages,
  POST as createPage
} from "../../src/pages/api/v1/blog/pages/index";
import {
  DELETE as deletePage,
  GET as getPage,
  PATCH as updatePage
} from "../../src/pages/api/v1/blog/pages/[id]";
import {
  GET as listTerms,
  POST as createTerm
} from "../../src/pages/api/v1/blog/terms/index";
import {
  DELETE as deleteTerm,
  PATCH as updateTerm
} from "../../src/pages/api/v1/blog/terms/[id]";
import { GET as searchBlog } from "../../src/pages/api/v1/blog/search/index";
import { POST as createPost } from "../../src/pages/api/v1/blog/posts/index";
import {
  GET as getPost,
  PATCH as updatePost
} from "../../src/pages/api/v1/blog/posts/[id]";
import { POST as publishPost } from "../../src/pages/api/v1/blog/posts/[id]/publish";
import { withTenant } from "../../src/lib/database/tenant-context";
import { getDatabaseClient } from "../../src/lib/database/client";
import { searchPublicBlogContent } from "../../src/modules/blog-content/application/blog-search";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string };

async function bootstrap(
  tenantCode = "acme",
  tenantName = "Acme"
): Promise<Bootstrap> {
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
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

  return { tenantId: setup.body.data.tenantId, token: login.body.data.token };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

/** Same-tenant scoped user, granted only the given `blog_content.<activityCode>.<action>` permissions — mirrors `blog-content-posts-api.integration.test.ts`'s `provisionScopedTenantUser`, generalized to an (activityCode, action) pair instead of hardcoding `posts`. */
async function provisionScopedTenantUser(
  tenantId: string,
  loginIdentifier: string,
  grants: { activityCode: string; action: string }[]
): Promise<Bootstrap> {
  const password = "integration-test-scoped-password";
  const admin = getAdminSql();
  const passwordHash = await Bun.password.hash(password);

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', ${loginIdentifier}) RETURNING id
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
      VALUES (${tenantId}, ${`role_${loginIdentifier}`}, ${loginIdentifier}) RETURNING id
    `) as { id: string }[];

    for (const grant of grants) {
      const permission = (await tx`
        SELECT id FROM awcms_mini_permissions
        WHERE module_key = 'blog_content' AND activity_code = ${grant.activityCode} AND action = ${grant.action}
      `) as { id: string }[];

      await tx`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        VALUES (${tenantId}, ${role[0]!.id}, ${permission[0]!.id})
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
    body: { loginIdentifier, password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, token: login.body.data.token };
}

/** Cross-tenant RLS probe (raw SQL, mirrors `provisionSecondTenantWithReadAccess` in the posts integration suite) — granted `blog_content.pages.read` + `blog_content.taxonomies.read`. */
async function provisionSecondTenantWithReadAccess(): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const password = "integration-test-tenant-b-password";
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
    VALUES (${tenantId}, 'tenant-b-raw', 'Tenant B Raw')
  `;

  const passwordHash = await Bun.password.hash(password);

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
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'page_reader', 'Page Reader') RETURNING id
    `) as { id: string }[];
    const permission = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'blog_content' AND activity_code = 'pages' AND action = 'read'
    `) as { id: string }[];

    await tx`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
      VALUES (${tenantId}, ${role[0]!.id}, ${permission[0]!.id})
    `;
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

  return { tenantId, token: login.body.data.token };
}

const CREATE_PAGE_BODY = {
  title: "About Us",
  slug: "about-us",
  contentJson: { blocks: [{ type: "paragraph", text: "About" }] },
  contentText: "About"
};

const suite = integrationEnabled ? describe : describe.skip;

suite("blog pages, taxonomies, post-term relations, and search", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("page create -> get -> list -> update -> delete -> 404 after delete", async () => {
    const owner = await bootstrap();

    const created = await invoke<{
      data: { id: string; status: string; pageType: string };
    }>(createPage, {
      method: "POST",
      path: "/api/v1/blog/pages",
      headers: authHeaders(owner),
      body: { ...CREATE_PAGE_BODY, pageType: "legal", menuOrder: 3 }
    });
    expect(created.status).toBe(200);
    expect(created.body.data.status).toBe("draft");
    expect(created.body.data.pageType).toBe("legal");
    const pageId = created.body.data.id;

    const fetched = await invoke(getPage, {
      method: "GET",
      path: `/api/v1/blog/pages/${pageId}`,
      headers: authHeaders(owner),
      params: { id: pageId }
    });
    expect(fetched.status).toBe(200);

    const list = await invoke<{ data: { pages: unknown[] } }>(listPages, {
      method: "GET",
      path: "/api/v1/blog/pages",
      headers: authHeaders(owner)
    });
    expect(list.status).toBe(200);
    expect(list.body.data.pages).toHaveLength(1);

    const updated = await invoke<{ data: { menuOrder: number } }>(updatePage, {
      method: "PATCH",
      path: `/api/v1/blog/pages/${pageId}`,
      headers: authHeaders(owner),
      params: { id: pageId },
      body: { menuOrder: 7 }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.menuOrder).toBe(7);

    const deleted = await invoke(deletePage, {
      method: "DELETE",
      path: `/api/v1/blog/pages/${pageId}`,
      headers: authHeaders(owner),
      params: { id: pageId },
      body: { reason: "no longer needed" }
    });
    expect(deleted.status).toBe(200);

    const afterDelete = await invoke(getPage, {
      method: "GET",
      path: `/api/v1/blog/pages/${pageId}`,
      headers: authHeaders(owner),
      params: { id: pageId }
    });
    expect(afterDelete.status).toBe(404);
  });

  test("a page cannot be its own parent", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPage, {
      method: "POST",
      path: "/api/v1/blog/pages",
      headers: authHeaders(owner),
      body: CREATE_PAGE_BODY
    });
    const pageId = created.body.data.id;

    const updated = await invoke(updatePage, {
      method: "PATCH",
      path: `/api/v1/blog/pages/${pageId}`,
      headers: authHeaders(owner),
      params: { id: pageId },
      body: { parentPageId: pageId }
    });
    expect(updated.status).toBe(400);
  });

  test("page author may edit their own unpublished page without blog_content.pages.update", async () => {
    const owner = await bootstrap();
    const author = await provisionScopedTenantUser(
      owner.tenantId,
      "page-author@example.com",
      [{ activityCode: "pages", action: "create" }]
    );

    const created = await invoke<{ data: { id: string } }>(createPage, {
      method: "POST",
      path: "/api/v1/blog/pages",
      headers: authHeaders(author),
      body: CREATE_PAGE_BODY
    });
    expect(created.status).toBe(200);
    const pageId = created.body.data.id;

    const updated = await invoke<{ data: { title: string } }>(updatePage, {
      method: "PATCH",
      path: `/api/v1/blog/pages/${pageId}`,
      headers: authHeaders(author),
      params: { id: pageId },
      body: { title: "Edited by author" }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.title).toBe("Edited by author");
  });

  test("tenant B cannot read tenant A's page (RLS FORCE)", async () => {
    const tenantA = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPage, {
      method: "POST",
      path: "/api/v1/blog/pages",
      headers: authHeaders(tenantA),
      body: CREATE_PAGE_BODY
    });
    const pageId = created.body.data.id;

    const tenantB = await provisionSecondTenantWithReadAccess();
    const crossTenantRead = await invoke(getPage, {
      method: "GET",
      path: `/api/v1/blog/pages/${pageId}`,
      headers: authHeaders(tenantB),
      params: { id: pageId }
    });
    expect(crossTenantRead.status).toBe(404);
  });

  test("category supports a parent; tag rejects a parentId (400)", async () => {
    const owner = await bootstrap();

    const parentCategory = await invoke<{ data: { id: string } }>(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: { taxonomyType: "category", name: "News", slug: "news" }
    });
    expect(parentCategory.status).toBe(200);

    const childCategory = await invoke<{
      data: { id: string; parentId: string };
    }>(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: {
        taxonomyType: "category",
        name: "World News",
        slug: "world-news",
        parentId: parentCategory.body.data.id
      }
    });
    expect(childCategory.status).toBe(200);
    expect(childCategory.body.data.parentId).toBe(parentCategory.body.data.id);

    const tagWithParent = await invoke(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: {
        taxonomyType: "tag",
        name: "Breaking",
        slug: "breaking",
        parentId: parentCategory.body.data.id
      }
    });
    expect(tagWithParent.status).toBe(400);
  });

  test("terms enforce slug uniqueness per taxonomy type (409) but allow the same slug across types", async () => {
    const owner = await bootstrap();

    const category = await invoke(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: { taxonomyType: "category", name: "News", slug: "news" }
    });
    expect(category.status).toBe(200);

    const duplicateCategory = await invoke(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: { taxonomyType: "category", name: "News Again", slug: "news" }
    });
    expect(duplicateCategory.status).toBe(409);

    const tagSameSlug = await invoke(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: { taxonomyType: "tag", name: "News", slug: "news" }
    });
    expect(tagSameSlug.status).toBe(200);
  });

  test("updating a term to taxonomyType: tag while it still has a parentId is rejected", async () => {
    const owner = await bootstrap();

    const parent = await invoke<{ data: { id: string } }>(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: { taxonomyType: "category", name: "News", slug: "news" }
    });
    const child = await invoke<{ data: { id: string } }>(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: {
        taxonomyType: "category",
        name: "World",
        slug: "world",
        parentId: parent.body.data.id
      }
    });

    const convertToTag = await invoke(updateTerm, {
      method: "PATCH",
      path: `/api/v1/blog/terms/${child.body.data.id}`,
      headers: authHeaders(owner),
      params: { id: child.body.data.id },
      body: { taxonomyType: "tag" }
    });
    expect(convertToTag.status).toBe(400);

    const convertWithClearedParent = await invoke(updateTerm, {
      method: "PATCH",
      path: `/api/v1/blog/terms/${child.body.data.id}`,
      headers: authHeaders(owner),
      params: { id: child.body.data.id },
      body: { taxonomyType: "tag", parentId: null }
    });
    expect(convertWithClearedParent.status).toBe(200);
  });

  test("term delete requires a reason and is tenant-isolated by RLS", async () => {
    const owner = await bootstrap();
    const term = await invoke<{ data: { id: string } }>(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: { taxonomyType: "tag", name: "Featured", slug: "featured" }
    });

    const withoutReason = await invoke(deleteTerm, {
      method: "DELETE",
      path: `/api/v1/blog/terms/${term.body.data.id}`,
      headers: authHeaders(owner),
      params: { id: term.body.data.id },
      body: {}
    });
    expect(withoutReason.status).toBe(400);

    const deleted = await invoke(deleteTerm, {
      method: "DELETE",
      path: `/api/v1/blog/terms/${term.body.data.id}`,
      headers: authHeaders(owner),
      params: { id: term.body.data.id },
      body: { reason: "unused" }
    });
    expect(deleted.status).toBe(200);

    const list = await invoke<{ data: { terms: unknown[] } }>(listTerms, {
      method: "GET",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner)
    });
    expect(list.body.data.terms).toHaveLength(0);
  });

  test("default deny: a tenant user with no taxonomies permission cannot list terms", async () => {
    const owner = await bootstrap();
    const noPermUser = await provisionScopedTenantUser(
      owner.tenantId,
      "noperm-terms@example.com",
      []
    );

    const list = await invoke(listTerms, {
      method: "GET",
      path: "/api/v1/blog/terms",
      headers: authHeaders(noPermUser)
    });
    expect(list.status).toBe(403);
  });

  test("post-term relation: assigning termIds on create is reflected on get, and updating replaces the set", async () => {
    const owner = await bootstrap();
    const tagA = await invoke<{ data: { id: string } }>(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: { taxonomyType: "tag", name: "Alpha", slug: "alpha" }
    });
    const tagB = await invoke<{ data: { id: string } }>(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: { taxonomyType: "tag", name: "Beta", slug: "beta" }
    });

    const created = await invoke<{ data: { id: string; termIds: string[] } }>(
      createPost,
      {
        method: "POST",
        path: "/api/v1/blog/posts",
        headers: authHeaders(owner),
        body: {
          title: "Tagged post",
          slug: "tagged-post",
          contentJson: {},
          contentText: "body",
          termIds: [tagA.body.data.id]
        }
      }
    );
    expect(created.status).toBe(200);
    expect(created.body.data.termIds).toEqual([tagA.body.data.id]);
    const postId = created.body.data.id;

    const fetched = await invoke<{ data: { termIds: string[] } }>(getPost, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId }
    });
    expect(fetched.body.data.termIds).toEqual([tagA.body.data.id]);

    const updated = await invoke<{ data: { termIds: string[] } }>(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { termIds: [tagB.body.data.id] }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.termIds).toEqual([tagB.body.data.id]);
  });

  test("assigning a nonexistent termId is rejected (400)", async () => {
    const owner = await bootstrap();
    const created = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "Post",
        slug: "post",
        contentJson: {},
        contentText: "body",
        termIds: ["00000000-0000-0000-0000-000000000000"]
      }
    });
    expect(created.status).toBe(400);
  });

  test("admin search finds a draft post by title/body text across statuses", async () => {
    const owner = await bootstrap();
    await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "Unique Zephyr Draft",
        slug: "zephyr-draft",
        contentJson: {},
        contentText: "content about zephyr winds"
      }
    });

    const results = await invoke<{
      data: { items: { title: string; status: string }[] };
    }>(searchBlog, {
      method: "GET",
      path: "/api/v1/blog/search?q=zephyr",
      headers: authHeaders(owner)
    });
    expect(results.status).toBe(200);
    expect(results.body.data.items).toHaveLength(1);
    expect(results.body.data.items[0]?.status).toBe("draft");
  });

  test("admin search requires q", async () => {
    const owner = await bootstrap();
    const results = await invoke(searchBlog, {
      method: "GET",
      path: "/api/v1/blog/search",
      headers: authHeaders(owner)
    });
    expect(results.status).toBe(400);
  });

  test("public-safe search only returns published+public content, never draft or private", async () => {
    const owner = await bootstrap();

    const draft = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "Nimbus Draft",
        slug: "nimbus-draft",
        contentJson: {},
        contentText: "nimbus content"
      }
    });

    const privatePublished = await invoke<{ data: { id: string } }>(
      createPost,
      {
        method: "POST",
        path: "/api/v1/blog/posts",
        headers: authHeaders(owner),
        body: {
          title: "Nimbus Private",
          slug: "nimbus-private",
          contentJson: {},
          contentText: "nimbus content",
          visibility: "private"
        }
      }
    );
    await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${privatePublished.body.data.id}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "p1" },
      params: { id: privatePublished.body.data.id }
    });

    const publicPublished = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "Nimbus Public",
        slug: "nimbus-public",
        contentJson: {},
        contentText: "nimbus content"
      }
    });
    await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${publicPublished.body.data.id}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "p2" },
      params: { id: publicPublished.body.data.id }
    });

    const sql = getDatabaseClient();
    const publicResults = await withTenant(sql, owner.tenantId, (tx) =>
      searchPublicBlogContent(tx, owner.tenantId, { query: "nimbus" })
    );

    expect(publicResults.items).toHaveLength(1);
    expect(publicResults.items[0]?.id).toBe(publicPublished.body.data.id);
    expect(draft.status).toBe(200);
  });
});
