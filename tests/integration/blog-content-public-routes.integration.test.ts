/**
 * Integration tests for the public blog routes (Issue #540, epic #536).
 * Exercises the real handlers against a real PostgreSQL — public
 * visibility leakage (draft/review/scheduled-future/archived/private/
 * unlisted/soft-deleted must never appear where the issue says they
 * shouldn't), SEO rendering fallbacks, canonical URL safety, category/tag
 * archive filtering, RSS/sitemap content filtering, tenant-code resolution
 * 404s (unknown tenant, inactive tenant), and the `rssEnabled`/
 * `sitemapEnabled` settings gate (Issue #543) — disabled must 404
 * identically to an unknown tenant, no distinguishable signal leaked.
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

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as createPost } from "../../src/pages/api/v1/blog/posts/index";
import { POST as submitReview } from "../../src/pages/api/v1/blog/posts/[id]/submit-review";
import { POST as publishPost } from "../../src/pages/api/v1/blog/posts/[id]/publish";
import { POST as scheduleBlogPost } from "../../src/pages/api/v1/blog/posts/[id]/schedule";
import { POST as archivePost } from "../../src/pages/api/v1/blog/posts/[id]/archive";
import { DELETE as deletePost } from "../../src/pages/api/v1/blog/posts/[id]";
import { POST as createTerm } from "../../src/pages/api/v1/blog/terms/index";
import { PATCH as updateSettings } from "../../src/pages/api/v1/blog/settings/index";

import { GET as publicIndex } from "../../src/pages/blog/[tenantCode]/index";
import { GET as publicDetail } from "../../src/pages/blog/[tenantCode]/[slug]";
import { GET as publicCategory } from "../../src/pages/blog/[tenantCode]/category/[slug]";
import { GET as publicTag } from "../../src/pages/blog/[tenantCode]/tag/[slug]";
import { GET as publicSearch } from "../../src/pages/blog/[tenantCode]/search";
import { GET as publicFeed } from "../../src/pages/blog/[tenantCode]/feed.xml";
import { GET as publicSitemap } from "../../src/pages/blog/[tenantCode]/sitemap-blog.xml";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; tenantCode: string; token: string };

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

  return {
    tenantId: setup.body.data.tenantId,
    tenantCode,
    token: login.body.data.token
  };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
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

/**
 * `POST /setup/initialize` is a once-per-database singleton lock — it
 * cannot be called twice to bootstrap two tenants in the same test (same
 * constraint other integration suites in this repo document). Public
 * routes need no session, so a second tenant here only needs to exist and
 * be `active` — no owner/identity/role setup required, unlike the
 * `provisionSecondTenantWith*Access` helpers other suites use for
 * *authenticated* cross-tenant checks.
 */
