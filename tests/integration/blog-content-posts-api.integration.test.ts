/**
 * Integration tests for the blog post admin API (Issue #538, epic #536).
 * Exercises the real handlers against a real PostgreSQL — CRUD, lifecycle
 * actions, ABAC (role permission + author-own-draft override), idempotency,
 * audit, and cross-tenant RLS denial. Builds on the schema/permission
 * foundation from Issue #537 (migrations 026/027).
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
  GET as listPosts,
  POST as createPost
} from "../../src/pages/api/v1/blog/posts/index";
import {
  DELETE as deletePost,
  GET as getPost,
  PATCH as updatePost
} from "../../src/pages/api/v1/blog/posts/[id]";
import { POST as submitReview } from "../../src/pages/api/v1/blog/posts/[id]/submit-review";
import { POST as publishPost } from "../../src/pages/api/v1/blog/posts/[id]/publish";
import { POST as archivePost } from "../../src/pages/api/v1/blog/posts/[id]/archive";
import { POST as restorePost } from "../../src/pages/api/v1/blog/posts/[id]/restore";
import { POST as purgePost } from "../../src/pages/api/v1/blog/posts/[id]/purge";

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

/**
 * Provisions a second tenant user *within the same tenant*, granted only
 * the given `blog_content.posts.<action>` permissions — used to exercise
 * the "author may edit their own draft without the update permission"
 * ABAC override, and to prove a plain author cannot publish. Mirrors
 * `email-templates.integration.test.ts`'s
 * `provisionSecondTenantWithTemplateReadAccess` pattern but scoped to an
 * arbitrary permission list and the same tenant.
 */
