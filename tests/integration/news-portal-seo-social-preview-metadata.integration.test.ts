/**
 * Integration tests for Issue #649 (epic `news_portal`): full SEO/social
 * preview metadata on the real `/news/{slug}` public post detail route —
 * Open Graph image dimensions/MIME/secure_url, Twitter image alt,
 * article:* tags, `NewsArticle` JSON-LD, the image source-priority chain
 * (explicit SEO image > featured image > content image > tenant fallback),
 * robots directive by visibility, and draft/scheduled-future/soft-deleted
 * content never leaking any of this. Complements (does not duplicate):
 * - `news-portal-share-buttons.integration.test.ts` (Issue #642) — already
 *   covers og:title/description/url/site_name and canonical-URL-not-from-
 *   querystring.
 * - `blog-content-news-media-r2-references.integration.test.ts` (Issue
 *   #636) — already covers featuredMediaId/gallery R2-only write-time
 *   validation and basic og:image-from-featured-image rendering.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import {
  afterAll,
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
import { PATCH as updatePost } from "../../src/pages/api/v1/blog/posts/[id]";
import { POST as publishPost } from "../../src/pages/api/v1/blog/posts/[id]/publish";
import { PATCH as patchBlogSettings } from "../../src/pages/api/v1/blog/settings";
import { GET as getNewsDetail } from "../../src/pages/news/[slug]";
import { GET as getNewsFeed } from "../../src/pages/news/feed.xml";
import { GET as getNewsSitemap } from "../../src/pages/news/sitemap-news.xml";
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";
import { applyNewsPortalFullOnlineR2Preset } from "../../src/modules/news-portal/application/apply-news-portal-preset";
import type { NewsMediaR2Config } from "../../src/modules/news-portal/domain/news-media-r2-config";
import {
  createPendingNewsMediaObject,
  markNewsMediaObjectUploaded,
  markNewsMediaObjectVerified,
  type NewsMediaObjectView
} from "../../src/modules/news-portal/application/news-media-object-directory";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

const FULLY_CONFIGURED_ENV = {
  NEWS_PORTAL_ENABLED: "true",
  NEWS_PORTAL_PROFILE: "full_online_r2",
  NEWS_MEDIA_R2_ENABLED: "true",
  NEWS_MEDIA_R2_ACCOUNT_ID: "acct",
  NEWS_MEDIA_R2_ACCESS_KEY_ID: "news-key",
  NEWS_MEDIA_R2_SECRET_ACCESS_KEY: "news-secret",
  NEWS_MEDIA_R2_BUCKET: "news-media-bucket",
  NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://media.example.test"
} as NodeJS.ProcessEnv;

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

type Bootstrap = { tenantId: string; token: string; tenantUserId: string };

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

async function activateFullOnlineR2Mode(owner: Bootstrap): Promise<void> {
  Object.assign(process.env, FULLY_CONFIGURED_ENV);

  const sql = getDatabaseClient();
  const result = await withTenant(sql, owner.tenantId, (tx) =>
    applyNewsPortalFullOnlineR2Preset(
      tx,
      owner.tenantId,
      owner.tenantUserId,
      FULLY_CONFIGURED_ENV
    )
  );
  expect(result.outcome).toBe("applied");
}

async function seedVerifiedMediaObject(
  tenantId: string,
  actorTenantUserId: string,
  overrides: { altText?: string; width?: number; height?: number } = {}
): Promise<NewsMediaObjectView> {
  const sql = getDatabaseClient();

  return withTenant(sql, tenantId, async (tx) => {
    const created = await createPendingNewsMediaObject(
      tx,
      tenantId,
      actorTenantUserId,
      MEDIA_CONFIG,
      { mimeType: "image/jpeg", altText: overrides.altText }
    );

    await markNewsMediaObjectUploaded(tx, tenantId, created.id, {
      sizeBytes: 12_345,
      checksumSha256: "a".repeat(64)
    });

    return (await markNewsMediaObjectVerified(
      tx,
      tenantId,
      actorTenantUserId,
      created.id,
      { width: overrides.width ?? 1200, height: overrides.height ?? 630 }
    ))!;
  });
}

function validCreatePostBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "Hello News",
    slug: `hello-news-${Math.random().toString(36).slice(2, 8)}`,
    excerpt: "An excerpt",
    contentJson: { blocks: [{ type: "paragraph", text: "Body text" }] },
    contentText: "Body text",
    locale: "en",
    ...overrides
  };
}

async function createAndPublish(
  owner: Bootstrap,
  overrides: Record<string, unknown> = {}
): Promise<{ id: string; slug: string }> {
  const body = validCreatePostBody(overrides);
  const created = await invoke<{ data: { id: string; slug: string } }>(
    createPost,
    {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body
    }
  );
  expect(created.status).toBe(200);

  const published = await invoke(publishPost, {
    method: "POST",
    path: `/api/v1/blog/posts/${created.body.data.id}/publish`,
    headers: {
      ...authHeaders(owner),
      "idempotency-key": crypto.randomUUID()
    },
    params: { id: created.body.data.id }
  });
  expect(published.status).toBe(200);

  return { id: created.body.data.id, slug: created.body.data.slug };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("news portal SEO/social preview metadata (Issue #649)", () => {
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  afterAll(() => {
    process.env = previousEnv;
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env = { ...previousEnv };
  });

  test("full Open Graph image metadata (type/width/height/secure_url) + Twitter image alt + article:* + NewsArticle JSON-LD render for a published post with a verified featured image", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);
    const featuredMedia = await seedVerifiedMediaObject(
      owner.tenantId,
      owner.tenantUserId,
      { altText: "A scenic photo", width: 1600, height: 900 }
    );

    const { slug } = await createAndPublish(owner, {
      featuredMediaId: featuredMedia.id
    });

    const response = await invokeRaw(getNewsDetail, {
      method: "GET",
      path: `/news/${slug}`,
      params: { slug }
    });

    expect(response.status).toBe(200);

    // Open Graph image metadata.
    expect(response.text).toContain(
      `<meta property="og:image" content="${featuredMedia.publicUrl}" />`
    );
    expect(response.text).toContain(
      `<meta property="og:image:secure_url" content="${featuredMedia.publicUrl}" />`
    );
    expect(response.text).toContain(
      '<meta property="og:image:type" content="image/jpeg" />'
    );
    expect(response.text).toContain(
      '<meta property="og:image:width" content="1600" />'
    );
    expect(response.text).toContain(
      '<meta property="og:image:height" content="900" />'
    );
    expect(response.text).toContain(
      '<meta property="og:image:alt" content="A scenic photo" />'
    );
    expect(response.text).toContain(
      '<meta name="twitter:image:alt" content="A scenic photo" />'
    );
    expect(response.text).toContain(
      '<meta property="og:type" content="article" />'
    );
    expect(response.text).toContain(
      '<meta property="og:locale" content="en_US" />'
    );

    // article:published_time/modified_time present, ISO 8601.
    expect(response.text).toMatch(
      /<meta property="article:published_time" content="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z" \/>/
    );
    expect(response.text).toMatch(
      /<meta property="article:modified_time" content="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z" \/>/
    );

    // NewsArticle JSON-LD.
    expect(response.text).toContain('<script type="application/ld+json">');
    expect(response.text).toContain('"@type":"NewsArticle"');
    expect(response.text).toContain(`"url":"${featuredMedia.publicUrl}"`);
    expect(response.text).toContain(`"width":1600`);
    expect(response.text).toContain(`"height":900`);
    expect(response.text).toContain(
      `"@id":"http://integration.test/news/${slug}"`
    );

    // Public/published post gets the fully-indexable robots directive.
    expect(response.text).toContain(
      '<meta name="robots" content="index,follow,max-image-preview:large" />'
    );
  });

  test("image priority: explicit seoImageMediaId wins over featuredMediaId", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);
    const featuredMedia = await seedVerifiedMediaObject(
      owner.tenantId,
      owner.tenantUserId,
      { altText: "Featured alt" }
    );
    const seoMedia = await seedVerifiedMediaObject(
      owner.tenantId,
      owner.tenantUserId,
      { altText: "SEO override alt" }
    );

    const { slug } = await createAndPublish(owner, {
      featuredMediaId: featuredMedia.id,
      seoImageMediaId: seoMedia.id
    });

    const response = await invokeRaw(getNewsDetail, {
      method: "GET",
      path: `/news/${slug}`,
      params: { slug }
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      `<meta property="og:image" content="${seoMedia.publicUrl}" />`
    );
    expect(response.text).not.toContain(featuredMedia.publicUrl);
    expect(response.text).toContain(
      '<meta property="og:image:alt" content="SEO override alt" />'
    );
  });

  test("image priority: tenant fallback social image is used when the post has no featured/SEO/content image", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);
    const fallbackMedia = await seedVerifiedMediaObject(
      owner.tenantId,
      owner.tenantUserId,
      { altText: "Fallback alt" }
    );

    const settingsPatch = await invoke(patchBlogSettings, {
      method: "PATCH",
      path: "/api/v1/blog/settings",
      headers: authHeaders(owner),
      body: { socialPreviewFallbackImageMediaId: fallbackMedia.id }
    });
    expect(settingsPatch.status).toBe(200);

    const { slug } = await createAndPublish(owner);

    const response = await invokeRaw(getNewsDetail, {
      method: "GET",
      path: `/news/${slug}`,
      params: { slug }
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      `<meta property="og:image" content="${fallbackMedia.publicUrl}" />`
    );
  });

  test("no verified image anywhere: og:image/twitter:image/JSON-LD image are all omitted, never fabricated from a local/external source", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);

    const { slug } = await createAndPublish(owner);

    const response = await invokeRaw(getNewsDetail, {
      method: "GET",
      path: `/news/${slug}`,
      params: { slug }
    });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain("og:image");
    expect(response.text).not.toContain("twitter:image");
    // JSON-LD is still rendered (canonical URL is always present), just
    // without an `image` key.
    expect(response.text).toContain('"@type":"NewsArticle"');
    expect(response.text).not.toContain('"image":');
  });

  test("unlisted visibility renders noindex,nofollow (reachable by direct link, excluded from indexing)", async () => {
    const owner = await bootstrap();
    const { slug } = await createAndPublish(owner, { visibility: "unlisted" });

    const response = await invokeRaw(getNewsDetail, {
      method: "GET",
      path: `/news/${slug}`,
      params: { slug }
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      '<meta name="robots" content="noindex,nofollow" />'
    );
  });

  test("draft (never-published) post 404s — no metadata of any kind rendered, including robots/JSON-LD", async () => {
    const owner = await bootstrap();
    const body = validCreatePostBody();
    const created = await invoke<{ data: { slug: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body
    });
    expect(created.status).toBe(200);

    const response = await invokeRaw(getNewsDetail, {
      method: "GET",
      path: `/news/${created.body.data.slug}`,
      params: { slug: created.body.data.slug }
    });

    expect(response.status).toBe(404);
    expect(response.text).not.toContain("robots");
    expect(response.text).not.toContain("application/ld+json");
  });

  test("category/tag terms populate article:section/article:tag and JSON-LD articleSection/keywords", async () => {
    const owner = await bootstrap();

    const admin = getAdminSql();
    const categoryRows = (await admin`
      INSERT INTO awcms_mini_blog_terms (tenant_id, taxonomy_type, name, slug)
      VALUES (${owner.tenantId}, 'category', 'Politics', 'politics')
      RETURNING id
    `) as { id: string }[];
    const tagRows = (await admin`
      INSERT INTO awcms_mini_blog_terms (tenant_id, taxonomy_type, name, slug)
      VALUES (${owner.tenantId}, 'tag', 'Breaking', 'breaking')
      RETURNING id
    `) as { id: string }[];

    const { slug } = await createAndPublish(owner, {
      termIds: [categoryRows[0]!.id, tagRows[0]!.id]
    });

    const response = await invokeRaw(getNewsDetail, {
      method: "GET",
      path: `/news/${slug}`,
      params: { slug }
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      '<meta property="article:section" content="Politics" />'
    );
    expect(response.text).toContain(
      '<meta property="article:tag" content="Breaking" />'
    );
    expect(response.text).toContain('"articleSection":"Politics"');
    expect(response.text).toContain('"keywords":"Breaking"');
  });

  test("title/description containing HTML/script-like content is escaped everywhere, including inside the JSON-LD script tag", async () => {
    const owner = await bootstrap();
    const { slug } = await createAndPublish(owner, {
      title: "Breaking </script><script>alert(1)</script> News",
      seoTitle: null,
      metaDescription: "Desc with </script> inside"
    });

    const response = await invokeRaw(getNewsDetail, {
      method: "GET",
      path: `/news/${slug}`,
      params: { slug }
    });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain("</script><script>alert(1)</script>");
    expect(response.text).not.toContain("<script>alert(1)</script>");
    // The JSON-LD script's own serialization neutralizes every `<` as
    // <, which is sufficient to defeat the HTML tokenizer's
    // `</script` lookup inside the embedded JSON string.
    expect(response.text).toContain("\\u003c/script>");
  });

  test("PATCH /api/v1/blog/posts/{id} can update seoImageMediaId independently of featuredMediaId", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);
    const seoMedia = await seedVerifiedMediaObject(
      owner.tenantId,
      owner.tenantUserId
    );

    const created = await invoke<{ data: { id: string } }>(createPost, {
      method: "POST",
      path: "/api/v1/blog/posts",
      headers: authHeaders(owner),
      body: validCreatePostBody()
    });
    expect(created.status).toBe(200);

    const updated = await invoke<{ data: { seoImageMediaId: string } }>(
      updatePost,
      {
        method: "PATCH",
        path: `/api/v1/blog/posts/${created.body.data.id}`,
        headers: authHeaders(owner),
        params: { id: created.body.data.id },
        body: { seoImageMediaId: seoMedia.id }
      }
    );

    expect(updated.status).toBe(200);
    expect(updated.body.data.seoImageMediaId).toBe(seoMedia.id);
  });

  test("RSS feed includes an <enclosure> with the verified R2 preview image", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);
    const featuredMedia = await seedVerifiedMediaObject(
      owner.tenantId,
      owner.tenantUserId
    );
    await createAndPublish(owner, { featuredMediaId: featuredMedia.id });

    const response = await invokeRaw(getNewsFeed, {
      method: "GET",
      path: "/news/feed.xml"
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      `<enclosure url="${featuredMedia.publicUrl}" length="12345" type="image/jpeg" />`
    );
  });

  test("News sitemap includes an <image:image> entry with the verified R2 preview image", async () => {
    const owner = await bootstrap();
    await activateFullOnlineR2Mode(owner);
    const featuredMedia = await seedVerifiedMediaObject(
      owner.tenantId,
      owner.tenantUserId
    );
    await createAndPublish(owner, { featuredMediaId: featuredMedia.id });

    const response = await invokeRaw(getNewsSitemap, {
      method: "GET",
      path: "/news/sitemap-news.xml"
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"'
    );
    expect(response.text).toContain(
      `<image:image><image:loc>${featuredMedia.publicUrl}</image:loc></image:image>`
    );
  });

  test("RSS/sitemap omit the image entry entirely when no verified preview image resolves", async () => {
    const owner = await bootstrap();
    await createAndPublish(owner);

    const feedResponse = await invokeRaw(getNewsFeed, {
      method: "GET",
      path: "/news/feed.xml"
    });
    const sitemapResponse = await invokeRaw(getNewsSitemap, {
      method: "GET",
      path: "/news/sitemap-news.xml"
    });

    expect(feedResponse.status).toBe(200);
    expect(feedResponse.text).not.toContain("<enclosure");
    expect(sitemapResponse.status).toBe(200);
    expect(sitemapResponse.text).not.toContain("<image:image>");
  });
});
