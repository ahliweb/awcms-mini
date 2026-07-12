/**
 * Integration tests for Issue #641 (epic `news_portal`, feature lives in
 * `blog_content`): automatic internal tag linking — tenant/settings API,
 * per-post preview API, and end-to-end render wiring on the public
 * `/news/{slug}` route. Same bootstrap/auth-header conventions as
 * `blog-content-public-news.integration.test.ts`/
 * `blog-content-quality-checklist.integration.test.ts`.
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
import { POST as createTerm } from "../../src/pages/api/v1/blog/terms/index";
import {
  GET as getInternalTagLinkSettings,
  PATCH as updateInternalTagLinkSettings
} from "../../src/pages/api/v1/blog/internal-tag-links/settings";
import { GET as previewInternalTagLinks } from "../../src/pages/api/v1/blog/posts/[id]/internal-links/preview";
import { GET as newsDetail } from "../../src/pages/news/[slug]";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = {
  tenantId: string;
  tenantCode: string;
  token: string;
  tenantUserId: string;
};

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
    tenantCode,
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

/**
 * `POST /api/v1/setup/initialize` is a once-per-database singleton lock
 * (see `src/pages/api/v1/setup/initialize.ts`: "Setup has already been
 * completed" 403) — it cannot be called twice within one test to bootstrap
 * two tenants. For any test needing a genuine SECOND tenant in the SAME
 * test (cross-tenant isolation/rejection scenarios), this raw-SQL helper
 * provisions one directly, same pattern
 * `blog-content-admin-ui.integration.test.ts`'s
 * `provisionSecondTenantWithBlogPostAccess` uses — granting exactly the
 * permissions these tests need (posts create/read/publish, taxonomies
 * configure/read, internal_links read/configure/preview).
 */
async function provisionSecondTenant(tenantCode: string): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const password = "integration-test-tenant-b-password";
  const loginIdentifier = `${tenantCode}-user@example.com`;
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
    VALUES (${tenantId}, ${tenantCode}, ${tenantCode})
  `;

  const passwordHash = await Bun.password.hash(password);
  let tenantUserId = "";

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Tenant B User') RETURNING id
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
    tenantUserId = tenantUser[0]!.id;
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'internal_links_tester', 'Internal Links Tester') RETURNING id
    `) as { id: string }[];
    const permissions = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE (module_key = 'blog_content' AND activity_code = 'posts' AND action IN ('create', 'read', 'publish'))
         OR (module_key = 'blog_content' AND activity_code = 'taxonomies' AND action IN ('configure', 'read'))
         OR (module_key = 'blog_content' AND activity_code = 'internal_links' AND action IN ('read', 'configure', 'preview'))
    `) as { id: string }[];

    for (const permission of permissions) {
      await tx`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        VALUES (${tenantId}, ${role[0]!.id}, ${permission.id})
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

  return {
    tenantId,
    tenantCode,
    token: login.body.data.token,
    tenantUserId
  };
}

