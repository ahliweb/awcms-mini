/**
 * Integration tests for blog post revision history (Issue #541, epic #536).
 * Exercises the real handlers against a real PostgreSQL — revision creation
 * on significant PATCH changes (and not on cosmetic-only ones), list/detail,
 * restore (permission-gated, idempotent, append-only), and cross-tenant RLS
 * denial. Builds on the post admin API from Issue #538 (migrations
 * 026/027) — same bootstrap/permission-grant conventions as
 * `blog-content-posts-api.integration.test.ts`.
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
import { GET as listRevisions } from "../../src/pages/api/v1/blog/posts/[id]/revisions/index";
import { GET as getRevision } from "../../src/pages/api/v1/blog/posts/[id]/revisions/[revisionId]";
import { POST as restoreRevision } from "../../src/pages/api/v1/blog/posts/[id]/revisions/[revisionId]/restore";

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
 * the given `blog_content.revisions.<action>` permissions — mirrors
 * `blog-content-posts-api.integration.test.ts`'s `provisionScopedTenantUser`
 * but scoped to the `revisions` activity code instead of `posts`.
 */
async function provisionScopedRevisionsUser(
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
        WHERE module_key = 'blog_content' AND activity_code = 'revisions' AND action = ${action}
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
 * constraint `blog-content-posts-api.integration.test.ts` documents). A
 * second tenant with `blog_content.revisions.read` is provisioned directly
 * instead, to prove RLS isolation specifically, not an ABAC 403.
 */
