/**
 * Integration tests for scheduled blog post publishing (Issue #541, epic
 * #536). Exercises `publishDueScheduledPosts` directly against a real
 * PostgreSQL — the same application function `scripts/blog-scheduled-
 * publish.ts` calls per active tenant. A due post is one with
 * `status = 'scheduled' AND scheduled_at <= now()`; the endpoint under
 * `POST /api/v1/blog/posts/{id}/schedule` only accepts a *future*
 * `scheduledAt` (see `validateScheduleBlogPostInput`), so "due" fixtures are
 * seeded by scheduling via the API and then backdating `scheduled_at`
 * directly with the admin SQL client — the same "raw SQL fixture setup"
 * convention other integration tests use for preconditions the API itself
 * won't produce.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as createPost } from "../../src/pages/api/v1/blog/posts/index";
import { POST as schedulePost } from "../../src/pages/api/v1/blog/posts/[id]/schedule";
import { POST as publishPost } from "../../src/pages/api/v1/blog/posts/[id]/publish";
import { publishDueScheduledPosts } from "../../src/modules/blog-content/application/blog-scheduled-publish";

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

const CREATE_BODY = {
  title: "Hello World",
  slug: "hello-world",
  contentJson: { blocks: [{ type: "paragraph", text: "Hello" }] },
  contentText: "Hello"
};

async function backdateScheduledAt(
  tenantId: string,
  postId: string,
  scheduledAt: Date
): Promise<void> {
  const admin = getAdminSql();
  await admin`
    UPDATE awcms_mini_blog_posts
    SET scheduled_at = ${scheduledAt}
    WHERE tenant_id = ${tenantId} AND id = ${postId}
  `;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("blog scheduled publishing", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("publishes a due scheduled post and sets publishedAt", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    const future = new Date(Date.now() + 60 * 60 * 1000);
    await invoke(schedulePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/schedule`,
      headers: { ...authHeaders(owner), "idempotency-key": "sched-1" },
      params: { id: postId },
      body: { scheduledAt: future.toISOString() }
    });

    const past = new Date(Date.now() - 60 * 1000);
    await backdateScheduledAt(owner.tenantId, postId, past);

    const result = await publishDueScheduledPosts(
      getTestSql(),
      owner.tenantId
    );
    expect(result.publishedCount).toBe(1);
    expect(result.publishedPostIds).toEqual([postId]);

    const rows = (await getAdminSql()`
      SELECT status, published_at, scheduled_at FROM awcms_mini_blog_posts
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `) as { status: string; published_at: Date | null; scheduled_at: Date | null }[];
    expect(rows[0]?.status).toBe("published");
    expect(rows[0]?.published_at).not.toBeNull();
    expect(rows[0]?.scheduled_at).toBeNull();
  });

  test("ignores a scheduled post whose scheduledAt is still in the future", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    const future = new Date(Date.now() + 60 * 60 * 1000);
    await invoke(schedulePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/schedule`,
      headers: { ...authHeaders(owner), "idempotency-key": "sched-1" },
      params: { id: postId },
      body: { scheduledAt: future.toISOString() }
    });

    const result = await publishDueScheduledPosts(
      getTestSql(),
      owner.tenantId
    );
    expect(result.publishedCount).toBe(0);

    const rows = (await getAdminSql()`
      SELECT status FROM awcms_mini_blog_posts
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `) as { status: string }[];
    expect(rows[0]?.status).toBe("scheduled");
  });

  test("ignores a post that is already published", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/publish`,
      headers: { ...authHeaders(owner), "idempotency-key": "publish-1" },
      params: { id: postId }
    });

    const result = await publishDueScheduledPosts(
      getTestSql(),
      owner.tenantId
    );
    expect(result.publishedCount).toBe(0);
  });

  test("is idempotent — running twice only publishes once and preserves the original publishedAt", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    const future = new Date(Date.now() + 60 * 60 * 1000);
    await invoke(schedulePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/schedule`,
      headers: { ...authHeaders(owner), "idempotency-key": "sched-1" },
      params: { id: postId },
      body: { scheduledAt: future.toISOString() }
    });

    const past = new Date(Date.now() - 60 * 1000);
    await backdateScheduledAt(owner.tenantId, postId, past);

    const first = await publishDueScheduledPosts(getTestSql(), owner.tenantId);
    expect(first.publishedCount).toBe(1);

    const rowsAfterFirst = (await getAdminSql()`
      SELECT published_at FROM awcms_mini_blog_posts
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `) as { published_at: Date }[];
    const publishedAtAfterFirst = rowsAfterFirst[0]!.published_at;

    const second = await publishDueScheduledPosts(
      getTestSql(),
      owner.tenantId
    );
    expect(second.publishedCount).toBe(0);

    const rowsAfterSecond = (await getAdminSql()`
      SELECT published_at FROM awcms_mini_blog_posts
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `) as { published_at: Date }[];
    expect(rowsAfterSecond[0]!.published_at.toISOString()).toBe(
      publishedAtAfterFirst.toISOString()
    );
  });

  test("does not overwrite an already-set publishedAt on a previously-published, now-rescheduled post", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;
    const originalPublishedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dueScheduledAt = new Date(Date.now() - 60 * 1000);

    await getAdminSql()`
      UPDATE awcms_mini_blog_posts
      SET status = 'scheduled', published_at = ${originalPublishedAt},
          scheduled_at = ${dueScheduledAt}
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `;

    const result = await publishDueScheduledPosts(
      getTestSql(),
      owner.tenantId
    );
    expect(result.publishedCount).toBe(1);

    const rows = (await getAdminSql()`
      SELECT published_at FROM awcms_mini_blog_posts
      WHERE tenant_id = ${owner.tenantId} AND id = ${postId}
    `) as { published_at: Date }[];
    expect(rows[0]!.published_at.toISOString()).toBe(
      originalPublishedAt.toISOString()
    );
  });

  test("writes scheduled_publish_executed when a post is published and scheduled_publish_skipped when none are due", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: CREATE_BODY
    });
    const postId = created.body.data.id;

    const future = new Date(Date.now() + 60 * 60 * 1000);
    await invoke(schedulePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${postId}/schedule`,
      headers: { ...authHeaders(owner), "idempotency-key": "sched-1" },
      params: { id: postId },
      body: { scheduledAt: future.toISOString() }
    });

    const past = new Date(Date.now() - 60 * 1000);
    await backdateScheduledAt(owner.tenantId, postId, past);

    await publishDueScheduledPosts(getTestSql(), owner.tenantId);
    await publishDueScheduledPosts(getTestSql(), owner.tenantId);

    const admin = getAdminSql();
    const executedRows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId}
        AND action = 'blog.post.scheduled_publish_executed'
    `) as { count: number }[];
    expect(executedRows[0]?.count).toBe(1);

    const skippedRows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId}
        AND action = 'blog.post.scheduled_publish_skipped'
    `) as { count: number }[];
    expect(skippedRows[0]?.count).toBe(1);

    const publishedRows = (await admin`
      SELECT count(*)::int AS count FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND resource_id = ${postId}
        AND action = 'blog.post.published'
    `) as { count: number }[];
    expect(publishedRows[0]?.count).toBe(1);
  });
});
