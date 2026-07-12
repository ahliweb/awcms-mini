/**
 * Integration tests for Issue #638 (epic `news_portal`): R2-only
 * advertisement placement presets — tenant-scoped/RLS-protected CRUD
 * (`/api/v1/news-portal/ad-placements`), media reference validation (must
 * be a verified, same-tenant, allowed-mime-type R2 media object — never a
 * local path or arbitrary external image URL), unsafe link URL rejection,
 * scheduling/active-state rendering rules, and public-safe rendering
 * (`ad-placement-directory.ts`'s query + renderer, exercised directly since
 * this issue does not wire ad rendering into any public page route yet —
 * same "tested public-safe helper, wiring is a later issue's job"
 * precedent `ads-directory.ts`'s `listActiveAdsForPlacement` set for #542,
 * and #637 explicitly deferred `ad_slot` homepage-composer integration to
 * this issue existing first).
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
  provisionAppRole,
  resetDatabase
} from "./harness";

import { getDatabaseClient } from "../../src/lib/database/client";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import {
  GET as listPlacements,
  POST as createPlacement
} from "../../src/pages/api/v1/news-portal/ad-placements/index";
import {
  DELETE as deletePlacement,
  PATCH as updatePlacement
} from "../../src/pages/api/v1/news-portal/ad-placements/[id]";

import { withTenant } from "../../src/lib/database/tenant-context";
import {
  createPendingNewsMediaObject,
  markNewsMediaObjectUploaded,
  markNewsMediaObjectVerified
} from "../../src/modules/news-portal/application/news-media-object-directory";
import {
  listActiveAdPlacementsForRendering,
  renderAdPlacementHtml,
  selectAndRenderActiveAdsForPlacement
} from "../../src/modules/news-portal/application/ad-placement-directory";
import type { NewsMediaR2Config } from "../../src/modules/news-portal/domain/news-media-r2-config";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

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

/** A second, fully-independent tenant — `/setup/initialize` is a one-time wizard, so a second tenant is seeded via raw SQL + a real login, same pattern `news-portal-homepage-sections.integration.test.ts` uses. */
async function seedSecondTenant(tenantCode: string): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const password = "integration-test-tenant-b-password";
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${tenantId}, ${tenantCode}, ${tenantCode}, ${tenantCode}, 'active', 'en', 'light')
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
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'full_access', 'Full Access') RETURNING id
    `) as { id: string }[];
    const permissions = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'news_portal' AND activity_code = 'ad_placements'
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

    tenantUserId = tenantUser[0]!.id;
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

  return { tenantId, tenantCode, token: login.body.data.token, tenantUserId };
}

async function seedVerifiedMediaObject(
  tenantId: string,
  mimeType = "image/jpeg"
): Promise<string> {
  const sql = getDatabaseClient();

  return withTenant(sql, tenantId, async (tx) => {
    const created = await createPendingNewsMediaObject(
      tx,
      tenantId,
      crypto.randomUUID(),
      MEDIA_CONFIG,
      { mimeType }
    );
    await markNewsMediaObjectUploaded(tx, tenantId, created.id, {
      sizeBytes: 12_345,
      checksumSha256: "a".repeat(64)
    });
    const verified = await markNewsMediaObjectVerified(
      tx,
      tenantId,
      crypto.randomUUID(),
      created.id,
      {}
    );
    return verified!.id;
  });
}

/** An unverified (still `pending_upload`) media object — never safe to reference publicly. */
async function seedUnverifiedMediaObject(tenantId: string): Promise<string> {
  const sql = getDatabaseClient();

  return withTenant(sql, tenantId, async (tx) => {
    const created = await createPendingNewsMediaObject(
      tx,
      tenantId,
      crypto.randomUUID(),
      MEDIA_CONFIG,
      { mimeType: "image/jpeg" }
    );
    return created.id;
  });
}

const suite = integrationEnabled ? describe : describe.skip;

suite("news_portal ad placements (Issue #638)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("create an ad placement referencing a verified media object succeeds", async () => {
    const owner = await bootstrap();
    const mediaId = await seedVerifiedMediaObject(owner.tenantId);

    const created = await invoke<{
      data: { id: string; placementKey: string; mediaObjectId: string };
    }>(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "header_banner",
        name: "Spring Sale",
        mediaObjectId: mediaId,
        linkUrl: "https://advertiser.example.com/landing"
      }
    });

    expect(created.status).toBe(200);
    expect(created.body.data.placementKey).toBe("header_banner");
    expect(created.body.data.mediaObjectId).toBe(mediaId);
  });

  test("rejects a mediaObjectId that does not exist (422)", async () => {
    const owner = await bootstrap();

    const response = await invoke<{ error: { code: string } }>(
      createPlacement,
      {
        method: "POST",
        path: "/api/v1/news-portal/ad-placements",
        headers: authHeaders(owner),
        body: {
          placementKey: "header_banner",
          name: "Spring Sale",
          mediaObjectId: crypto.randomUUID()
        }
      }
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("AD_PLACEMENT_REFERENCE_INVALID");
  });

  test("rejects an unverified (pending_upload) media object (422)", async () => {
    const owner = await bootstrap();
    const mediaId = await seedUnverifiedMediaObject(owner.tenantId);

    const response = await invoke(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "header_banner",
        name: "Spring Sale",
        mediaObjectId: mediaId
      }
    });

    expect(response.status).toBe(422);
  });

  test("rejects another tenant's media object (cross-tenant reference is indistinguishable from nonexistent) (422)", async () => {
    const owner = await bootstrap("adsa");
    const otherTenant = await seedSecondTenant("adsb");
    const otherMediaId = await seedVerifiedMediaObject(otherTenant.tenantId);

    const response = await invoke(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "header_banner",
        name: "Spring Sale",
        mediaObjectId: otherMediaId
      }
    });

    expect(response.status).toBe(422);
  });

  test("rejects an unsafe linkUrl (400, before any DB write)", async () => {
    const owner = await bootstrap();
    const mediaId = await seedVerifiedMediaObject(owner.tenantId);

    const response = await invoke(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "header_banner",
        name: "Spring Sale",
        mediaObjectId: mediaId,
        linkUrl: "javascript:alert(1)"
      }
    });

    expect(response.status).toBe(400);
  });

  test("PATCH updates rotationMode/priority/isActive and re-validates a changed mediaObjectId", async () => {
    const owner = await bootstrap();
    const mediaId = await seedVerifiedMediaObject(owner.tenantId);
    const created = await invoke<{ data: { id: string } }>(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "header_banner",
        name: "Spring Sale",
        mediaObjectId: mediaId
      }
    });
    const id = created.body.data.id;

    const updated = await invoke<{
      data: { rotationMode: string; priority: number; isActive: boolean };
    }>(updatePlacement, {
      method: "PATCH",
      path: `/api/v1/news-portal/ad-placements/${id}`,
      headers: authHeaders(owner),
      params: { id },
      body: { rotationMode: "priority", priority: 7, isActive: false }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.rotationMode).toBe("priority");
    expect(updated.body.data.priority).toBe(7);
    expect(updated.body.data.isActive).toBe(false);

    const unverifiedMediaId = await seedUnverifiedMediaObject(owner.tenantId);
    const rejected = await invoke(updatePlacement, {
      method: "PATCH",
      path: `/api/v1/news-portal/ad-placements/${id}`,
      headers: authHeaders(owner),
      params: { id },
      body: { mediaObjectId: unverifiedMediaId }
    });
    expect(rejected.status).toBe(422);
  });

  test("DELETE soft-deletes an ad placement; it disappears from the list and 404s on further update", async () => {
    const owner = await bootstrap();
    const mediaId = await seedVerifiedMediaObject(owner.tenantId);
    const created = await invoke<{ data: { id: string } }>(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "header_banner",
        name: "Spring Sale",
        mediaObjectId: mediaId
      }
    });
    const id = created.body.data.id;

    const deleted = await invoke(deletePlacement, {
      method: "DELETE",
      path: `/api/v1/news-portal/ad-placements/${id}`,
      headers: authHeaders(owner),
      params: { id },
      body: { reason: "campaign ended" }
    });
    expect(deleted.status).toBe(200);

    const list = await invoke<{ data: { placements: { id: string }[] } }>(
      listPlacements,
      {
        method: "GET",
        path: "/api/v1/news-portal/ad-placements",
        headers: authHeaders(owner)
      }
    );
    expect(list.body.data.placements.map((p) => p.id)).not.toContain(id);

    const updateAfterDelete = await invoke(updatePlacement, {
      method: "PATCH",
      path: `/api/v1/news-portal/ad-placements/${id}`,
      headers: authHeaders(owner),
      params: { id },
      body: { name: "still here?" }
    });
    expect(updateAfterDelete.status).toBe(404);
  });

  test("cross-tenant isolation: tenant B cannot see or update tenant A's ad placement (404, not 403 — RLS makes it invisible)", async () => {
    const owner = await bootstrap("isoa");
    const mediaId = await seedVerifiedMediaObject(owner.tenantId);
    const created = await invoke<{ data: { id: string } }>(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "header_banner",
        name: "Spring Sale",
        mediaObjectId: mediaId
      }
    });
    const id = created.body.data.id;

    const tenantB = await seedSecondTenant("isob");

    const list = await invoke<{ data: { placements: { id: string }[] } }>(
      listPlacements,
      {
        method: "GET",
        path: "/api/v1/news-portal/ad-placements",
        headers: authHeaders(tenantB)
      }
    );
    expect(list.body.data.placements.map((p) => p.id)).not.toContain(id);

    const update = await invoke(updatePlacement, {
      method: "PATCH",
      path: `/api/v1/news-portal/ad-placements/${id}`,
      headers: authHeaders(tenantB),
      params: { id },
      body: { name: "hijacked" }
    });
    expect(update.status).toBe(404);
  });

  test("a tenant user without ad_placements permissions is denied (403) on read and create", async () => {
    const owner = await bootstrap();
    const mediaId = await seedVerifiedMediaObject(owner.tenantId);
    const admin = getAdminSql();
    const passwordHash = await Bun.password.hash("no-permissions-password");
    const noPermLogin = "no-perm@example.com";
    let noPermTenantUserId = "";

    await admin.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${owner.tenantId}'`);
      const profile = (await tx`
        INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
        VALUES (${owner.tenantId}, 'person', 'No Perm User') RETURNING id
      `) as { id: string }[];
      const identity = (await tx`
        INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
        VALUES (${owner.tenantId}, ${profile[0]!.id}, ${noPermLogin}, ${passwordHash})
        RETURNING id
      `) as { id: string }[];
      const tenantUser = (await tx`
        INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
        VALUES (${owner.tenantId}, ${identity[0]!.id}) RETURNING id
      `) as { id: string }[];
      noPermTenantUserId = tenantUser[0]!.id;
    });

    const login = await invoke<{ data: { token: string } }>(authLogin, {
      method: "POST",
      path: "/api/v1/auth/login",
      headers: {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId
      },
      body: {
        loginIdentifier: noPermLogin,
        password: "no-permissions-password"
      },
      cookies: createCookieJar()
    });
    expect(login.status).toBe(200);

    const noPermUser: Bootstrap = {
      tenantId: owner.tenantId,
      tenantCode: owner.tenantCode,
      token: login.body.data.token,
      tenantUserId: noPermTenantUserId
    };

    const list = await invoke(listPlacements, {
      method: "GET",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(noPermUser)
    });
    expect(list.status).toBe(403);

    const create = await invoke(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(noPermUser),
      body: {
        placementKey: "header_banner",
        name: "Spring Sale",
        mediaObjectId: mediaId
      }
    });
    expect(create.status).toBe(403);
  });

  test("public rendering: an active in-schedule ad renders only the registry's server-generated public URL — never a local path or arbitrary URL", async () => {
    const owner = await bootstrap();
    const mediaId = await seedVerifiedMediaObject(owner.tenantId);

    await invoke(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "header_banner",
        name: "Spring Sale",
        mediaObjectId: mediaId,
        linkUrl: "https://advertiser.example.com/landing"
      }
    });

    const sql = getDatabaseClient();
    const html = await withTenant(sql, owner.tenantId, async (tx) =>
      selectAndRenderActiveAdsForPlacement(tx, owner.tenantId, "header_banner")
    );

    expect(html).toHaveLength(1);
    expect(html[0]).toContain("media.example.test");
    expect(html[0]).toContain("https://advertiser.example.com/landing");
    expect(html[0]).toContain('rel="sponsored noopener noreferrer"');
    expect(html[0]).not.toContain("<script");
  });

  test("public rendering excludes an inactive ad, a future-scheduled ad, an expired ad, and an ad in a different placement", async () => {
    const owner = await bootstrap();
    const inactiveMediaId = await seedVerifiedMediaObject(owner.tenantId);
    const futureMediaId = await seedVerifiedMediaObject(owner.tenantId);
    const expiredMediaId = await seedVerifiedMediaObject(owner.tenantId);
    const otherPlacementMediaId = await seedVerifiedMediaObject(owner.tenantId);

    await invoke(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "sidebar_top",
        name: "Inactive",
        mediaObjectId: inactiveMediaId,
        isActive: false
      }
    });
    await invoke(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "sidebar_top",
        name: "Future",
        mediaObjectId: futureMediaId,
        startsAt: "2099-01-01T00:00:00.000Z"
      }
    });
    await invoke(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "sidebar_top",
        name: "Expired",
        mediaObjectId: expiredMediaId,
        endsAt: "2000-01-01T00:00:00.000Z"
      }
    });
    await invoke(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "sidebar_middle",
        name: "Other Placement",
        mediaObjectId: otherPlacementMediaId
      }
    });

    const sql = getDatabaseClient();
    const eligible = await withTenant(sql, owner.tenantId, async (tx) =>
      listActiveAdPlacementsForRendering(tx, owner.tenantId, "sidebar_top")
    );

    expect(eligible).toEqual([]);
  });

  test("public rendering excludes an ad whose media object was soft-deleted after the placement was created", async () => {
    const owner = await bootstrap();
    const mediaId = await seedVerifiedMediaObject(owner.tenantId);

    await invoke(createPlacement, {
      method: "POST",
      path: "/api/v1/news-portal/ad-placements",
      headers: authHeaders(owner),
      body: {
        placementKey: "article_top",
        name: "Will be orphaned",
        mediaObjectId: mediaId
      }
    });

    const sql = getDatabaseClient();
    await withTenant(sql, owner.tenantId, async (tx) => {
      await tx`
        UPDATE awcms_mini_news_media_objects
        SET deleted_at = now(), delete_reason = 'test'
        WHERE id = ${mediaId}
      `;
    });

    const eligible = await withTenant(sql, owner.tenantId, async (tx) =>
      listActiveAdPlacementsForRendering(tx, owner.tenantId, "article_top")
    );

    expect(eligible).toEqual([]);
  });

  test("renderAdPlacementHtml never emits a raw <script>/<iframe> even if name/altText contain markup-looking text (whitelist render, escaped attributes)", () => {
    const html = renderAdPlacementHtml({
      id: crypto.randomUUID(),
      name: "<script>alert(1)</script>",
      linkUrl: "https://advertiser.example.com",
      rotationMode: "latest",
      priority: 0,
      createdAt: new Date(),
      mediaPublicUrl: "https://media.example.test/news-media/x.jpg",
      mediaAltText: null
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html.trim().startsWith("<div")).toBe(true);
  });

  test("rotation caps rendering to the placement preset's maxItems (homepage_middle allows 3)", async () => {
    const owner = await bootstrap();

    for (let i = 0; i < 5; i++) {
      const mediaId = await seedVerifiedMediaObject(owner.tenantId);
      await invoke(createPlacement, {
        method: "POST",
        path: "/api/v1/news-portal/ad-placements",
        headers: authHeaders(owner),
        body: {
          placementKey: "homepage_middle",
          name: `Ad ${i}`,
          mediaObjectId: mediaId
        }
      });
    }

    const sql = getDatabaseClient();
    const html = await withTenant(sql, owner.tenantId, async (tx) =>
      selectAndRenderActiveAdsForPlacement(
        tx,
        owner.tenantId,
        "homepage_middle"
      )
    );

    expect(html).toHaveLength(3);
  });
});