async function provisionScopedTenantUser(
  tenantId: string,
  loginIdentifier: string,
  actions: string[]
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

    for (const action of actions) {
      const permission = (await tx`
        SELECT id FROM awcms_mini_permissions
        WHERE module_key = 'blog_content' AND activity_code = 'posts' AND action = ${action}
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

/**
 * `POST /setup/initialize` is a once-per-database singleton lock — it
 * cannot be called twice to bootstrap two tenants in the same test (same
 * constraint `email-templates.integration.test.ts` documents). A second
 * tenant with `blog_content.posts.read` is provisioned directly instead,
 * to prove RLS isolation specifically, not an ABAC 403.
 */
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
      VALUES (${tenantId}, 'post_reader', 'Post Reader') RETURNING id
    `) as { id: string }[];
    const permission = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'blog_content' AND activity_code = 'posts' AND action = 'read'
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

const CREATE_BODY = {
  title: "Hello World",
  slug: "hello-world",
  contentJson: { blocks: [{ type: "paragraph", text: "Hello" }] },
  contentText: "Hello"
};

const suite = integrationEnabled ? describe : describe.skip;

suite("blog post admin API", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("create -> get -> list -> update -> delete -> 404 after delete", async () => {
    const owner = await bootstrap();

    const created = await invoke<{ data: { id: string; status: string } }>(
      createPost,
      {
        method: "POST",
        path: "/api/v1/blog/posts",
        headers: authHeaders(owner),
        body: CREATE_BODY
      }
    );
    expect(created.status).toBe(200);
    expect(created.body.data.status).toBe("draft");
    const postId = created.body.data.id;

    const fetched = await invoke(getPost, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId }
    });
    expect(fetched.status).toBe(200);

    const list = await invoke<{ data: { posts: unknown[] } }>(listPosts, {
      method: "GET",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner)
    });
    expect(list.status).toBe(200);
    expect(list.body.data.posts).toHaveLength(1);

    const updated = await invoke<{ data: { title: string } }>(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { title: "Updated title" }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.title).toBe("Updated title");

    const deleted = await invoke(deletePost, {
      method: "DELETE",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { reason: "no longer needed" }
    });
    expect(deleted.status).toBe(200);

    const afterDelete = await invoke(getPost, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId }
    });
    expect(afterDelete.status).toBe(404);
  });

  test("rejects unsafe HTML in contentText", async () => {
    const owner = await bootstrap();

    const created = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: { ...CREATE_BODY, contentText: "<script>alert(1)</script>" }
    });
    expect(created.status).toBe(400);
  });

  test("creating a duplicate slug+locale conflicts (409)", async () => {
    const owner = await bootstrap();
    const first = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    expect(first.status).toBe(200);

    const duplicate = await invoke(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    expect(duplicate.status).toBe(409);
  });

  test("DELETE without a reason is rejected", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });

    const deleted = await invoke(deletePost, {
      method: "DELETE",
      path: `/api/v1/blog/posts/${created.body.data.id}`,
      headers: authHeaders(owner),
      params: { id: created.body.data.id },
      body: {}
    });
    expect(deleted.status).toBe(400);
  });

  test("full lifecycle: draft -> review -> published -> archived, each writes an audit event", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    const review = await invoke<{ data: { status: string } }>(submitReview, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/submit-review`,
      headers: authHeaders(owner),
      params: { id: postId }
    });
    expect(review.status).toBe(200);
    expect(review.body.data.status).toBe("review");

    const published = await invoke<{
      data: { status: string; publishedAt: string };
    }>(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-key-1" },
      params: { id: postId }
    });
    expect(published.status).toBe(200);
    expect(published.body.data.status).toBe("published");
    expect(published.body.data.publishedAt).not.toBeNull();

    const archived = await invoke<{ data: { status: string } }>(archivePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/archive`,
      headers: { ...authHeaders(owner), "idempotency-key": "archive-key-1" },
      params: { id: postId }
    });
    expect(archived.status).toBe(200);
    expect(archived.body.data.status).toBe("archived");

    const admin = getAdminSql();
    const auditRows = (await admin`
      SELECT action FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND resource_id = ${postId}
      ORDER BY created_at ASC
    `) as { action: string }[];

    expect(auditRows.map((row) => row.action)).toEqual([
      "blog.post.created",
      "blog.post.submitted_for_review",
      "blog.post.published",
      "blog.post.archived"
    ]);
  });

  test("publish rejects an invalid status transition (archived -> published)", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    await invoke(archivePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/archive`,
      headers: { ...authHeaders(owner), "idempotency-key": "archive-key-1" },
      params: { id: postId }
    });

    const publishAfterArchive = await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-key-1" },
      params: { id: postId }
    });
    expect(publishAfterArchive.status).toBe(409);
  });

  test("publish requires Idempotency-Key", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });

    const published = await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${created.body.data.id}/publish`,
      headers: authHeaders(owner),
      params: { id: created.body.data.id }
    });
    expect(published.status).toBe(400);
  });

  test("publish replays the same response for a repeated Idempotency-Key and writes only one audit event", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;
    const headers = { ...authHeaders(owner), "idempotency-key": "replay-key" };

    const first = await invoke<{ data: { publishedAt: string } }>(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers,
      params: { id: postId }
    });
    expect(first.status).toBe(200);

    const second = await invoke<{ data: { publishedAt: string } }>(
      publishPost,
      {
        method: "POST",
        path: `/api/v1/blog/posts/${postId}/publish`,
        headers,
        params: { id: postId }
      }
    );
    expect(second.status).toBe(200);
    expect(second.body.data.publishedAt).toBe(first.body.data.publishedAt);

    const admin = getAdminSql();
    const auditRows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND resource_id = ${postId} AND action = 'blog.post.published'
    `) as { count: number }[];
    expect(auditRows[0]?.count).toBe(1);
  });

  test("reusing an Idempotency-Key with a different request conflicts (409)", async () => {
    const owner = await bootstrap();
    const first = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const second = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: { ...CREATE_BODY, slug: "hello-world-2" }
    });

    const headers = { ...authHeaders(owner), "idempotency-key": "shared-key" };
    const publishFirst = await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${first.body.data.id}/publish`,
      headers,
      params: { id: first.body.data.id }
    });
    expect(publishFirst.status).toBe(200);

    const publishSecond = await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${second.body.data.id}/publish`,
      headers,
      params: { id: second.body.data.id }
    });
    expect(publishSecond.status).toBe(409);
  });

  test("purge is forbidden until the post is archived or soft-deleted", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    const publishHeaders = { ...authHeaders(owner), "idempotency-key": "p1" };
    await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: publishHeaders,
      params: { id: postId }
    });

    const purgeBlocked = await invoke(purgePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/purge`,
      headers: { ...authHeaders(owner), "idempotency-key": "purge-1" },
      params: { id: postId }
    });
    expect(purgeBlocked.status).toBe(409);

    const archived = await invoke(archivePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/archive`,
      headers: { ...authHeaders(owner), "idempotency-key": "a1" },
      params: { id: postId }
    });
    expect(archived.status).toBe(200);

    const purgeAllowed = await invoke(purgePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/purge`,
      headers: { ...authHeaders(owner), "idempotency-key": "purge-2" },
      params: { id: postId }
    });
    expect(purgeAllowed.status).toBe(200);

    const afterPurge = await invoke(getPost, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId }
    });
    expect(afterPurge.status).toBe(404);
  });

  test("restore requires the post to be currently soft-deleted", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    const restoreNotDeleted = await invoke(restorePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/restore`,
      headers: { ...authHeaders(owner), "idempotency-key": "r1" },
      params: { id: postId }
    });
    expect(restoreNotDeleted.status).toBe(404);

    await invoke(deletePost, {
      method: "DELETE",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { reason: "test" }
    });

    const restored = await invoke(restorePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/restore`,
      headers: { ...authHeaders(owner), "idempotency-key": "r2" },
      params: { id: postId }
    });
    expect(restored.status).toBe(200);
  });

  test("tenant B cannot read tenant A's post (RLS FORCE)", async () => {
    const tenantA = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(tenantA),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    const tenantB = await provisionSecondTenantWithReadAccess();
    const crossTenantRead = await invoke(getPost, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(tenantB),
      params: { id: postId }
    });

    expect(crossTenantRead.status).toBe(404);
  });

  test("author may update their own unpublished draft without blog_content.posts.update", async () => {
    const owner = await bootstrap();
    const author = await provisionScopedTenantUser(
      owner.tenantId,
      "author@example.com",
      ["create"]
    );

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(author),
      body: CREATE_BODY
    });
    expect(created.status).toBe(200);
    const postId = created.body.data.id;

    const updated = await invoke<{ data: { title: string } }>(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(author),
      params: { id: postId },
      body: { title: "Edited by author" }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.title).toBe("Edited by author");
  });

  test("a non-author without blog_content.posts.update cannot edit someone else's draft", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    const bystander = await provisionScopedTenantUser(
      owner.tenantId,
      "bystander@example.com",
      ["read"]
    );

    const updated = await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(bystander),
      params: { id: postId },
      body: { title: "Hijacked" }
    });
    expect(updated.status).toBe(403);
  });

  test("an author cannot publish without blog_content.posts.publish, even for their own post", async () => {
    const owner = await bootstrap();
    const author = await provisionScopedTenantUser(
      owner.tenantId,
      "author2@example.com",
      ["create"]
    );

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(author),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    const published = await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(author), "idempotency-key": "author-publish" },
      params: { id: postId }
    });
    expect(published.status).toBe(403);
  });

  test("an author cannot edit their own post once it is published", async () => {
    const owner = await bootstrap();
    const author = await provisionScopedTenantUser(
      owner.tenantId,
      "author3@example.com",
      ["create"]
    );

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(author),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "owner-publish" },
      params: { id: postId }
    });

    const updated = await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(author),
      params: { id: postId },
      body: { title: "Trying to edit published post" }
    });
    expect(updated.status).toBe(403);
  });

  test("default deny: a tenant user with no blog_content permissions cannot list posts", async () => {
    const owner = await bootstrap();
    const noPermUser = await provisionScopedTenantUser(
      owner.tenantId,
      "noperm@example.com",
      []
    );

    const list = await invoke(listPosts, {
      method: "GET",
      path: "/api/v1/blog/posts",
      headers: authHeaders(noPermUser)
    });
    expect(list.status).toBe(403);
  });
});