async function createTag(
  owner: Bootstrap,
  name: string,
  slug: string
): Promise<string> {
  const created = await invoke<{ data: { id: string } }>(createTerm, {
    method: "POST",
    path: "/api/v1/blog/terms",
    headers: authHeaders(owner),
    body: { taxonomyType: "tag", name, slug }
  });
  expect(created.status).toBe(200);
  return created.body.data.id;
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
        contentJson: {
          blocks: [{ type: "paragraph", text: "Jakarta is a busy city." }]
        },
        contentText: "Jakarta is a busy city.",
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

const suite = integrationEnabled ? describe : describe.skip;

suite("automatic internal tag linking (Issue #641)", () => {
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

  test("public /news/{slug} links a matching tag to its canonical archive URL", async () => {
    const owner = await bootstrap();
    await createTag(owner, "Jakarta", "jakarta");
    const post = await createAndPublishPost(owner, { slug: "jakarta-news" });

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: `/news/${post.slug}`,
      params: { slug: post.slug }
    });

    expect(detail.status).toBe(200);
    expect(detail.text).toContain(
      '<a href="/news/tag/jakarta" class="auto-internal-link"'
    );
  });

  test("tag from a different tenant never gets linked (tenant isolation)", async () => {
    const ownerA = await bootstrap("acme-a", "Acme A");
    const ownerB = await provisionSecondTenant("acme-b");
    await createTag(ownerA, "Jakarta", "jakarta");
    // ownerB never created a "Jakarta" tag.
    const post = await createAndPublishPost(ownerB, { slug: "no-tag-post" });

    // `ownerB` was provisioned via raw SQL, not `/setup/initialize`, so it
    // is not the tenant `/news`'s setup-state fallback would resolve by
    // default -- force resolution to tenant B specifically (same
    // `PUBLIC_TENANT_RESOLUTION_MODE=env_default` pattern
    // `blog-content-public-news.integration.test.ts`'s own cross-tenant
    // test uses) so this test actually exercises tenant B's render path.
    process.env.PUBLIC_TENANT_RESOLUTION_MODE = "env_default";
    process.env.PUBLIC_DEFAULT_TENANT_ID = ownerB.tenantId;
    try {
      const detail = await invokeRaw(newsDetail, {
        method: "GET",
        path: `/news/${post.slug}`,
        params: { slug: post.slug }
      });

      expect(detail.status).toBe(200);
      expect(detail.text).not.toContain("auto-internal-link");
    } finally {
      delete process.env.PUBLIC_TENANT_RESOLUTION_MODE;
      delete process.env.PUBLIC_DEFAULT_TENANT_ID;
    }
  });

  test("per-post disable suppresses linking for that post only", async () => {
    const owner = await bootstrap();
    await createTag(owner, "Jakarta", "jakarta");
    const post = await createAndPublishPost(owner, { slug: "disabled-post" });

    const updated = await invoke(updatePost, {
      method: "PATCH",
      path: `/api/v1/blog/posts/${post.id}`,
      headers: authHeaders(owner),
      params: { id: post.id },
      body: { autoInternalTagLinksDisabled: true }
    });
    expect(updated.status).toBe(200);

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: `/news/${post.slug}`,
      params: { slug: post.slug }
    });

    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain("auto-internal-link");
  });

  test("tenant-level disable (via settings PATCH) suppresses linking for every post", async () => {
    const owner = await bootstrap();
    await createTag(owner, "Jakarta", "jakarta");
    const post = await createAndPublishPost(owner, { slug: "tenant-off-post" });

    const patched = await invoke(updateInternalTagLinkSettings, {
      method: "PATCH",
      path: "/api/v1/blog/internal-tag-links/settings",
      headers: authHeaders(owner),
      body: { enabled: false }
    });
    expect(patched.status).toBe(200);

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: `/news/${post.slug}`,
      params: { slug: post.slug }
    });

    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain("auto-internal-link");
  });

  test("deployment-level disable (env var) suppresses linking regardless of tenant policy", async () => {
    const owner = await bootstrap();
    await createTag(owner, "Jakarta", "jakarta");
    const post = await createAndPublishPost(owner, { slug: "deploy-off-post" });

    process.env.BLOG_AUTO_INTERNAL_TAG_LINKS_ENABLED = "false";
    try {
      const detail = await invokeRaw(newsDetail, {
        method: "GET",
        path: `/news/${post.slug}`,
        params: { slug: post.slug }
      });

      expect(detail.status).toBe(200);
      expect(detail.text).not.toContain("auto-internal-link");
    } finally {
      delete process.env.BLOG_AUTO_INTERNAL_TAG_LINKS_ENABLED;
    }
  });

  test("per-tag disable suppresses linking for that specific tag only", async () => {
    const owner = await bootstrap();
    const jakartaId = await createTag(owner, "Jakarta", "jakarta");
    await createTag(owner, "Bandung", "bandung");
    const post = await createAndPublishPost(owner, {
      slug: "two-tags-post",
      contentJson: {
        blocks: [
          { type: "paragraph", text: "Jakarta and Bandung are both cities." }
        ]
      },
      contentText: "Jakarta and Bandung are both cities."
    });

    const patched = await invoke(updateInternalTagLinkSettings, {
      method: "PATCH",
      path: "/api/v1/blog/internal-tag-links/settings",
      headers: authHeaders(owner),
      body: { disabledTagIds: [jakartaId] }
    });
    expect(patched.status).toBe(200);

    const detail = await invokeRaw(newsDetail, {
      method: "GET",
      path: `/news/${post.slug}`,
      params: { slug: post.slug }
    });

    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain('data-tag-id="' + jakartaId + '"');
    expect(detail.text).toContain('href="/news/tag/bandung"');
  });

  describe("GET/PATCH /api/v1/blog/internal-tag-links/settings", () => {
    test("GET returns defaults when never configured", async () => {
      const owner = await bootstrap();
      const result = await invoke<{
        data: { enabled: boolean; disabledTagIds: string[] };
      }>(getInternalTagLinkSettings, {
        method: "GET",
        path: "/api/v1/blog/internal-tag-links/settings",
        headers: authHeaders(owner)
      });

      expect(result.status).toBe(200);
      expect(result.body.data.enabled).toBe(true);
      expect(result.body.data.disabledTagIds).toEqual([]);
    });

    test("PATCH rejects a disabledTagIds entry that is not a real tag for this tenant", async () => {
      const owner = await bootstrap();
      const fakeId = crypto.randomUUID();
      const result = await invoke(updateInternalTagLinkSettings, {
        method: "PATCH",
        path: "/api/v1/blog/internal-tag-links/settings",
        headers: authHeaders(owner),
        body: { disabledTagIds: [fakeId] }
      });

      expect(result.status).toBe(400);
    });

    test("PATCH rejects another tenant's tag id in disabledTagIds (cross-tenant rejection)", async () => {
      const ownerA = await bootstrap("acme-a2", "Acme A2");
      const ownerB = await provisionSecondTenant("acme-b2");
      const tagFromA = await createTag(ownerA, "Jakarta", "jakarta");

      const result = await invoke(updateInternalTagLinkSettings, {
        method: "PATCH",
        path: "/api/v1/blog/internal-tag-links/settings",
        headers: authHeaders(ownerB),
        body: { disabledTagIds: [tagFromA] }
      });

      expect(result.status).toBe(400);
    });

    test("PATCH persists enabled/caseInsensitive/disabledTagIds and GET reflects it", async () => {
      const owner = await bootstrap();
      const tagId = await createTag(owner, "Jakarta", "jakarta");

      const patched = await invoke(updateInternalTagLinkSettings, {
        method: "PATCH",
        path: "/api/v1/blog/internal-tag-links/settings",
        headers: authHeaders(owner),
        body: {
          enabled: false,
          caseInsensitive: true,
          disabledTagIds: [tagId]
        }
      });
      expect(patched.status).toBe(200);

      const result = await invoke<{
        data: {
          enabled: boolean;
          tenantEnabled: boolean;
          caseInsensitive: boolean;
          disabledTagIds: string[];
        };
      }>(getInternalTagLinkSettings, {
        method: "GET",
        path: "/api/v1/blog/internal-tag-links/settings",
        headers: authHeaders(owner)
      });

      expect(result.status).toBe(200);
      expect(result.body.data.tenantEnabled).toBe(false);
      expect(result.body.data.enabled).toBe(false);
      expect(result.body.data.caseInsensitive).toBe(true);
      expect(result.body.data.disabledTagIds).toEqual([tagId]);
    });

    test("PATCH records an audit event", async () => {
      const owner = await bootstrap();
      const patched = await invoke(updateInternalTagLinkSettings, {
        method: "PATCH",
        path: "/api/v1/blog/internal-tag-links/settings",
        headers: authHeaders(owner),
        body: { enabled: false }
      });
      expect(patched.status).toBe(200);

      const admin = getAdminSql();
      const events = (await admin`
        SELECT action FROM awcms_mini_audit_events
        WHERE tenant_id = ${owner.tenantId}
          AND action = 'blog.internal_tag_linking.settings_updated'
      `) as { action: string }[];

      expect(events.length).toBeGreaterThan(0);
    });

    test("GET/PATCH require authentication", async () => {
      const owner = await bootstrap();
      const unauthenticatedHeaders = {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId
      };

      const getResult = await invoke(getInternalTagLinkSettings, {
        method: "GET",
        path: "/api/v1/blog/internal-tag-links/settings",
        headers: unauthenticatedHeaders
      });
      expect(getResult.status).toBe(401);

      const patchResult = await invoke(updateInternalTagLinkSettings, {
        method: "PATCH",
        path: "/api/v1/blog/internal-tag-links/settings",
        headers: unauthenticatedHeaders,
        body: { enabled: false }
      });
      expect(patchResult.status).toBe(401);
    });
  });

  describe("GET /api/v1/blog/posts/{id}/internal-links/preview", () => {
    test("previews matches for a draft post's current content, before publish", async () => {
      const owner = await bootstrap();
      await createTag(owner, "Jakarta", "jakarta");

      const draft = await invoke<{ data: { id: string } }>(createPost, {
        method: "POST",
        path: "/api/v1/blog/posts",
        headers: authHeaders(owner),
        body: {
          title: "Draft with Jakarta",
          slug: "preview-draft",
          contentJson: {
            blocks: [{ type: "paragraph", text: "Jakarta news today." }]
          },
          contentText: "Jakarta news today."
        }
      });
      expect(draft.status).toBe(200);

      const preview = await invoke<{
        data: {
          enabled: boolean;
          matches: { tagName: string; url: string }[];
          totalLinked: number;
        };
      }>(previewInternalTagLinks, {
        method: "GET",
        path: `/api/v1/blog/posts/${draft.body.data.id}/internal-links/preview`,
        headers: authHeaders(owner),
        params: { id: draft.body.data.id }
      });

      expect(preview.status).toBe(200);
      expect(preview.body.data.enabled).toBe(true);
      expect(preview.body.data.totalLinked).toBe(1);
      expect(preview.body.data.matches[0]?.tagName).toBe("Jakarta");
    });

    test("reports post_disabled reason when the post has opted out", async () => {
      const owner = await bootstrap();
      await createTag(owner, "Jakarta", "jakarta");

      const draft = await invoke<{ data: { id: string } }>(createPost, {
        method: "POST",
        path: "/api/v1/blog/posts",
        headers: authHeaders(owner),
        body: {
          title: "Draft",
          slug: "preview-draft-disabled",
          contentJson: {
            blocks: [{ type: "paragraph", text: "Jakarta news." }]
          },
          contentText: "Jakarta news.",
          autoInternalTagLinksDisabled: true
        }
      });
      expect(draft.status).toBe(200);

      const preview = await invoke<{
        data: { enabled: boolean; disabledReason: string | null };
      }>(previewInternalTagLinks, {
        method: "GET",
        path: `/api/v1/blog/posts/${draft.body.data.id}/internal-links/preview`,
        headers: authHeaders(owner),
        params: { id: draft.body.data.id }
      });

      expect(preview.status).toBe(200);
      expect(preview.body.data.enabled).toBe(false);
      expect(preview.body.data.disabledReason).toBe("post_disabled");
    });

    test("404s for a post belonging to another tenant", async () => {
      const ownerA = await bootstrap("acme-a3", "Acme A3");
      const ownerB = await provisionSecondTenant("acme-b3");

      const created = await invoke<{ data: { id: string } }>(createPost, {
        method: "POST",
        path: "/api/v1/blog/posts",
        headers: authHeaders(ownerA),
        body: {
          title: "Tenant A Post",
          slug: "tenant-a-post",
          contentJson: {},
          contentText: "body"
        }
      });
      expect(created.status).toBe(200);

      const preview = await invoke(previewInternalTagLinks, {
        method: "GET",
        path: `/api/v1/blog/posts/${created.body.data.id}/internal-links/preview`,
        headers: authHeaders(ownerB),
        params: { id: created.body.data.id }
      });

      expect(preview.status).toBe(404);
    });

    test("requires authentication", async () => {
      const owner = await bootstrap();
      const postId = crypto.randomUUID();
      const result = await invoke(previewInternalTagLinks, {
        method: "GET",
        path: `/api/v1/blog/posts/${postId}/internal-links/preview`,
        headers: {
          "content-type": "application/json",
          "x-awcms-mini-tenant-id": owner.tenantId
        },
        params: { id: postId }
      });
      expect(result.status).toBe(401);
    });
  });
});
