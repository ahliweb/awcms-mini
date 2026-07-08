/**
 * Integration tests for the public `/news` routes (Issue #560, epic #555)
 * against a real PostgreSQL. `/news` is the tenant-code-free counterpart of
 * `/blog/{tenantCode}` (Issue #540, still covered by
 * `blog-content-public-routes.integration.test.ts`) — tenant resolution
 * comes from `resolvePublicTenantFromRequest` (Issue #559) instead of a
 * `tenantCode` path segment.
 *
 * `POST /api/v1/setup/initialize` writes the bootstrap tenant into
 * `awcms_mini_setup_state.tenant_id` (see `src/pages/api/v1/setup/initialize.ts`),
 * and `resolvePublicTenantFromRequest`'s fallback chain (steps 2-4) always
 * runs when `PUBLIC_TENANT_RESOLUTION_MODE` is unset — so with no `PUBLIC_*`
 * env vars set at all (this suite's default, matching every existing
 * offline/LAN deployment), `/news` resolves the same tenant `bootstrap()`
 * just created via the setup-state fallback (step 4), with no extra
 * configuration needed per test.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import {
  afterEach,
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
import { POST as submitReview } from "../../src/pages/api/v1/blog/posts/[id]/submit-review";
import { POST as publishPost } from "../../src/pages/api/v1/blog/posts/[id]/publish";
import { POST as scheduleBlogPost } from "../../src/pages/api/v1/blog/posts/[id]/schedule";
import { POST as archivePost } from "../../src/pages/api/v1/blog/posts/[id]/archive";
import {
  DELETE as deletePost,
  PATCH as updatePost
} from "../../src/pages/api/v1/blog/posts/[id]";
import { POST as createTerm } from "../../src/pages/api/v1/blog/terms/index";
import { POST as disableModule } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/disable";

import { GET as newsIndex } from "../../src/pages/news/index";
import { GET as newsDetail } from "../../src/pages/news/[slug]";
import { GET as newsCategory } from "../../src/pages/news/category/[slug]";
import { GET as newsTag } from "../../src/pages/news/tag/[slug]";
import { GET as newsSearch } from "../../src/pages/news/search";
import { GET as newsFeed } from "../../src/pages/news/feed.xml";
import { GET as newsSitemap } from "../../src/pages/news/sitemap-news.xml";

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
 * Temporarily overrides `process.env` keys for the duration of `fn`, then
 * restores the previous values (or deletes the key if it was previously
 * unset). Route handlers under test always build their
 * `PublicHostResolverConfig` from the real `process.env` (Issue #556's
 * `PUBLIC_TENANT_RESOLUTION_MODE`/`PUBLIC_TRUST_PROXY`), so this is the only
 * way to exercise a non-default resolution mode end-to-end through the real
 * route handler.
 */
async function withEnvOverride<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};

  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const suite = integrationEnabled ? describe : describe.skip;

