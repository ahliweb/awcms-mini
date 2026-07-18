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
  getTestSql,
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
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";

import {
  padUnresolvedTenantLatency,
  withNewsTenant
} from "../../src/modules/blog-content/application/public-news-tenant-resolution";
import { withTenant } from "../../src/lib/database/tenant-context";
import { fetchTenantModuleEntry } from "../../src/modules/module-management/application/tenant-module-lifecycle";
import { fetchEffectivePublicRouteSettings } from "../../src/modules/blog-content/application/public-route-settings";

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

/**
 * Round-trip counting wrapper (Issue #562 follow-up — timing side-channel
 * fix verification, see the tests using it near the end of this file). Same
 * technique as `public-tenant-resolution.integration.test.ts`'s Proxy-based
 * counter, extended to also intercept `sql.begin(...)`: every method call
 * made against the `tx` a transaction callback receives (`tx.unsafe(...)`
 * for `SET LOCAL`, tagged-template queries via `` tx`...` ``) is counted
 * too, not just calls made directly against the top-level `sql` client —
 * `withNewsTenant`'s cost, unlike `resolvePublicTenantByHost`'s, spans a
 * real `withTenant` transaction. Verified empirically against a real
 * `Bun.SQL` connection that wrapping `.begin()`'s callback argument this way
 * does not break internal `this` binding, as long as every intercepted
 * method call is re-applied with the *real* target as `this`, never the
 * Proxy itself (see the `get` trap below).
 */
