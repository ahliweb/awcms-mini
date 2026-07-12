/**
 * Integration tests for Issue #642 (epic `news_portal`): public social
 * share buttons + Open Graph/Twitter Card metadata on the real
 * `/news/{slug}` and `/blog/{tenantCode}/{slug}` detail routes. Unlike
 * Issue #636 (`blog-content-news-media-r2-references.integration.test.ts`),
 * this feature does NOT depend on the full-online R2-only preset at all —
 * share buttons work for any published post regardless of
 * `NEWS_PORTAL_ENABLED`/`NEWS_MEDIA_R2_ENABLED`, so these tests never call
 * `applyNewsPortalFullOnlineR2Preset`.
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
import { GET as newsDetail } from "../../src/pages/news/[slug]";
import { GET as legacyBlogDetail } from "../../src/pages/blog/[tenantCode]/[slug]";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; tenantCode: string; token: string };

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

async function createPostAs(
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
        title: "Share Me & Read <b>this</b>",
        slug,
        excerpt: "A short excerpt.",
        contentJson: { blocks: [{ type: "paragraph", text: "Hello world" }] },
        contentText: "Hello world",
        ...overrides
      }
    }
  );
  expect(created.status).toBe(200);
  return { id: created.body.data.id, slug: created.body.data.slug };
}

async function publish(owner: Bootstrap, postId: string): Promise<void> {
  const published = await invoke(publishPost, {
    method: "POST",
    path: `/api/v1/blog/posts/${postId}/publish`,
    headers: { ...authHeaders(owner), "idempotency-key": crypto.randomUUID() },
    params: { id: postId }
  });
  expect(published.status).toBe(200);
}

/** Same env-override-then-restore helper `blog-content-public-news.integration.test.ts` uses. */
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

suite("public social share buttons (Issue #642)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    for (const key of [
      "NEWS_SHARE_BUTTONS_ENABLED",
      "NEWS_SHARE_NATIVE_ENABLED",
      "NEWS_SHARE_WHATSAPP_ENABLED",
      "NEWS_SHARE_INSTAGRAM_NATIVE_ONLY"
    ]) {
      delete process.env[key];
    }
  });

  test("/news/{slug} renders the full share widget + Open Graph/Twitter Card tags for a published post by default", async () => {
    const owner = await bootstrap();
    const { id, slug } = await createPostAs(owner);
    await publish(owner, id);

    const response = await invokeRaw(newsDetail, {
      method: "GET",
      path: `/news/${slug}`,
      params: { slug }
    });

    expect(response.status).toBe(200);
    const canonicalUrl = `http://integration.test/news/${slug}`;

    // Open Graph / Twitter Card metadata (issue acceptance criteria).
    expect(response.text).toContain(
      `<meta property="og:url" content="${canonicalUrl}" />`
    );
    expect(response.text).toContain('<meta property="og:title"');
    expect(response.text).toContain('<meta property="og:description"');
    expect(response.text).toContain('<meta name="twitter:title"');
    expect(response.text).toContain('<meta name="twitter:description"');
    expect(response.text).toContain(
      `<meta property="og:site_name" content="Acme" />`
    );

    // Share widget: static platform links present, canonical URL used.
    expect(response.text).toContain("news-share__link--whatsapp");
    expect(response.text).toContain("news-share__link--telegram");
    expect(response.text).toContain("news-share__link--facebook");
    expect(response.text).toContain("news-share__link--linkedin");
    expect(response.text).toContain("news-share__link--x_twitter");
    expect(response.text).toContain("news-share__link--email");
    expect(response.text).toContain(
      `data-share-url="${canonicalUrl}"` // native + copy-link buttons
    );
    expect(response.text).toContain('src="/js/news-share.js"');
    // No third-party script.
    expect(response.text).not.toMatch(/<script[^>]*src="https?:\/\//);
  });

  test("NEWS_SHARE_BUTTONS_ENABLED=false disables the entire widget (og tags stay present)", async () => {
    const owner = await bootstrap();
    const { id, slug } = await createPostAs(owner);
    await publish(owner, id);

    await withEnvOverride({ NEWS_SHARE_BUTTONS_ENABLED: "false" }, async () => {
      const response = await invokeRaw(newsDetail, {
        method: "GET",
        path: `/news/${slug}`,
        params: { slug }
      });

      expect(response.status).toBe(200);
      expect(response.text).not.toContain("news-share");
      expect(response.text).not.toContain("news-share.js");
      // SEO metadata is independent of the share-widget flag.
      expect(response.text).toContain('<meta property="og:title"');
    });
  });

  test("NEWS_SHARE_WHATSAPP_ENABLED=false disables only the WhatsApp link", async () => {
    const owner = await bootstrap();
    const { id, slug } = await createPostAs(owner);
    await publish(owner, id);

    await withEnvOverride(
      { NEWS_SHARE_WHATSAPP_ENABLED: "false" },
      async () => {
        const response = await invokeRaw(newsDetail, {
          method: "GET",
          path: `/news/${slug}`,
          params: { slug }
        });

        expect(response.status).toBe(200);
        expect(response.text).not.toContain("news-share__link--whatsapp");
        expect(response.text).toContain("news-share__link--telegram");
      }
    );
  });

  test("draft (never-published) post never renders the share widget — 404, same as any other public route gate", async () => {
    const owner = await bootstrap();
    const { slug } = await createPostAs(owner);

    const response = await invokeRaw(newsDetail, {
      method: "GET",
      path: `/news/${slug}`,
      params: { slug }
    });

    expect(response.status).toBe(404);
    expect(response.text).not.toContain("news-share");
  });

  test("share links use the server-resolved canonical URL, never the request's raw querystring/tracking parameters", async () => {
    const owner = await bootstrap();
    const { id, slug } = await createPostAs(owner);
    await publish(owner, id);

    const response = await invokeRaw(newsDetail, {
      method: "GET",
      path: `/news/${slug}?utm_source=newsletter&session_id=abc123`,
      params: { slug }
    });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain("utm_source");
    expect(response.text).not.toContain("session_id");
    expect(response.text).toContain(
      `data-share-url="http://integration.test/news/${slug}"`
    );
  });

  test("legacy /blog/{tenantCode}/{slug} route renders the same share widget", async () => {
    const owner = await bootstrap();
    const { id, slug } = await createPostAs(owner);
    await publish(owner, id);

    const response = await invokeRaw(legacyBlogDetail, {
      method: "GET",
      path: `/blog/${owner.tenantCode}/${slug}`,
      params: { tenantCode: owner.tenantCode, slug }
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain("news-share__link--whatsapp");
    expect(response.text).toContain(
      `<meta property="og:site_name" content="Acme" />`
    );
  });
});
