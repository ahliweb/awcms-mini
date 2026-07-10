import { describe, expect, test } from "bun:test";

import { getModuleByKey, listModules } from "../../src/modules";
import { newsPortalModule } from "../../src/modules/news-portal/module";
import { NEWS_MEDIA_PERMISSIONS } from "../../src/modules/news-portal/domain/news-media-permissions";

describe("news_portal module descriptor (Issue #632, extended #634)", () => {
  test("listModules() includes news_portal", () => {
    expect(listModules().some((m) => m.key === "news_portal")).toBe(true);
    expect(getModuleByKey("news_portal")).toBe(newsPortalModule);
  });

  test("descriptor shape matches Issue #632's scope", () => {
    expect(newsPortalModule.key).toBe("news_portal");
    expect(newsPortalModule.status).toBe("active");
    expect(newsPortalModule.type).toBe("domain");
    // Deliberately NOT blog_content/tenant_domain/visitor_analytics — see
    // module.ts's own comment: a hard dependency would block disabling
    // those modules for every tenant (news_portal is enabled by default),
    // which broke existing integration tests when first tried. The
    // relationship is prose-only + enforced by preset-application
    // ordering, not the module dependency graph.
    expect(newsPortalModule.dependencies).toEqual([
      "tenant_admin",
      "identity_access"
    ]);
  });

  test("Issue #634 declares permissions + api now that a real HTTP surface exists, but still leaves navigation/settings/jobs/health undeclared", () => {
    // navigation/settings/jobs/health still have no real feature backing
    // them (no admin UI page, no per-tenant setting, no background job, no
    // health check) — same "only claim a capability once it genuinely
    // exists" convention visitor_analytics established (Issue #617).
    expect(newsPortalModule.navigation).toBeUndefined();
    expect(newsPortalModule.settings).toBeUndefined();
    expect(newsPortalModule.jobs).toBeUndefined();
    expect(newsPortalModule.health).toBeUndefined();

    expect(newsPortalModule.api).toEqual({
      openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
      basePath: "/api/v1/media/news-images"
    });

    expect(newsPortalModule.permissions).toBeDefined();
  });

  test("every declared permission's activityCode/action reproduces exactly one NEWS_MEDIA_PERMISSIONS constant from #633/#634 — no invented/duplicated/orphaned permission key", () => {
    const permissions = newsPortalModule.permissions ?? [];
    const expectedKeys = new Set(Object.values(NEWS_MEDIA_PERMISSIONS));

    expect(permissions.length).toBe(expectedKeys.size);

    const declaredKeys = permissions.map(
      (p) => `news_portal.${p.activityCode}.${p.action}`
    );

    expect(new Set(declaredKeys)).toEqual(expectedKeys);
    // No duplicates.
    expect(declaredKeys.length).toBe(new Set(declaredKeys).size);

    for (const permission of permissions) {
      expect(permission.activityCode).toBe("media");
      expect(permission.description.length).toBeGreaterThan(0);
    }
  });

  test("descriptor never declares a secret, token, or provider credential", () => {
    const serialized = JSON.stringify(newsPortalModule).toLowerCase();

    for (const forbidden of [
      "password",
      "secret",
      "credential",
      "apikey",
      "api_key"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