suite("public /news routes (Issue #560)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  // Defense in depth: if a test throws before its own `finally` restores
  // process.env, later tests must not silently inherit a stale override.
  afterEach(() => {
    delete process.env.PUBLIC_TENANT_RESOLUTION_MODE;
    delete process.env.PUBLIC_DEFAULT_TENANT_ID;
    delete process.env.PUBLIC_DEFAULT_TENANT_CODE;
    delete process.env.PUBLIC_TRUST_PROXY;
  });

  test("no tenant ever bootstrapped: /news 404s without leaking existence", async () => {
    const response = await invokeRaw(newsIndex, {
      method: "GET",
      path: "/news"
    });
    expect(response.status).toBe(404);
  });

  test("published public post appears on /news and is reachable by /news/{slug}", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, { slug: "public-post" });

    const index = await invokeRaw(newsIndex, {
      method: "GET",
      path: "/news"
    });
    expect(index.status).toBe(200);
    expect(index.text).toContain("public-post");

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: `/news/${post.slug}`,
      params: { slug: post.slug }
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

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: "/news/draft-post",
      params: { slug: "draft-post" }
    });
    expect(detail.status).toBe(404);

    const index = await invokeRaw(newsIndex, {
      method: "GET",
      path: "/news"
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

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: "/news/review-post",
      params: { slug: "review-post" }
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

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: "/news/scheduled-post",
      params: { slug: "scheduled-post" }
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

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: "/news/archived-post",
      params: { slug: "archived-post" }
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

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: "/news/deleted-post",
      params: { slug: "deleted-post" }
    });
    expect(detail.status).toBe(404);
  });

  test("private post is never publicly visible, even by direct link", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, {
      slug: "private-post",
      visibility: "private"
    });

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: "/news/private-post",
      params: { slug: "private-post" }
    });
    expect(detail.status).toBe(404);
  });

  test("unlisted post is reachable by direct link but excluded from the index/search/feed/sitemap", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, {
      slug: "unlisted-post",
      title: "Unlisted Zephyr",
      contentText: "zephyr content"
    });
    await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${post.id}`,
      headers: authHeaders(owner),
      params: { id: post.id },
      body: { visibility: "unlisted" }
    });

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: "/news/unlisted-post",
      params: { slug: "unlisted-post" }
    });
    expect(detail.status).toBe(200);

    const index = await invokeRaw(newsIndex, { method: "GET", path: "/news" });
    expect(index.text).not.toContain("unlisted-post");

    const search = await invokeRaw(newsSearch, {
      method: "GET",
      path: "/news/search?q=zephyr"
    });
    expect(search.text).not.toContain("unlisted-post");

    const feed = await invokeRaw(newsFeed, {
      method: "GET",
      path: "/news/feed.xml"
    });
    expect(feed.text).not.toContain("unlisted-post");

    const sitemap = await invokeRaw(newsSitemap, {
      method: "GET",
      path: "/news/sitemap-news.xml"
    });
    expect(sitemap.text).not.toContain("unlisted-post");
  });

  test("canonical URL uses /news/{slug}, not /blog/{tenantCode}/{slug}", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, { slug: "canonical-check" });

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: "/news/canonical-check",
      params: { slug: "canonical-check" }
    });
    expect(detail.status).toBe(200);
    expect(detail.text).toContain(
      'href="http://integration.test/news/canonical-check"'
    );
    expect(detail.text).not.toContain(`/blog/${owner.tenantCode}/`);
  });

  test("category archive lists only public published posts in that category, under /news/category", async () => {
    const owner = await bootstrap();
    const category = await invoke<{ data: { id: string } }>(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: { taxonomyType: "category", name: "News", slug: "news-cat" }
    });

    const publicPost = await createAndPublishPost(owner, {
      slug: "news-cat-public",
      termIds: [category.body.data.id]
    });

    const draftCreated = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "News Cat Draft",
        slug: "news-cat-draft",
        contentJson: {},
        contentText: "body",
        termIds: [category.body.data.id]
      }
    });
    expect(draftCreated.status).toBe(200);

    const archive = await invokeRaw(newsCategory, {
      method: "GET",
      path: "/news/category/news-cat",
      params: { slug: "news-cat" }
    });
    expect(archive.status).toBe(200);
    expect(archive.text).toContain(publicPost.slug);
    expect(archive.text).not.toContain("News Cat Draft");
  });

  test("unknown category slug 404s", async () => {
    await bootstrap();
    const response = await invokeRaw(newsCategory, {
      method: "GET",
      path: "/news/category/does-not-exist",
      params: { slug: "does-not-exist" }
    });
    expect(response.status).toBe(404);
  });

  test("tag archive lists only public published posts with that tag, under /news/tag", async () => {
    const owner = await bootstrap();
    const tag = await invoke<{ data: { id: string } }>(createTerm, {
      method: "POST",
      path: "/api/v1/blog/terms",
      headers: authHeaders(owner),
      body: { taxonomyType: "tag", name: "Featured", slug: "news-featured" }
    });

    const post = await createAndPublishPost(owner, {
      slug: "news-featured-post",
      termIds: [tag.body.data.id]
    });

    const archive = await invokeRaw(newsTag, {
      method: "GET",
      path: "/news/tag/news-featured",
      params: { slug: "news-featured" }
    });
    expect(archive.status).toBe(200);
    expect(archive.text).toContain(post.slug);
  });

  test("public search only returns published public posts", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, {
      slug: "zephyr-news-searchable",
      title: "Zephyr Winds",
      contentText: "zephyr content"
    });

    const draft = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: {
        title: "Zephyr Draft",
        slug: "zephyr-news-draft",
        contentJson: {},
        contentText: "zephyr content"
      }
    });
    expect(draft.status).toBe(200);

    const results = await invokeRaw(newsSearch, {
      method: "GET",
      path: "/news/search?q=zephyr"
    });
    expect(results.status).toBe(200);
    expect(results.text).toContain("zephyr-news-searchable");
    expect(results.text).not.toContain("Zephyr Draft");
  });

  test("RSS feed includes only published public posts, with links under /news", async () => {
    const owner = await bootstrap();
    const publicPost = await createAndPublishPost(owner, {
      slug: "rss-news-public"
    });
    await createAndPublishPost(owner, {
      slug: "rss-news-private",
      visibility: "private"
    });

    const feed = await invokeRaw(newsFeed, {
      method: "GET",
      path: "/news/feed.xml"
    });
    expect(feed.status).toBe(200);
    expect(feed.text).toContain(`<link>http://integration.test/news</link>`);
    expect(feed.text).toContain(
      `<link>http://integration.test/news/${publicPost.slug}</link>`
    );
    expect(feed.text).not.toContain("rss-news-private");
    expect(feed.text.startsWith('<?xml version="1.0"')).toBe(true);
  });

  test("sitemap-news.xml includes only published public posts, with URLs under /news", async () => {
    const owner = await bootstrap();
    const publicPost = await createAndPublishPost(owner, {
      slug: "sitemap-news-public"
    });
    await createAndPublishPost(owner, {
      slug: "sitemap-news-unlisted",
      visibility: "unlisted"
    });

    const sitemap = await invokeRaw(newsSitemap, {
      method: "GET",
      path: "/news/sitemap-news.xml"
    });
    expect(sitemap.status).toBe(200);
    expect(sitemap.text).toContain(
      `<loc>http://integration.test/news/${publicPost.slug}</loc>`
    );
    expect(sitemap.text).not.toContain("sitemap-news-unlisted");
    expect(sitemap.text).toContain("<urlset");
  });

  test("blog_content disabled for the resolved tenant: every /news route 404s generically", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, {
      slug: "module-disabled-post"
    });

    const disable = await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/blog_content/disable",
      headers: authHeaders(owner),
      params: { moduleKey: "blog_content" },
      body: { reason: "Testing module-disabled 404 for /news." }
    });
    expect(disable.status).toBe(200);

    const index = await invokeRaw(newsIndex, { method: "GET", path: "/news" });
    expect(index.status).toBe(404);

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: `/news/${post.slug}`,
      params: { slug: post.slug }
    });
    expect(detail.status).toBe(404);

    const feed = await invokeRaw(newsFeed, {
      method: "GET",
      path: "/news/feed.xml"
    });
    expect(feed.status).toBe(404);

    const sitemap = await invokeRaw(newsSitemap, {
      method: "GET",
      path: "/news/sitemap-news.xml"
    });
    expect(sitemap.status).toBe(404);

    const search = await invokeRaw(newsSearch, {
      method: "GET",
      path: "/news/search?q=module"
    });
    expect(search.status).toBe(404);

    // Same generic shape as an unresolved tenant — no signal that the
    // tenant exists but the module is merely disabled.
    const unresolvedIndex = await invokeRaw(newsIndex, {
      method: "GET",
      path: "/news",
      headers: { host: "no-such-host.invalid" }
    });
    // Default mode (unset) does not use the Host header at all, so this
    // still resolves the same tenant/disabled-module 404 shape — assert
    // shape equality against the disabled-module response directly instead.
    expect(unresolvedIndex.status).toBe(404);
    expect(index.text).toBe(unresolvedIndex.text);
  });

  test("mode=tenant_code_legacy: /news never resolves a tenant, even with a valid setup-state default", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, { slug: "legacy-mode-post" });

    await withEnvOverride(
      { PUBLIC_TENANT_RESOLUTION_MODE: "tenant_code_legacy" },
      async () => {
        const index = await invokeRaw(newsIndex, {
          method: "GET",
          path: "/news"
        });
        expect(index.status).toBe(404);

        const detail = await invokeRaw(newsDetail, {
          method: "GET",
          path: "/news/legacy-mode-post",
          params: { slug: "legacy-mode-post" }
        });
        expect(detail.status).toBe(404);
      }
    );

    // Sanity check: with the override removed, the same tenant/post is
    // reachable again via the default (unset-mode) fallback chain.
    const restored = await invokeRaw(newsDetail, {
      method: "GET",
      path: "/news/legacy-mode-post",
      params: { slug: "legacy-mode-post" }
    });
    expect(restored.status).toBe(200);
  });

  test("mode=tenant_code_legacy also ignores an explicit PUBLIC_DEFAULT_TENANT_ID — the whole fallback chain is skipped, not just host lookup", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, { slug: "legacy-mode-env-post" });

    await withEnvOverride(
      {
        PUBLIC_TENANT_RESOLUTION_MODE: "tenant_code_legacy",
        PUBLIC_DEFAULT_TENANT_ID: owner.tenantId
      },
      async () => {
        const detail = await invokeRaw(newsDetail, {
          method: "GET",
          path: "/news/legacy-mode-env-post",
          params: { slug: "legacy-mode-env-post" }
        });
        expect(detail.status).toBe(404);
      }
    );
  });

  test("tenant A's post never leaks into /news when a different tenant is the resolved default (env_default mode)", async () => {
    // `POST /setup/initialize` is a once-per-database singleton lock (see
    // file header comment) — it cannot be called twice in one test to
    // bootstrap two tenants, so tenant B is provisioned directly (same
    // `provisionSecondActiveTenant` pattern
    // `blog-content-public-routes.integration.test.ts` uses for its own
    // cross-tenant isolation test): it only needs to exist and be `active`,
    // no owner/identity/role setup required for an anonymous public route.
    const tenantA = await bootstrap("news-tenant-a", "Tenant A");
    await createAndPublishPost(tenantA, { slug: "tenant-a-news-only" });

    const admin = getAdminSql();
    const tenantBId = crypto.randomUUID();
    await admin`
      INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name, status)
      VALUES (${tenantBId}, 'news-tenant-b', 'Tenant B', 'active')
    `;

    await withEnvOverride(
      {
        PUBLIC_TENANT_RESOLUTION_MODE: "env_default",
        PUBLIC_DEFAULT_TENANT_ID: tenantBId
      },
      async () => {
        const index = await invokeRaw(newsIndex, {
          method: "GET",
          path: "/news"
        });
        expect(index.status).toBe(200);
        expect(index.text).not.toContain("tenant-a-news-only");

        const detailFromB = await invokeRaw(newsDetail, {
          method: "GET",
          path: "/news/tenant-a-news-only",
          params: { slug: "tenant-a-news-only" }
        });
        expect(detailFromB.status).toBe(404);
      }
    );
  });
});
