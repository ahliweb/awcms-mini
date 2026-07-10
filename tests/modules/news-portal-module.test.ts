import { describe, expect, test } from "bun:test";

import { getModuleByKey, listModules } from "../../src/modules";
import { newsPortalModule } from "../../src/modules/news-portal/module";

describe("news_portal module descriptor (Issue #632)", () => {
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

  test("the module never declares permissions, navigation, api, settings, jobs, or health before those capabilities are real (Issue #632 is preset-only)", () => {
    // Consistent with visitor_analytics's own precedent (Issue #617): a
    // descriptor should only claim a capability once it genuinely exists.
    // #632 adds only a tenant module preset + its readiness gate — no
    // media registry (#633), no upload endpoint (#634), no admin UI, no
    // permission catalog of its own yet.
    expect(newsPortalModule.permissions).toBeUndefined();
    expect(newsPortalModule.navigation).toBeUndefined();
    expect(newsPortalModule.api).toBeUndefined();
    expect(newsPortalModule.settings).toBeUndefined();
    expect(newsPortalModule.jobs).toBeUndefined();
    expect(newsPortalModule.health).toBeUndefined();
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