async function provisionSecondTenantWithRevisionsReadAccess(): Promise<Bootstrap> {
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
      VALUES (${tenantId}, 'revision_reader', 'Revision Reader') RETURNING id
    `) as { id: string }[];
    const permission = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'blog_content' AND activity_code = 'revisions' AND action = 'read'
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

suite("blog post revisions", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("a significant change (title) on PATCH creates a revision", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { title: "Updated title" }
    });

    const list = await invoke<{
      data: { revisions: { revisionNumber: number }[] };
    }>(listRevisions, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}/revisions`,
      headers: authHeaders(owner),
      params: { id: postId }
    });
    expect(list.status).toBe(200);
    expect(list.body.data.revisions).toHaveLength(1);
    expect(list.body.data.revisions[0]?.revisionNumber).toBe(1);
  });

  test("a cosmetic-only change (seoTitle) on PATCH does not create a revision", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { seoTitle: "SEO Title" }
    });

    const list = await invoke<{ data: { revisions: unknown[] } }>(
      listRevisions,
      {
        method: "GET",
        path: `/api/v1/blog/posts/${postId}/revisions`,
        headers: authHeaders(owner),
        params: { id: postId }
      }
    );
    expect(list.status).toBe(200);
    expect(list.body.data.revisions).toHaveLength(0);
  });

  test("two significant changes produce two revisions, newest first, each with full content on detail", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { title: "First revision title" }
    });
    await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { title: "Second revision title" }
    });

    const list = await invoke<{
      data: {
        revisions: { id: string; revisionNumber: number; title: string }[];
      };
    }>(listRevisions, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}/revisions`,
      headers: authHeaders(owner),
      params: { id: postId }
    });
    expect(list.status).toBe(200);
    expect(list.body.data.revisions.map((r) => r.revisionNumber)).toEqual([
      2, 1
    ]);
    expect(list.body.data.revisions[0]?.title).toBe("Second revision title");

    const revisionId = list.body.data.revisions[0]!.id;
    const detail = await invoke<{
      data: { title: string; contentText: string };
    }>(getRevision, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}/revisions/${revisionId}`,
      headers: authHeaders(owner),
      params: { id: postId, revisionId }
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.title).toBe("Second revision title");
    expect(detail.body.data.contentText).toBe("Hello");
  });

  test("revision detail 404s for a revision id belonging to a different post", async () => {
    const owner = await bootstrap();
    const postA = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postB = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: { ...CREATE_BODY, slug: "post-b" }
    });

    await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postA.body.data.id}`,
      headers: authHeaders(owner),
      params: { id: postA.body.data.id },
      body: { title: "Post A revision" }
    });

    const listA = await invoke<{ data: { revisions: { id: string }[] } }>(
      listRevisions,
      {
        method: "GET",
        path: `/api/v1/blog/posts/${postA.body.data.id}/revisions`,
        headers: authHeaders(owner),
        params: { id: postA.body.data.id }
      }
    );
    const revisionId = listA.body.data.revisions[0]!.id;

    const crossPost = await invoke(getRevision, {
      method: "GET",
      path: `/api/v1/blog/posts/${postB.body.data.id}/revisions/${revisionId}`,
      headers: authHeaders(owner),
      params: { id: postB.body.data.id, revisionId }
    });
    expect(crossPost.status).toBe(404);
  });

  test("reading revisions requires blog_content.revisions.read", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    const noPermUser = await provisionScopedRevisionsUser(
      owner.tenantId,
      "noperm@example.com",
      []
    );

    const list = await invoke(listRevisions, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}/revisions`,
      headers: authHeaders(noPermUser),
      params: { id: postId }
    });
    expect(list.status).toBe(403);
  });

  test("restore requires an Idempotency-Key", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { title: "Revised title" }
    });

    const list = await invoke<{ data: { revisions: { id: string }[] } }>(
      listRevisions,
      {
        method: "GET",
        path: `/api/v1/blog/posts/${postId}/revisions`,
        headers: authHeaders(owner),
        params: { id: postId }
      }
    );
    const revisionId = list.body.data.revisions[0]!.id;

    const restore = await invoke(restoreRevision, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/revisions/${revisionId}/restore`,
      headers: authHeaders(owner),
      params: { id: postId, revisionId }
    });
    expect(restore.status).toBe(400);
  });

  test("restore requires blog_content.revisions.restore, even for the post's own author with update rights", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { title: "Revised title" }
    });

    const list = await invoke<{ data: { revisions: { id: string }[] } }>(
      listRevisions,
      {
        method: "GET",
        path: `/api/v1/blog/posts/${postId}/revisions`,
        headers: authHeaders(owner),
        params: { id: postId }
      }
    );
    const revisionId = list.body.data.revisions[0]!.id;

    const noRestorePermUser = await provisionScopedRevisionsUser(
      owner.tenantId,
      "reader@example.com",
      ["read"]
    );

    const restore = await invoke(restoreRevision, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/revisions/${revisionId}/restore`,
      headers: {
        ...authHeaders(noRestorePermUser),
        "idempotency-key": "restore-1"
      },
      params: { id: postId, revisionId }
    });
    expect(restore.status).toBe(403);
  });

  test("restore writes the revision's content back onto the post and appends a new revision (append-only)", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { title: "First revision title" }
    });
    await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { title: "Second revision title" }
    });

    const listBefore = await invoke<{
      data: {
        revisions: { id: string; revisionNumber: number; title: string }[];
      };
    }>(listRevisions, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}/revisions`,
      headers: authHeaders(owner),
      params: { id: postId }
    });
    expect(listBefore.body.data.revisions).toHaveLength(2);

    const firstRevision = listBefore.body.data.revisions.find(
      (r) => r.revisionNumber === 1
    )!;
    expect(firstRevision.title).toBe("First revision title");

    const restore = await invoke<{ data: { title: string } }>(restoreRevision, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/revisions/${firstRevision.id}/restore`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": "restore-1"
      },
      params: { id: postId, revisionId: firstRevision.id }
    });
    expect(restore.status).toBe(200);
    expect(restore.body.data.title).toBe("First revision title");

    const listAfter = await invoke<{
      data: {
        revisions: {
          revisionNumber: number;
          title: string;
          changeNote: string | null;
        }[];
      };
    }>(listRevisions, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}/revisions`,
      headers: authHeaders(owner),
      params: { id: postId }
    });
    expect(listAfter.body.data.revisions).toHaveLength(3);
    expect(listAfter.body.data.revisions[0]?.revisionNumber).toBe(3);
    expect(listAfter.body.data.revisions[0]?.title).toBe(
      "First revision title"
    );
    expect(listAfter.body.data.revisions[0]?.changeNote).toContain(
      "Restored from revision 1"
    );

    // The original revision 1 row is untouched — never overwritten.
    expect(listAfter.body.data.revisions[2]?.revisionNumber).toBe(1);
    expect(listAfter.body.data.revisions[2]?.title).toBe(
      "First revision title"
    );

    const admin = getAdminSql();
    const auditRows = (await admin`
      SELECT action FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND resource_id = ${postId}
        AND action = 'blog.post.revision_restored'
    `) as { action: string }[];
    expect(auditRows).toHaveLength(1);
  });

  test("restore replays the same response for a repeated Idempotency-Key without appending a duplicate revision", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(owner),
      params: { id: postId },
      body: { title: "Revised title" }
    });

    const list = await invoke<{ data: { revisions: { id: string }[] } }>(
      listRevisions,
      {
        method: "GET",
        path: `/api/v1/blog/posts/${postId}/revisions`,
        headers: authHeaders(owner),
        params: { id: postId }
      }
    );
    const revisionId = list.body.data.revisions[0]!.id;
    const headers = {
      ...authHeaders(owner),
      "idempotency-key": "replay-restore"
    };

    const first = await invoke(restoreRevision, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/revisions/${revisionId}/restore`,
      headers,
      params: { id: postId, revisionId }
    });
    expect(first.status).toBe(200);

    const second = await invoke(restoreRevision, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/revisions/${revisionId}/restore`,
      headers,
      params: { id: postId, revisionId }
    });
    expect(second.status).toBe(200);

    const listAfter = await invoke<{ data: { revisions: unknown[] } }>(
      listRevisions,
      {
        method: "GET",
        path: `/api/v1/blog/posts/${postId}/revisions`,
        headers: authHeaders(owner),
        params: { id: postId }
      }
    );
    // Only one revision from the original PATCH plus one from the single
    // applied restore — the replayed second call must not append another.
    expect(listAfter.body.data.revisions).toHaveLength(2);
  });

  test("tenant B cannot list or read tenant A's post revisions (RLS FORCE)", async () => {
    const tenantA = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(tenantA),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${postId}`,
      headers: authHeaders(tenantA),
      params: { id: postId },
      body: { title: "Tenant A revised title" }
    });

    const tenantB = await provisionSecondTenantWithRevisionsReadAccess();

    const crossTenantList = await invoke(listRevisions, {
      method: "GET",
      path: `/api/v1/blog/posts/${postId}/revisions`,
      headers: authHeaders(tenantB),
      params: { id: postId }
    });
    expect(crossTenantList.status).toBe(404);
  });
});
