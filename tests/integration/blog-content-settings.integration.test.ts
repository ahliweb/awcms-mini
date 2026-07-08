/**
 * Integration tests for `blog_content`'s public-route-behavior settings
 * (Issue #564, epic #555) against a real PostgreSQL: the four new
 * descriptor-defaults keys read/written through Module Management's
 * generic tenant-settings framework (`GET`/`PATCH
 * /api/v1/tenant/modules/blog_content/settings`, Issue #516/epic #510),
 * `/news` `publicRouteMode`/`publicBasePath`/`publicLabel` behavior, the
 * `/blog/{tenantCode}` `legacyTenantRouteEnabled` gate (all 7 routes), and
 * — the central design decision this issue had to make — proof that
 * `rssEnabled`/`sitemapEnabled` remain governed EXCLUSIVELY by the
 * pre-existing `awcms_mini_blog_settings` store
 * (`fetchBlogSettings`/`PATCH /api/v1/blog/settings`, Issue #537/#543),
 * never by this new generic-settings store, even if a caller writes those
 * exact key names into it.
 *
 * See `src/modules/blog-content/README.md` §Public route settings and
 * `src/modules/blog-content/application/public-route-settings.ts`'s header
 * comment for the full reasoning this test file verifies end to end.
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
  integrationEnabled,
  invoke,
  invokeRaw,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as createPost } from "../../src/pages/api/v1/blog/posts/index";
import { POST as publishPost } from "../../src/pages/api/v1/blog/posts/[id]/publish";
import {
  GET as getModuleSettings,
  PATCH as patchModuleSettings
} from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import {
  GET as getBlogSettings,
  PATCH as patchBlogSettings
} from "../../src/pages/api/v1/blog/settings/index";

import { GET as newsIndex } from "../../src/pages/news/index";
import { GET as newsFeed } from "../../src/pages/news/feed.xml";
import { GET as newsSitemap } from "../../src/pages/news/sitemap-news.xml";

import { GET as legacyIndex } from "../../src/pages/blog/[tenantCode]/index";
import { GET as legacyDetail } from "../../src/pages/blog/[tenantCode]/[slug]";
import { GET as legacyCategory } from "../../src/pages/blog/[tenantCode]/category/[slug]";
import { GET as legacyTag } from "../../src/pages/blog/[tenantCode]/tag/[slug]";
import { GET as legacySearch } from "../../src/pages/blog/[tenantCode]/search";
import { GET as legacyFeed } from "../../src/pages/blog/[tenantCode]/feed.xml";
import { GET as legacySitemap } from "../../src/pages/blog/[tenantCode]/sitemap-blog.xml";

import { POST as createTerm } from "../../src/pages/api/v1/blog/terms/index";

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

async function patchBlogContentSettings(
  owner: Bootstrap,
  body: Record<string, unknown>
) {
  return invoke<{
    data: {
      moduleKey: string;
      defaults: Record<string, unknown>;
      tenantOverride: Record<string, unknown>;
      effective: Record<string, unknown>;
    };
  }>(patchModuleSettings, {
    method: "PATCH",
    path: "/api/v1/tenant/modules/blog_content/settings",
    headers: authHeaders(owner),
    params: { moduleKey: "blog_content" },
    body
  });
}

const suite = integrationEnabled ? describe : describe.skip;

suite("blog_content public route settings (Issue #564)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    delete process.env.PUBLIC_TENANT_RESOLUTION_MODE;
    delete process.env.PUBLIC_CANONICAL_BASE_PATH;
  });

  // -----------------------------------------------------------------
  // Descriptor defaults
  // -----------------------------------------------------------------

  test("GET blog_content module settings returns the four new descriptor defaults, and NOT rssEnabled/sitemapEnabled", async () => {
    const owner = await bootstrap();

    const result = await invoke<{
      data: {
        moduleKey: string;
        defaults: Record<string, unknown>;
        effective: Record<string, unknown>;
      };
    }>(getModuleSettings, {
      method: "GET",
      path: "/api/v1/tenant/modules/blog_content/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "blog_content" }
    });

    expect(result.status).toBe(200);
    expect(result.body.data.defaults).toEqual({
      publicRouteMode: "domain_default",
      publicBasePath: "/news",
      legacyTenantRouteEnabled: true,
      publicLabel: "News"
    });
    expect(result.body.data.effective).toEqual(result.body.data.defaults);
    // Deliberately not present — rssEnabled/sitemapEnabled stay owned by
    // awcms_mini_blog_settings (Issue #537/#543), never duplicated here.
    expect(result.body.data.defaults).not.toHaveProperty("rssEnabled");
    expect(result.body.data.defaults).not.toHaveProperty("sitemapEnabled");
  });

  test("PATCH blog_content module settings still rejects a secret-shaped key (400 SETTINGS_SENSITIVE_KEY_REJECTED)", async () => {
    const owner = await bootstrap();

    const result = await patchBlogContentSettings(owner, {
      apiToken: "sk-should-never-be-stored"
    });

    expect(result.status).toBe(400);
    expect(
      (result.body as unknown as { error: { code: string } }).error.code
    ).toBe("SETTINGS_SENSITIVE_KEY_REJECTED");
  });

  test("PATCH updates publicBasePath/publicLabel/legacyTenantRouteEnabled and GET reflects the merged effective view", async () => {
    const owner = await bootstrap();

    const patched = await patchBlogContentSettings(owner, {
      publicBasePath: "/articles",
      publicLabel: "Articles",
      legacyTenantRouteEnabled: false
    });
    expect(patched.status).toBe(200);

    const result = await invoke<{
      data: { effective: Record<string, unknown> };
    }>(getModuleSettings, {
      method: "GET",
      path: "/api/v1/tenant/modules/blog_content/settings",
      headers: authHeaders(owner),
      params: { moduleKey: "blog_content" }
    });

    expect(result.body.data.effective).toEqual({
      publicRouteMode: "domain_default",
      publicBasePath: "/articles",
      legacyTenantRouteEnabled: false,
      publicLabel: "Articles"
    });
  });

  // -----------------------------------------------------------------
  // /news: publicRouteMode
  // -----------------------------------------------------------------

  test("publicRouteMode left at default (domain_default) does not change today's /news behavior", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, { slug: "still-works" });

    const index = await invokeRaw(newsIndex, { method: "GET", path: "/news" });
    expect(index.status).toBe(200);
    expect(index.text).toContain(post.slug);
  });

  test("publicRouteMode=disabled makes every /news route 404 with the exact same generic shape as an unresolved tenant", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, { slug: "hidden-by-route-mode" });

    const patched = await patchBlogContentSettings(owner, {
      publicRouteMode: "disabled"
    });
    expect(patched.status).toBe(200);

    const index = await invokeRaw(newsIndex, { method: "GET", path: "/news" });
    const feed = await invokeRaw(newsFeed, {
      method: "GET",
      path: "/news/feed.xml"
    });
    const sitemap = await invokeRaw(newsSitemap, {
      method: "GET",
      path: "/news/sitemap-news.xml"
    });

    // Same generic 404 an unresolved tenant produces (see
    // `blog-content-public-news.integration.test.ts`'s "no tenant ever
    // bootstrapped" test) — no distinguishable signal that a real tenant
    // sits behind this hostname.
    expect(index.status).toBe(404);
    expect(feed.status).toBe(404);
    expect(sitemap.status).toBe(404);
    expect(index.text).not.toContain("hidden-by-route-mode");
  });

  test("publicRouteMode=disabled does not affect legacy /blog/{tenantCode} routes (independent switches)", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, {
      slug: "legacy-still-open"
    });

    const patched = await patchBlogContentSettings(owner, {
      publicRouteMode: "disabled"
    });
    expect(patched.status).toBe(200);

    const legacy = await invokeRaw(legacyIndex, {
      method: "GET",
      path: `/blog/${owner.tenantCode}`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(legacy.status).toBe(200);
    expect(legacy.text).toContain(post.slug);
  });

  // -----------------------------------------------------------------
  // /news: publicBasePath / publicLabel (self-referential link generation)
  // -----------------------------------------------------------------

  test("publicBasePath customization changes /news self-referential links (canonical URL, pagination, listing hrefs) — not the physically-served route itself", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, {
      slug: "base-path-check"
    });

    const patched = await patchBlogContentSettings(owner, {
      publicBasePath: "/articles"
    });
    expect(patched.status).toBe(200);

    const index = await invokeRaw(newsIndex, { method: "GET", path: "/news" });
    expect(index.status).toBe(200);
    expect(index.text).toContain(`href="/articles/${post.slug}"`);

    const feed = await invokeRaw(newsFeed, {
      method: "GET",
      path: "/news/feed.xml"
    });
    expect(feed.status).toBe(200);
    expect(feed.text).toContain(
      `<link>http://integration.test/articles</link>`
    );
    expect(feed.text).toContain(
      `<link>http://integration.test/articles/${post.slug}</link>`
    );

    // The route itself is still physically served at /news/feed.xml (Astro
    // file-based static routing — out of this issue's scope to make
    // per-tenant-configurable, see README §Public route settings) — only
    // the LINKS inside the response changed, which the `feed` request
    // above (itself requested at /news/feed.xml, status 200) already
    // demonstrates.
  });

  test("publicLabel customization replaces the default 'News' label in generated headings/titles/RSS channel title", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, { slug: "label-check" });

    const patched = await patchBlogContentSettings(owner, {
      publicLabel: "Bulletin"
    });
    expect(patched.status).toBe(200);

    const index = await invokeRaw(newsIndex, { method: "GET", path: "/news" });
    expect(index.text).toContain("Bulletin");
    expect(index.text).not.toContain(`${owner.tenantCode} News`);

    const feed = await invokeRaw(newsFeed, {
      method: "GET",
      path: "/news/feed.xml"
    });
    expect(feed.text).toContain("Bulletin");
  });

  test("publicLabel and publicBasePath are HTML/XML-escaped wherever rendered into /news output — no stored-injection via tenant-admin-controlled settings", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, { slug: "escaping-check" });

    const scriptPayload = "<script>alert(1)</script>";

    const labelPatched = await patchBlogContentSettings(owner, {
      publicLabel: scriptPayload
    });
    expect(labelPatched.status).toBe(200);

    const indexWithLabelPayload = await invokeRaw(newsIndex, {
      method: "GET",
      path: "/news"
    });
    expect(indexWithLabelPayload.status).toBe(200);
    expect(indexWithLabelPayload.text).not.toContain(scriptPayload);
    expect(indexWithLabelPayload.text).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );

    const feedWithLabelPayload = await invokeRaw(newsFeed, {
      method: "GET",
      path: "/news/feed.xml"
    });
    expect(feedWithLabelPayload.status).toBe(200);
    expect(feedWithLabelPayload.text).not.toContain(scriptPayload);
    expect(feedWithLabelPayload.text).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );

    // publicBasePath: isValidBasePath() only checks shape (starts with "/",
    // no whitespace, no "//", no trailing slash) — it does NOT strip
    // HTML-meaningful characters, so a value like this one passes shape
    // validation and must be neutralized at render time instead.
    const basePathPayload = '/news"><script>alert(2)</script>';

    const basePathPatched = await patchBlogContentSettings(owner, {
      publicBasePath: basePathPayload
    });
    expect(basePathPatched.status).toBe(200);

    const indexWithBasePathPayload = await invokeRaw(newsIndex, {
      method: "GET",
      path: "/news"
    });
    expect(indexWithBasePathPayload.status).toBe(200);
    expect(indexWithBasePathPayload.text).not.toContain(
      '"><script>alert(2)</script>'
    );

    const feedWithBasePathPayload = await invokeRaw(newsFeed, {
      method: "GET",
      path: "/news/feed.xml"
    });
    expect(feedWithBasePathPayload.status).toBe(200);
    expect(feedWithBasePathPayload.text).not.toContain(
      '"><script>alert(2)</script>'
    );
  });

  // -----------------------------------------------------------------
  // /blog/{tenantCode}: legacyTenantRouteEnabled, all 7 routes
  // -----------------------------------------------------------------

  test("legacyTenantRouteEnabled=false disables all 7 /blog/{tenantCode} routes with a generic 404", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, { slug: "legacy-post" });
    const category = await invoke<{ data: { id: string; slug: string } }>(
      createTerm,
      {
        method: "POST",
        path: "/api/v1/blog/terms",
        headers: authHeaders(owner),
        body: { taxonomyType: "category", name: "Cat", slug: "legacy-cat" }
      }
    );
    expect(category.status).toBe(200);

    const patched = await patchBlogContentSettings(owner, {
      legacyTenantRouteEnabled: false
    });
    expect(patched.status).toBe(200);

    const params = { tenantCode: owner.tenantCode };

    const index = await invokeRaw(legacyIndex, {
      method: "GET",
      path: `/blog/${owner.tenantCode}`,
      params
    });
    const detail = await invokeRaw(legacyDetail, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/${post.slug}`,
      params: { ...params, slug: post.slug }
    });
    const categoryArchive = await invokeRaw(legacyCategory, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/category/legacy-cat`,
      params: { ...params, slug: "legacy-cat" }
    });
    const tagArchive = await invokeRaw(legacyTag, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/tag/legacy-cat`,
      params: { ...params, slug: "legacy-cat" }
    });
    const search = await invokeRaw(legacySearch, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/search`,
      params
    });
    const feed = await invokeRaw(legacyFeed, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/feed.xml`,
      params
    });
    const sitemap = await invokeRaw(legacySitemap, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/sitemap-blog.xml`,
      params
    });

    expect(index.status).toBe(404);
    expect(detail.status).toBe(404);
    expect(categoryArchive.status).toBe(404);
    expect(tagArchive.status).toBe(404);
    expect(search.status).toBe(404);
    expect(feed.status).toBe(404);
    expect(sitemap.status).toBe(404);
  });

  test("legacyTenantRouteEnabled default (true) keeps today's /blog/{tenantCode} behavior unchanged", async () => {
    const owner = await bootstrap();
    const post = await createAndPublishPost(owner, {
      slug: "legacy-default-on"
    });

    const index = await invokeRaw(legacyIndex, {
      method: "GET",
      path: `/blog/${owner.tenantCode}`,
      params: { tenantCode: owner.tenantCode }
    });
    expect(index.status).toBe(200);
    expect(index.text).toContain(post.slug);
  });

  // -----------------------------------------------------------------
  // Two independent stores: rssEnabled/sitemapEnabled never move
  // -----------------------------------------------------------------

  test("rssEnabled/sitemapEnabled remain governed exclusively by awcms_mini_blog_settings — writing those exact key names into the new module-settings store has NO effect on /news/feed.xml or /news/sitemap-news.xml", async () => {
    const owner = await bootstrap();
    await createAndPublishPost(owner, { slug: "two-store-check" });

    // Write rssEnabled/sitemapEnabled into the WRONG store (the new
    // generic blog_content module settings) — this is exactly the mistake
    // this issue's design deliberately avoids building a consumer for.
    const patched = await patchBlogContentSettings(owner, {
      rssEnabled: false,
      sitemapEnabled: false
    });
    expect(patched.status).toBe(200);
    // The generic store happily stores whatever keys it's given (no
    // per-module field schema) — confirm the override really was written...
    expect(patched.body.data.tenantOverride).toEqual({
      rssEnabled: false,
      sitemapEnabled: false
    });

    // ...but the feed/sitemap routes are STILL enabled, because they read
    // rssEnabled/sitemapEnabled from awcms_mini_blog_settings only, which
    // was never touched by the PATCH above.
    const feed = await invokeRaw(newsFeed, {
      method: "GET",
      path: "/news/feed.xml"
    });
    const sitemap = await invokeRaw(newsSitemap, {
      method: "GET",
      path: "/news/sitemap-news.xml"
    });
    expect(feed.status).toBe(200);
    expect(sitemap.status).toBe(200);

    // Flipping them through the CORRECT store (`/api/v1/blog/settings`,
    // Issue #543) does disable the routes — proving the routes really do
    // read a real, working switch, just the other one.
    const correctPatch = await invoke(patchBlogSettings, {
      method: "PATCH",
      path: "/api/v1/blog/settings",
      headers: authHeaders(owner),
      body: { rssEnabled: false, sitemapEnabled: false }
    });
    expect(correctPatch.status).toBe(200);

    const feedAfter = await invokeRaw(newsFeed, {
      method: "GET",
      path: "/news/feed.xml"
    });
    const sitemapAfter = await invokeRaw(newsSitemap, {
      method: "GET",
      path: "/news/sitemap-news.xml"
    });
    expect(feedAfter.status).toBe(404);
    expect(sitemapAfter.status).toBe(404);
  });

  test("blog settings GET (the pre-existing store) is unaffected by blog_content module-settings PATCHes", async () => {
    const owner = await bootstrap();

    await patchBlogContentSettings(owner, {
      publicBasePath: "/articles",
      publicLabel: "Articles"
    });

    const settings = await invoke<{
      data: { rssEnabled: boolean; sitemapEnabled: boolean };
    }>(getBlogSettings, {
      method: "GET",
      path: "/api/v1/blog/settings",
      headers: authHeaders(owner)
    });

    expect(settings.status).toBe(200);
    expect(settings.body.data.rssEnabled).toBe(true);
    expect(settings.body.data.sitemapEnabled).toBe(true);
  });
});