async function provisionSecondActiveTenant(
  tenantCode: string,
  tenantName: string
): Promise<{ tenantId: string; tenantCode: string }> {
  const admin = getAdminSql();
  const tenantId = crypto.randomUUID();

  await admin`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name, status)
    VALUES (${tenantId}, ${tenantCode}, ${tenantName}, 'active')
  `;

  return { tenantId, tenantCode };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("public blog routes", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("unknown tenant code 404s without leaking existence", async () => {
    const response = await invokeRaw(publicIndex, {
      method: "GET",
      path: "/blog/does-not-exist",
      params: { tenantCode: "does-not-exist" }
    });
    expect(response.status).toBe(404);
  });

  test("inactive tenant 404s the same as an unknown one", async () => {
    const owner = await bootstrap();
    const admin = getAdminSql();
    await admin`UPDATE awcms_mini_tenants SET status = 'inactive' WHERE id = ${owner.tenantId}`;

    const response = await invokeRaw(publicIndex, {
      method: "GET",
      path: `/blog/${owner.tenantCode}`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(response.status).toBe(404);
  });

  test("published public post appears on the index and is reachable by detail", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, { slug: "public-post" });

    const index = await invokeRaw(publicIndex, {
      method: "GET",
      path: `/blog/${owner.tenantCode}`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(index.status).toBe(200);
    expect(index.text).toContain("public-post");

    const detail = await invokeRaw(publicDetail, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/${post.slug}`,
      params: { tenantCode: owner.tenantCode, slug: post.slug }
    });
    expect(detail.status).toBe(200);
    expect(detail.text).toContain("Hello world");
  });

  test("draft post is never publicly visible (index or detail)", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string; slug: string } }>(
      createPost,
      {
        method: "POST",
        path: "/api/v1/blog/posts",
        headers: authHeaders(owner),
        body: {
          title: "Draft Post",
          slug: "draft-post",
          contentJson: {},
          contentText: "draft body"
        }
      }
    );
    expect(created.status).toBe(200);

    const detail = await invokeRaw(publicDetail, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/draft-post`,
      params: { tenantCode: owner.tenantCode, slug: "draft-post" }
    });
    expect(detail.status).toBe(404);

    const index = await invokeRaw(publicIndex, {
      method: "GET",
      path: `/blog/${owner.tenantCode}`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(index.text).not.toContain("Draft Post");
  });

  test("review-status post is never publicly visible", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "Review Post",
        slug: "review-post",
        contentJson: {},
        contentText: "body"
      }
    });
    await invoke(submitReview, {
      method: "POST",
      path: `/api/v1/blog/posts/${created.body.data.id}/submit-review`,
      headers: authHeaders(owner),
      params: { id: created.body.data.id }
    });

    const detail = await invokeRaw(publicDetail, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/review-post`,
      params: { tenantCode: owner.tenantCode, slug: "review-post" }
    });
    expect(detail.status).toBe(404);
  });

  test("scheduled-future post is never publicly visible", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "Scheduled Post",
        slug: "scheduled-post",
        contentJson: {},
        contentText: "body"
      }
    });
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduled = await invoke(scheduleBlogPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${created.body.data.id}/schedule`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      params: { id: created.body.data.id },
      body: { scheduledAt: futureDate }
    });
    expect(scheduled.status).toBe(200);

    const detail = await invokeRaw(publicDetail, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/scheduled-post`,
      params: { tenantCode: owner.tenantCode, slug: "scheduled-post" }
    });
    expect(detail.status).toBe(404);
  });

  test("archived post is never publicly visible", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, { slug: "archived-post" });
    const archived = await invoke(archivePost, {
      method: "POST",
      path: `/api/v1/blog/posts/${post.id}/archive`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      params: { id: post.id }
    });
    expect(archived.status).toBe(200);

    const detail = await invokeRaw(publicDetail, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/archived-post`,
      params: { tenantCode: owner.tenantCode, slug: "archived-post" }
    });
    expect(detail.status).toBe(404);
  });

  test("soft-deleted post is never publicly visible", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, { slug: "deleted-post" });
    const deleted = await invoke(deletePost, {
      method: "DELETE",
      path: `/api/v1/blog/posts/${post.id}`,
      headers: authHeaders(owner),
      params: { id: post.id },
      body: { reason: "test" }
    });
    expect(deleted.status).toBe(200);

    const detail = await invokeRaw(publicDetail, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/deleted-post`,
      params: { tenantCode: owner.tenantCode, slug: "deleted-post" }
    });
    expect(detail.status).toBe(404);
  });

  test("private post is never publicly visible, even by direct link", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, {
      slug: "private-post",
      visibility: "private"
    });

    const detail = await invokeRaw(publicDetail, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/private-post`,
      params: { tenantCode: owner.tenantCode, slug: "private-post" }
    });
    expect(detail.status).toBe(404);
  });

  test("unlisted post is reachable by direct link but excluded from the index", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, {
      slug: "unlisted-post",
      visibility: "unlisted"
    });

    const detail = await invokeRaw(publicDetail, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/unlisted-post`,
      params: { tenantCode: owner.tenantCode, slug: "unlisted-post" }
    });
    expect(detail.status).toBe(200);

    const index = await invokeRaw(publicIndex, {
      method: "GET",
      path: `/blog/${owner.tenantCode}`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(index.text).not.toContain("unlisted-post");
    expect(post.slug).toBe("unlisted-post");
  });

  test("SEO title/description fall back correctly", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "Fallback Title",
        slug: "fallback-seo",
        excerpt: "Fallback excerpt",
        contentJson: {},
        contentText: "body"
      }
    });
    await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${created.body.data.id}/publish`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      params: { id: created.body.data.id }
    });

    const detail = await invokeRaw(publicDetail, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/fallback-seo`,
      params: { tenantCode: owner.tenantCode, slug: "fallback-seo" }
    });
    expect(detail.text).toContain("<title>Fallback Title</title>");
    expect(detail.text).toContain('content="Fallback excerpt"');
  });

  test("canonical URL renders the author override when valid", async () => {
    const owner = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "Canonical Post",
        slug: "canonical-post",
        contentJson: {},
        contentText: "body",
        canonicalUrl: "https://example.com/original"
      }
    });
    await invoke(publishPost, {
      method: "POST",
      path: `/api/v1/blog/posts/${created.body.data.id}/publish`,
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      params: { id: created.body.data.id }
    });

    const detail = await invokeRaw(publicDetail, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/canonical-post`,
      params: { tenantCode: owner.tenantCode, slug: "canonical-post" }
    });
    expect(detail.text).toContain('href="https://example.com/original"');
  });

  test("category archive lists only public published posts in that category", async () => {
    const owner = await bootstrap();
    const category = await invoke<{ data: { id: string } }>(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: { taxonomyType: "category", name: "News", slug: "news" }
    });

    const publicPost = await createAndPublishPost(owner, {
      slug: "news-public",
      termIds: [category.body.data.id]
    });

    const draftCreated = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "News Draft",
        slug: "news-draft",
        contentJson: {},
        contentText: "body",
        termIds: [category.body.data.id]
      }
    });
    expect(draftCreated.status).toBe(200);

    const archive = await invokeRaw(publicCategory, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/category/news`,
      params: { tenantCode: owner.tenantCode, slug: "news" }
    });
    expect(archive.status).toBe(200);
    expect(archive.text).toContain(publicPost.slug);
    expect(archive.text).not.toContain("News Draft");
  });

  test("unknown category slug 404s", async () => {
    const owner = await bootstrap();
    const response = await invokeRaw(publicCategory, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/category/does-not-exist`,
      params: { tenantCode: owner.tenantCode, slug: "does-not-exist" }
    });
    expect(response.status).toBe(404);
  });

  test("tag archive lists only public published posts with that tag", async () => {
    const owner = await bootstrap();
    const tag = await invoke<{ data: { id: string } }>(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: { taxonomyType: "tag", name: "Featured", slug: "featured" }
    });

    const post = await createAndPublishPost(owner, {
      slug: "featured-post",
      termIds: [tag.body.data.id]
    });

    const archive = await invokeRaw(publicTag, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/tag/featured`,
      params: { tenantCode: owner.tenantCode, slug: "featured" }
    });
    expect(archive.status).toBe(200);
    expect(archive.text).toContain(post.slug);
  });

  test("public search only returns published public posts", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, {
      slug: "zephyr-searchable",
      title: "Zephyr Winds",
      contentText: "zephyr content"
    });

    const draft = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "Zephyr Draft",
        slug: "zephyr-draft-search",
        contentJson: {},
        contentText: "zephyr content"
      }
    });
    expect(draft.status).toBe(200);

    const results = await invokeRaw(publicSearch, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/search?q=zephyr`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(results.status).toBe(200);
    expect(results.text).toContain("zephyr-searchable");
    expect(results.text).not.toContain("Zephyr Draft");
  });

  test("RSS feed includes only published public posts", async () => {
    const owner = await bootstrap();
    const publicPost = await createAndPublishPost(owner, {
      slug: "rss-public"
    });
    await createAndPublishPost(owner, {
      slug: "rss-private",
      visibility: "private"
    });

    const feed = await invokeRaw(publicFeed, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/feed.xml`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(feed.status).toBe(200);
    expect(feed.text).toContain(`<title>Test Post</title>`);
    expect(feed.text).toContain(publicPost.slug);
    expect(feed.text).not.toContain("rss-private");
    expect(feed.text.startsWith('<?xml version="1.0"')).toBe(true);
  });

  test("sitemap includes only published public posts", async () => {
    const owner = await bootstrap();
    const publicPost = await createAndPublishPost(owner, {
      slug: "sitemap-public"
    });
    await createAndPublishPost(owner, {
      slug: "sitemap-unlisted",
      visibility: "unlisted"
    });

    const sitemap = await invokeRaw(publicSitemap, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/sitemap-blog.xml`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(sitemap.status).toBe(200);
    expect(sitemap.text).toContain(publicPost.slug);
    expect(sitemap.text).not.toContain("sitemap-unlisted");
    expect(sitemap.text).toContain("<urlset");
  });

  test("feed.xml 404s the same as an unknown tenant when rssEnabled is false", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, { slug: "rss-disabled-post" });

    const enabled = await invokeRaw(publicFeed, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/feed.xml`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(enabled.status).toBe(200);

    const disable = await invoke(updateSettings, {
      method: "PATCH",
      path: "/api/v1/blog/settings",
      headers: authHeaders(owner),
      body: { rssEnabled: false }
    });
    expect(disable.status).toBe(200);

    const disabled = await invokeRaw(publicFeed, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/feed.xml`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(disabled.status).toBe(404);

    // Same shape as the unknown-tenant 404 — no distinguishable signal that
    // the feed exists but was turned off.
    const unknown = await invokeRaw(publicFeed, {
      method: "GET",
      path: "/blog/does-not-exist/feed.xml",
      params: { tenantCode: "does-not-exist" }
    });
    expect(unknown.status).toBe(404);
    expect(disabled.text).toBe(unknown.text);
  });

  test("sitemap-blog.xml 404s the same as an unknown tenant when sitemapEnabled is false", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, { slug: "sitemap-disabled-post" });

    const enabled = await invokeRaw(publicSitemap, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/sitemap-blog.xml`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(enabled.status).toBe(200);

    const disable = await invoke(updateSettings, {
      method: "PATCH",
      path: "/api/v1/blog/settings",
      headers: authHeaders(owner),
      body: { sitemapEnabled: false }
    });
    expect(disable.status).toBe(200);

    const disabled = await invokeRaw(publicSitemap, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/sitemap-blog.xml`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(disabled.status).toBe(404);

    const unknown = await invokeRaw(publicSitemap, {
      method: "GET",
      path: "/blog/does-not-exist/sitemap-blog.xml",
      params: { tenantCode: "does-not-exist" }
    });
    expect(unknown.status).toBe(404);
    expect(disabled.text).toBe(unknown.text);
  });

  test("tenant A's posts never leak into tenant B's public routes", async () => {
    const tenantA = await bootstrap("tenant-a-pub", "Tenant A");
    await createAndPublishPost(tenantA, { slug: "tenant-a-only-post" });

    const tenantB = await provisionSecondActiveTenant(
      "tenant-b-pub",
      "Tenant B"
    );

    const detailFromB = await invokeRaw(publicDetail, {
      method: "GET",
      path: `/blog/${tenantB.tenantCode}/tenant-a-only-post`,
      params: { tenantCode: tenantB.tenantCode, slug: "tenant-a-only-post" }
    });
    expect(detailFromB.status).toBe(404);

    const indexB = await invokeRaw(publicIndex, {
      method: "GET",
      path: `/blog/${tenantB.tenantCode}`,
      params: { tenantCode: tenantB.tenantCode }
    });
    expect(indexB.text).not.toContain("tenant-a-only-post");
  });
});
