/**
 * Integration tests for presentation/monetization extensions (Issue #542,
 * epic #536) plus blog settings (Issue #543). Exercises the real handlers
 * against a real PostgreSQL — templates, menus (with hierarchical items),
 * widgets, ads (with placements), the per-tenant theme override, and
 * `/api/v1/blog/settings` (GET default fallback, PATCH merge-patch
 * semantics, guard, validation, audit). RBAC (single `configure`/`update`
 * permission gates the relevant mutation, same as taxonomies), RLS tenant
 * isolation, and audit are covered per resource rather than exhaustively
 * for every resource (the underlying guard/audit wiring is identical
 * across all six, proven once by the taxonomy/post suites already in this
 * epic).
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
import {
  GET as listTemplates,
  POST as createTemplate
} from "../../src/pages/api/v1/blog/templates/index";
import {
  DELETE as deleteTemplate,
  PATCH as updateTemplate
} from "../../src/pages/api/v1/blog/templates/[id]";
import {
  GET as listMenus,
  POST as createMenu
} from "../../src/pages/api/v1/blog/menus/index";
import {
  DELETE as deleteMenu,
  PATCH as updateMenu
} from "../../src/pages/api/v1/blog/menus/[id]";
import {
  GET as listWidgets,
  POST as createWidget
} from "../../src/pages/api/v1/blog/widgets/index";
import { PATCH as updateWidget } from "../../src/pages/api/v1/blog/widgets/[id]";
import {
  GET as listAds,
  POST as createAd
} from "../../src/pages/api/v1/blog/ads/index";
import { PATCH as updateAd } from "../../src/pages/api/v1/blog/ads/[id]";
import {
  GET as getTheme,
  PATCH as updateTheme
} from "../../src/pages/api/v1/blog/theme/index";
import {
  GET as getSettings,
  PATCH as updateSettings
} from "../../src/pages/api/v1/blog/settings/index";

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

/** Same-tenant scoped user, granted only the given `blog_content.<activityCode>.<action>` permissions — mirrors `blog-content-pages-taxonomy-search.integration.test.ts`'s generalized helper. */
async function provisionScopedTenantUser(
  tenantId: string,
  loginIdentifier: string,
  grants: { activityCode: string; action: string }[]
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

    for (const grant of grants) {
      const permission = (await tx`
        SELECT id FROM awcms_mini_permissions
        WHERE module_key = 'blog_content' AND activity_code = ${grant.activityCode} AND action = ${grant.action}
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
 * constraint every other integration test file in this epic documents). A
 * second tenant with `blog_content.templates.read` is provisioned directly
 * instead, to prove RLS isolation specifically, not an ABAC 403.
 */
async function provisionSecondTenantWithTemplatesReadAccess(): Promise<Bootstrap> {
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
      VALUES (${tenantId}, 'template_reader', 'Template Reader') RETURNING id
    `) as { id: string }[];
    const permission = (await tx`
      SELECT id FROM awcms_mini_permissions
      WHERE module_key = 'blog_content' AND activity_code = 'templates' AND action = 'read'
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

const suite = integrationEnabled ? describe : describe.skip;

suite("blog presentation extensions", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("templates: create -> list -> update -> delete, with audit events", async () => {
    const owner = await bootstrap();

    const created = await invoke<{ data: { id: string; key: string } }>(
      createTemplate,
      {
        method: "POST",
        path: "/api/v1/blog/templates",
        headers: authHeaders(owner),
        body: {
          key: "landing-hero",
          name: "Landing Hero",
          layoutJson: { columns: 2, sidebarPosition: "right" }
        }
      }
    );
    expect(created.status).toBe(200);
    const templateId = created.body.data.id;

    const list = await invoke<{ data: { templates: unknown[] } }>(
      listTemplates,
      {
        method: "GET",
        path: "/api/v1/blog/templates",
        headers: authHeaders(owner)
      }
    );
    expect(list.status).toBe(200);
    expect(list.body.data.templates).toHaveLength(1);

    const updated = await invoke<{ data: { name: string } }>(updateTemplate, {
      method: "PATCH",
      path: `/api/v1/blog/templates/${templateId}`,
      headers: authHeaders(owner),
      params: { id: templateId },
      body: { name: "Updated Hero" }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.name).toBe("Updated Hero");

    const deleted = await invoke(deleteTemplate, {
      method: "DELETE",
      path: `/api/v1/blog/templates/${templateId}`,
      headers: authHeaders(owner),
      params: { id: templateId },
      body: { reason: "no longer needed" }
    });
    expect(deleted.status).toBe(200);

    const admin = getAdminSql();
    const auditRows = (await admin`
      SELECT action FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND resource_id = ${templateId}
      ORDER BY created_at ASC
    `) as { action: string }[];
    expect(auditRows.map((row) => row.action)).toEqual([
      "blog.template.created",
      "blog.template.updated",
      "blog.template.deleted"
    ]);
  });

  test("templates: creating a duplicate key conflicts (409)", async () => {
    const owner = await bootstrap();
    const body = {
      key: "landing-hero",
      name: "Landing Hero",
      layoutJson: { columns: 1, sidebarPosition: "none" }
    };

    const first = await invoke(createTemplate, {
      method: "POST",
      path: "/api/v1/blog/templates",
      headers: authHeaders(owner),
      body
    });
    expect(first.status).toBe(200);

    const duplicate = await invoke(createTemplate, {
      method: "POST",
      path: "/api/v1/blog/templates",
      headers: authHeaders(owner),
      body
    });
    expect(duplicate.status).toBe(409);
  });

  test("templates: reading requires blog_content.templates.read", async () => {
    const owner = await bootstrap();
    const noPermUser = await provisionScopedTenantUser(
      owner.tenantId,
      "noperm@example.com",
      []
    );

    const list = await invoke(listTemplates, {
      method: "GET",
      path: "/api/v1/blog/templates",
      headers: authHeaders(noPermUser)
    });
    expect(list.status).toBe(403);
  });

  test("templates: creating requires blog_content.templates.configure, read alone is not enough", async () => {
    const owner = await bootstrap();
    const reader = await provisionScopedTenantUser(
      owner.tenantId,
      "reader@example.com",
      [{ activityCode: "templates", action: "read" }]
    );

    const created = await invoke(createTemplate, {
      method: "POST",
      path: "/api/v1/blog/templates",
      headers: authHeaders(reader),
      body: {
        key: "x",
        name: "X",
        layoutJson: { columns: 1, sidebarPosition: "none" }
      }
    });
    expect(created.status).toBe(403);
  });

  test("menus: create with a one-level item tree -> list -> update items -> delete", async () => {
    const owner = await bootstrap();
    const rootId = "11111111-1111-1111-1111-111111111111";
    const childId = "22222222-2222-2222-2222-222222222222";

    const created = await invoke<{
      data: { id: string; items: { id: string }[] };
    }>(createMenu, {
      method: "POST",
      path: "/api/v1/blog/menus",
      headers: authHeaders(owner),
      body: {
        key: "primary",
        name: "Primary Menu",
        items: [
          {
            id: rootId,
            parentItemId: null,
            label: "Home",
            linkType: "url",
            url: "https://example.com",
            sortOrder: 0
          },
          {
            id: childId,
            parentItemId: rootId,
            label: "About",
            linkType: "url",
            url: "https://example.com/about",
            sortOrder: 1
          }
        ]
      }
    });
    expect(created.status).toBe(200);
    expect(created.body.data.items).toHaveLength(2);
    const menuId = created.body.data.id;

    const list = await invoke<{
      data: { menus: { id: string; items: unknown[] }[] };
    }>(listMenus, {
      method: "GET",
      path: "/api/v1/blog/menus",
      headers: authHeaders(owner)
    });
    expect(list.status).toBe(200);
    expect(list.body.data.menus[0]?.items).toHaveLength(2);

    const newRootId = "33333333-3333-3333-3333-333333333333";
    const updated = await invoke<{ data: { items: { id: string }[] } }>(
      updateMenu,
      {
        method: "PATCH",
        path: `/api/v1/blog/menus/${menuId}`,
        headers: authHeaders(owner),
        params: { id: menuId },
        body: {
          items: [
            {
              id: newRootId,
              parentItemId: null,
              label: "Contact",
              linkType: "url",
              url: "https://example.com/contact",
              sortOrder: 0
            }
          ]
        }
      }
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data.items).toHaveLength(1);
    expect(updated.body.data.items[0]?.id).toBe(newRootId);

    const deleted = await invoke(deleteMenu, {
      method: "DELETE",
      path: `/api/v1/blog/menus/${menuId}`,
      headers: authHeaders(owner),
      params: { id: menuId },
      body: { reason: "cleanup" }
    });
    expect(deleted.status).toBe(200);
  });

  test("menus: rejects an item nested deeper than one level", async () => {
    const owner = await bootstrap();
    const rootId = "11111111-1111-1111-1111-111111111111";
    const childId = "22222222-2222-2222-2222-222222222222";
    const grandchildId = "33333333-3333-3333-3333-333333333333";

    const created = await invoke(createMenu, {
      method: "POST",
      path: "/api/v1/blog/menus",
      headers: authHeaders(owner),
      body: {
        key: "primary",
        name: "Primary Menu",
        items: [
          {
            id: rootId,
            parentItemId: null,
            label: "Root",
            linkType: "url",
            url: "https://example.com",
            sortOrder: 0
          },
          {
            id: childId,
            parentItemId: rootId,
            label: "Child",
            linkType: "url",
            url: "https://example.com/c",
            sortOrder: 1
          },
          {
            id: grandchildId,
            parentItemId: childId,
            label: "Grandchild",
            linkType: "url",
            url: "https://example.com/g",
            sortOrder: 2
          }
        ]
      }
    });
    expect(created.status).toBe(400);
  });

  test("widgets: create -> list by position -> update -> soft delete excludes from list", async () => {
    const owner = await bootstrap();

    const created = await invoke<{ data: { id: string } }>(createWidget, {
      method: "POST",
      path: "/api/v1/blog/widgets",
      headers: authHeaders(owner),
      body: { position: "sidebar", title: "About", bodyText: "Hello" }
    });
    expect(created.status).toBe(200);
    const widgetId = created.body.data.id;

    const list = await invoke<{ data: { widgets: unknown[] } }>(listWidgets, {
      method: "GET",
      path: "/api/v1/blog/widgets?position=sidebar",
      headers: authHeaders(owner)
    });
    expect(list.status).toBe(200);
    expect(list.body.data.widgets).toHaveLength(1);

    const updated = await invoke<{ data: { title: string } }>(updateWidget, {
      method: "PATCH",
      path: `/api/v1/blog/widgets/${widgetId}`,
      headers: authHeaders(owner),
      params: { id: widgetId },
      body: { title: "About Us", isActive: false }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.title).toBe("About Us");

    const activeOnlyList = await invoke<{ data: { widgets: unknown[] } }>(
      listWidgets,
      {
        method: "GET",
        path: "/api/v1/blog/widgets?position=sidebar",
        headers: authHeaders(owner)
      }
    );
    // isActive=false is a soft "hide", not a delete — GET (admin) still
    // returns it (activeOnly filtering is opt-in for public rendering).
    expect(activeOnlyList.body.data.widgets).toHaveLength(1);
  });

  test("widgets: rejects unsafe bodyText (400)", async () => {
    const owner = await bootstrap();

    const created = await invoke(createWidget, {
      method: "POST",
      path: "/api/v1/blog/widgets",
      headers: authHeaders(owner),
      body: {
        position: "footer",
        title: "X",
        bodyText: "<script>alert(1)</script>"
      }
    });
    expect(created.status).toBe(400);
  });

  test("ads: create with placements -> list -> update placements -> soft delete", async () => {
    const owner = await bootstrap();

    const created = await invoke<{
      data: { id: string; placements: { placementType: string }[] };
    }>(createAd, {
      method: "POST",
      path: "/api/v1/blog/ads",
      headers: authHeaders(owner),
      body: {
        name: "Sponsor A",
        imageUrl: "https://cdn.example.com/a.png",
        linkUrl: "https://sponsor.example.com",
        placements: [{ placementType: "global" }]
      }
    });
    expect(created.status).toBe(200);
    expect(created.body.data.placements).toHaveLength(1);
    const adId = created.body.data.id;

    const list = await invoke<{ data: { ads: unknown[] } }>(listAds, {
      method: "GET",
      path: "/api/v1/blog/ads",
      headers: authHeaders(owner)
    });
    expect(list.status).toBe(200);
    expect(list.body.data.ads).toHaveLength(1);

    const updated = await invoke<{
      data: { placements: { placementType: string }[] };
    }>(updateAd, {
      method: "PATCH",
      path: `/api/v1/blog/ads/${adId}`,
      headers: authHeaders(owner),
      params: { id: adId },
      body: {
        placements: [{ placementType: "post", targetId: created.body.data.id }]
      }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.placements).toEqual([
      expect.objectContaining({ placementType: "post" })
    ]);
  });

  test("ads: rejects a non-http(s) imageUrl (400)", async () => {
    const owner = await bootstrap();

    const created = await invoke(createAd, {
      method: "POST",
      path: "/api/v1/blog/ads",
      headers: authHeaders(owner),
      body: { name: "Sponsor A", imageUrl: "javascript:alert(1)" }
    });
    expect(created.status).toBe(400);
  });

  test("theme: GET falls back to the tenant default when no override exists, PATCH sets an override", async () => {
    const owner = await bootstrap();

    const before = await invoke<{
      data: { mode: string; isOverride: boolean };
    }>(getTheme, {
      method: "GET",
      path: "/api/v1/blog/theme",
      headers: authHeaders(owner)
    });
    expect(before.status).toBe(200);
    expect(before.body.data.isOverride).toBe(false);

    const updated = await invoke<{
      data: { mode: string; isOverride: boolean };
    }>(updateTheme, {
      method: "PATCH",
      path: "/api/v1/blog/theme",
      headers: authHeaders(owner),
      body: { mode: "dark" }
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual({ mode: "dark", isOverride: true });

    const after = await invoke<{ data: { mode: string; isOverride: boolean } }>(
      getTheme,
      {
        method: "GET",
        path: "/api/v1/blog/theme",
        headers: authHeaders(owner)
      }
    );
    expect(after.body.data).toEqual({ mode: "dark", isOverride: true });
  });

  test("theme: rejects an invalid mode (400)", async () => {
    const owner = await bootstrap();

    const updated = await invoke(updateTheme, {
      method: "PATCH",
      path: "/api/v1/blog/theme",
      headers: authHeaders(owner),
      body: { mode: "blue" }
    });
    expect(updated.status).toBe(400);
  });

  test("settings: GET returns schema/domain defaults when never configured", async () => {
    const owner = await bootstrap();

    const before = await invoke<{
      data: {
        blogTitle: string;
        postsPerPage: number;
        rssEnabled: boolean;
        sitemapEnabled: boolean;
        defaultLocale: string;
        defaultVisibility: string;
      };
    }>(getSettings, {
      method: "GET",
      path: "/api/v1/blog/settings",
      headers: authHeaders(owner)
    });

    expect(before.status).toBe(200);
    expect(before.body.data.blogTitle).toBe("Blog");
    expect(before.body.data.postsPerPage).toBe(10);
    expect(before.body.data.rssEnabled).toBe(true);
    expect(before.body.data.sitemapEnabled).toBe(true);
  });

  test("settings: PATCH is a merge-patch — only fields sent are changed, audit event recorded", async () => {
    const owner = await bootstrap();

    const first = await invoke<{
      data: { blogTitle: string; postsPerPage: number };
    }>(updateSettings, {
      method: "PATCH",
      path: "/api/v1/blog/settings",
      headers: authHeaders(owner),
      body: { blogTitle: "Acme Blog", postsPerPage: 25 }
    });
    expect(first.status).toBe(200);
    expect(first.body.data.blogTitle).toBe("Acme Blog");
    expect(first.body.data.postsPerPage).toBe(25);

    // Second PATCH only touches rssEnabled — blogTitle/postsPerPage from the
    // first PATCH must survive untouched (merge-patch, not replace).
    const second = await invoke<{
      data: {
        blogTitle: string;
        postsPerPage: number;
        rssEnabled: boolean;
      };
    }>(updateSettings, {
      method: "PATCH",
      path: "/api/v1/blog/settings",
      headers: authHeaders(owner),
      body: { rssEnabled: false }
    });
    expect(second.status).toBe(200);
    expect(second.body.data.rssEnabled).toBe(false);
    expect(second.body.data.blogTitle).toBe("Acme Blog");
    expect(second.body.data.postsPerPage).toBe(25);

    const after = await invoke<{ data: { blogTitle: string } }>(getSettings, {
      method: "GET",
      path: "/api/v1/blog/settings",
      headers: authHeaders(owner)
    });
    expect(after.body.data.blogTitle).toBe("Acme Blog");

    const admin = getAdminSql();
    const auditRows = (await admin`
      SELECT action FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND resource_type = 'blog_settings'
      ORDER BY created_at ASC
    `) as { action: string }[];
    expect(auditRows.map((row) => row.action)).toEqual([
      "blog.settings.updated",
      "blog.settings.updated"
    ]);
  });

  test("settings: rejects an out-of-range postsPerPage (400)", async () => {
    const owner = await bootstrap();

    const updated = await invoke(updateSettings, {
      method: "PATCH",
      path: "/api/v1/blog/settings",
      headers: authHeaders(owner),
      body: { postsPerPage: 0 }
    });
    expect(updated.status).toBe(400);
  });

  test("settings: reading requires blog_content.settings.read", async () => {
    const owner = await bootstrap();
    const noPermUser = await provisionScopedTenantUser(
      owner.tenantId,
      "noperm-settings@example.com",
      []
    );

    const get = await invoke(getSettings, {
      method: "GET",
      path: "/api/v1/blog/settings",
      headers: authHeaders(noPermUser)
    });
    expect(get.status).toBe(403);
  });

  test("settings: reader without settings.configure cannot PATCH", async () => {
    const owner = await bootstrap();
    const reader = await provisionScopedTenantUser(
      owner.tenantId,
      "settings-reader@example.com",
      [{ activityCode: "settings", action: "read" }]
    );

    const patch = await invoke(updateSettings, {
      method: "PATCH",
      path: "/api/v1/blog/settings",
      headers: authHeaders(reader),
      body: { blogTitle: "Hijacked" }
    });
    expect(patch.status).toBe(403);
  });

  test("tenant B cannot read tenant A's templates (RLS FORCE)", async () => {
    const tenantA = await bootstrap();
    const created = await invoke<{ data: { id: string } }>(createTemplate, {
      method: "POST",
      path: "/api/v1/blog/templates",
      headers: authHeaders(tenantA),
      body: {
        key: "landing-hero",
        name: "Landing Hero",
        layoutJson: { columns: 1, sidebarPosition: "none" }
      }
    });
    expect(created.status).toBe(200);

    const tenantB = await provisionSecondTenantWithTemplatesReadAccess();

    const list = await invoke<{ data: { templates: unknown[] } }>(
      listTemplates,
      {
        method: "GET",
        path: "/api/v1/blog/templates",
        headers: authHeaders(tenantB)
      }
    );
    expect(list.status).toBe(200);
    expect(list.body.data.templates).toHaveLength(0);
  });
});