function wrapCountingSql(target: Bun.SQL, counter: { count: number }): Bun.SQL {
  return new Proxy(target, {
    apply(t, thisArg, args) {
      counter.count += 1;
      return Reflect.apply(
        t as unknown as (...a: unknown[]) => unknown,
        thisArg,
        args
      );
    },
    get(t, prop, receiver) {
      if (prop === "begin") {
        const original = Reflect.get(t, prop, receiver) as (
          fn: (tx: unknown) => unknown
        ) => unknown;
        return (fn: (tx: unknown) => unknown) =>
          original.call(t, (tx: unknown) =>
            fn(wrapCountingSql(tx as Bun.SQL, counter))
          );
      }
      const value = Reflect.get(t, prop, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          counter.count += 1;
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      return value;
    }
  }) as unknown as Bun.SQL;
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

    // Issue #845 (epic #818): `social_publishing` now declares a HARD
    // dependency on `blog_content` (its port adapter imports blog_content's
    // `fetchEffectivePublicRouteSettings`). With social_publishing enabled
    // by default, disabling blog_content is now rejected
    // (MODULE_REVERSE_DEPENDENCY_ACTIVE) until its dependent is disabled
    // first — accepted as correct new behaviour per Opsi A. Disable the
    // dependent first so this test can still exercise the
    // blog_content-disabled -> /news 404 path it exists to verify.
    const disableDependent = await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/social_publishing/disable",
      headers: authHeaders(owner),
      params: { moduleKey: "social_publishing" },
      body: { reason: "Free blog_content's reverse dependency before disable." }
    });
    expect(disableDependent.status).toBe(200);

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

  // -------------------------------------------------------------------
  // Timing side-channel fix (Issue #562 follow-up, skill
  // awcms-mini-tenant-domain-routing §Rute publik /news §Follow-up
  // keamanan). `withNewsTenant`'s "tenant not resolved" and "tenant
  // resolved but blog_content disabled" outcomes both produce the
  // identical generic 404 — before this fix they cost a different number
  // of DB round trips (no transaction at all vs one `withTenant`
  // transaction + one module-enabled lookup query), letting a prober
  // vary the `Host` header to learn "this hostname maps to a real active
  // tenant" purely from response latency once #562 lets
  // `awcms_mini_tenant_domains` hold real mappings. The three tests below
  // together prove the fix, deliberately scoped to what `withNewsTenant`
  // itself controls (not `resolvePublicTenantFromRequest`'s own
  // separately-variable env/setup-state fallback cost — see
  // `padUnresolvedTenantLatency`'s own docblock for why that scoping is
  // correct, not a shortcut).
  // -------------------------------------------------------------------

  test("padUnresolvedTenantLatency costs exactly the same DB round trips as the real module-enabled + route-settings check it stands in for", async () => {
    const owner = await bootstrap();
    const baseSql = getTestSql();

    const realCounter = { count: 0 };
    await withTenant(
      wrapCountingSql(baseSql, realCounter),
      owner.tenantId,
      async (tx) => {
        // Same sequence `checkBlogContentAndRouteGate` (private to
        // `public-news-tenant-resolution.ts`) runs internally — Issue #564
        // added the `fetchEffectivePublicRouteSettings` call alongside the
        // pre-existing module-enabled one; the module-enabled lookup itself
        // switched from `fetchTenantModuleEntries` (plural) to
        // `fetchTenantModuleEntry` (singular) as a read-surface narrowing,
        // still exactly one round trip either way, so this baseline stays
        // accurate.
        await fetchTenantModuleEntry(tx, owner.tenantId, "blog_content");
        await fetchEffectivePublicRouteSettings(tx, owner.tenantId);
      }
    );

    const padCounter = { count: 0 };
    await padUnresolvedTenantLatency(wrapCountingSql(baseSql, padCounter));

    // Not trivially zero — proves both branches actually touched the DB,
    // so the equality below is not a vacuous 0 === 0.
    expect(realCounter.count).toBeGreaterThan(0);
    expect(padCounter.count).toBe(realCounter.count);
  });

  test("withNewsTenant now performs a DB round trip even when the tenant does not resolve at all, matching the resolved-but-disabled path's cost (previously zero round trips — the timing side-channel itself)", async () => {
    const owner = await bootstrap();
    const baseSql = getTestSql();

    // Expected count, established the same way the previous test did.
    const expectedCounter = { count: 0 };
    await withTenant(
      wrapCountingSql(baseSql, expectedCounter),
      owner.tenantId,
      async (tx) => {
        await fetchTenantModuleEntry(tx, owner.tenantId, "blog_content");
        await fetchEffectivePublicRouteSettings(tx, owner.tenantId);
      }
    );

    // mode=tenant_code_legacy is the one mode with a DETERMINISTIC,
    // always-zero resolver cost — resolvePublicTenantFromRequest
    // short-circuits to null before touching the DB at all (Issue #560's
    // decision) — chosen specifically so this test isolates
    // withNewsTenant's OWN added cost from resolvePublicTenantFromRequest's
    // separately-variable one.
    const counter = { count: 0 };
    const countingSql = wrapCountingSql(baseSql, counter);
    const request = new Request("http://ignored.test/", {
      headers: { host: "does-not-matter-under-tenant-code-legacy.test" }
    });

    const result = await withEnvOverride(
      { PUBLIC_TENANT_RESOLUTION_MODE: "tenant_code_legacy" },
      () => withNewsTenant(countingSql, request, async () => "handled" as const)
    );

    expect(result).toBeNull();
    expect(counter.count).toBe(expectedCounter.count);
  });

  test("withNewsTenant's resolved-but-disabled and resolved-and-enabled branches cost the same number of round trips up to the point handler() runs", async () => {
    const owner = await bootstrap();
    const admin = getAdminSql();

    await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname, domain_type, status)
      VALUES (${owner.tenantId}, 'disabled.round-trip.test', 'disabled.round-trip.test', 'custom_domain', 'active')
    `;
    // Issue #845 (epic #818): social_publishing now hard-depends on
    // blog_content, so it must be disabled first before blog_content can be
    // (MODULE_REVERSE_DEPENDENCY_ACTIVE otherwise). See the "404s
    // generically" test above for the full rationale. The round-trip parity
    // this test measures is unaffected — it's counted later via
    // countRoundTrips(), independent of this setup disable.
    const disableDependent = await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/social_publishing/disable",
      headers: authHeaders(owner),
      params: { moduleKey: "social_publishing" },
      body: { reason: "round-trip parity test setup: free reverse dependency" }
    });
    expect(disableDependent.status).toBe(200);

    const disable = await invoke(disableModule, {
      method: "POST",
      path: "/api/v1/tenant/modules/blog_content/disable",
      headers: authHeaders(owner),
      params: { moduleKey: "blog_content" },
      body: { reason: "round-trip parity test setup" }
    });
    expect(disable.status).toBe(200);

    // A second, raw-inserted active tenant (no owner/identity needed for an
    // anonymous public route — same `provisionSecondActiveTenant`-style
    // pattern the cross-tenant isolation test above uses) with
    // blog_content left enabled by default (no awcms_mini_tenant_modules
    // row at all -> tenantEnabled defaults to true, see
    // fetchTenantModuleEntry).
    const enabledTenantId = crypto.randomUUID();
    await admin`
      INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name, status)
      VALUES (${enabledTenantId}, 'round-trip-enabled', 'Round Trip Enabled', 'active')
    `;
    await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname, domain_type, status)
      VALUES (${enabledTenantId}, 'enabled.round-trip.test', 'enabled.round-trip.test', 'custom_domain', 'active')
    `;

    const baseSql = getTestSql();

    async function countRoundTrips(
      host: string
    ): Promise<{ count: number; result: unknown }> {
      const counter = { count: 0 };
      const countingSql = wrapCountingSql(baseSql, counter);
      const request = new Request("http://ignored.test/", {
        headers: { host }
      });

      const result = await withEnvOverride(
        { PUBLIC_TENANT_RESOLUTION_MODE: "host_default" },
        () =>
          withNewsTenant(countingSql, request, async () => "handled" as const)
      );

      return { count: counter.count, result };
    }

    const disabledRun = await countRoundTrips("disabled.round-trip.test");
    const enabledRun = await countRoundTrips("enabled.round-trip.test");

    // blog_content disabled -> withNewsTenant's own gate returns null
    // *before* handler ever runs.
    expect(disabledRun.result).toBeNull();
    // blog_content enabled -> handler ran and its return value passed
    // through untouched.
    expect(enabledRun.result).toBe("handled");

    // A mapped-active-domain host lookup costs exactly one round trip
    // regardless of outcome (Issue #559's own guarantee, migration 033),
    // and the module-enabled check that follows it costs the same whether
    // or not blog_content turns out to be enabled — the two counts here
    // differ only by whatever handler() itself would add, and this
    // handler is a no-op that adds none.
    expect(disabledRun.count).toBeGreaterThan(0);
    expect(enabledRun.count).toBe(disabledRun.count);
  });

  test("withNewsTenant's fourth outcome (publicRouteMode=disabled, Issue #564) costs the same number of round trips as the enabled path — explicit parity check, not just structural inference", async () => {
    const owner = await bootstrap();
    const admin = getAdminSql();

    const patched = await invoke(patchModuleSettings, {
      method: "PATCH",
      path: "/api/v1/tenant/modules/blog_content/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "blog_content" },
      body: { publicRouteMode: "disabled" }
    });
    expect(patched.status).toBe(200);

    await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname, domain_type, status)
      VALUES (${owner.tenantId}, 'route-mode-disabled.round-trip.test', 'route-mode-disabled.round-trip.test', 'custom_domain', 'active')
    `;

    const enabledTenantId = crypto.randomUUID();
    await admin`
      INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name, status)
      VALUES (${enabledTenantId}, 'round-trip-mode-enabled', 'Round Trip Mode Enabled', 'active')
    `;
    await admin`
      INSERT INTO awcms_mini_tenant_domains
        (tenant_id, hostname, normalized_hostname, domain_type, status)
      VALUES (${enabledTenantId}, 'route-mode-enabled.round-trip.test', 'route-mode-enabled.round-trip.test', 'custom_domain', 'active')
    `;

    const baseSql = getTestSql();

    async function countRoundTrips(
      host: string
    ): Promise<{ count: number; result: unknown }> {
      const counter = { count: 0 };
      const countingSql = wrapCountingSql(baseSql, counter);
      const request = new Request("http://ignored.test/", {
        headers: { host }
      });

      const result = await withEnvOverride(
        { PUBLIC_TENANT_RESOLUTION_MODE: "host_default" },
        () =>
          withNewsTenant(countingSql, request, async () => "handled" as const)
      );

      return { count: counter.count, result };
    }

    const modeDisabledRun = await countRoundTrips(
      "route-mode-disabled.round-trip.test"
    );
    const modeEnabledRun = await countRoundTrips(
      "route-mode-enabled.round-trip.test"
    );

    // publicRouteMode=disabled -> withNewsTenant's gate returns null before
    // handler ever runs, same as the module-disabled case above.
    expect(modeDisabledRun.result).toBeNull();
    expect(modeEnabledRun.result).toBe("handled");

    // checkBlogContentAndRouteGate() is one shared function called from
    // both the resolved-tenant branch and padUnresolvedTenantLatency() —
    // this asserts that structural guarantee actually holds for this
    // fourth outcome specifically, not just for module-disabled (tested
    // above). A future change that special-cased publicRouteMode before
    // fetchEffectivePublicRouteSettings ran would break this.
    expect(modeDisabledRun.count).toBeGreaterThan(0);
    expect(modeEnabledRun.count).toBe(modeDisabledRun.count);
  });
});
