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
    // Still deliberately NOT blog_content/tenant_domain/visitor_analytics —
    // see module.ts's own comment: a hard dependency on those would block
    // disabling them for every tenant (news_portal is enabled by default),
    // which broke existing integration tests when first tried. That
    // relationship stays prose-only + enforced by preset-application
    // ordering, not the module dependency graph.
    //
    // Issue #845 (epic #818) DID add `module_management` + `logging`:
    // `application/apply-news-portal-preset.ts` imports
    // `module_management`'s `applyModulePreset` (value import) and several
    // `application/*` files call `logging`'s `recordAuditEvent`. Both are
    // real, previously-undeclared value imports the Issue #826/#845
    // declared-dependency gate now demands. Unlike the content modules
    // above, `module_management`/`logging` are foundation modules that are
    // never disabled per-tenant, so declaring them does NOT arm the
    // reverse-dependency guard against any optional business module — the
    // reason the content-module edges stay undeclared does not apply here.
    expect(newsPortalModule.dependencies).toEqual([
      "tenant_admin",
      "identity_access",
      "module_management",
      "logging"
    ]);
  });

  test("Issue #634 declares permissions + api now that a real HTTP surface exists; Issue #637 adds navigation (one admin page); Issue #690 (epic #679) adds the first background job; settings/health remain undeclared", () => {
    // settings/health still have no real feature backing them (no
    // per-tenant setting, no health check) — same "only claim a capability
    // once it genuinely exists" convention visitor_analytics established
    // (Issue #617). `jobs` is now declared (Issue #690,
    // `news-media:reconcile`) — the first background job this module ships.
    expect(newsPortalModule.settings).toBeUndefined();
    expect(newsPortalModule.health).toBeUndefined();

    expect(newsPortalModule.jobs).toEqual([
      {
        command: "bun run news-media:reconcile",
        purpose:
          "Reconcile awcms_mini_news_media_objects metadata against the real R2 bucket contents; clean up expired pending uploads and grace-period-expired orphans in bounded, race-safe batches (dry-run supported).",
        recommendedSchedule: "Daily via cron/systemd timer.",
        environmentNotes:
          'No-op when NEWS_MEDIA_R2_ENABLED is not "true". Requires real network egress to the Cloudflare R2 API in addition to PostgreSQL — not a pure database operation.',
        safeInOfflineLan: false
      }
    ]);

    expect(newsPortalModule.api).toEqual({
      openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
      basePath: "/api/v1/media/news-images"
    });

    expect(newsPortalModule.navigation).toEqual([
      {
        labelKey: "admin.layout.nav_news_portal_homepage_sections",
        path: "/admin/news-portal/homepage-sections",
        order: 80,
        requiredPermission: "news_portal.homepage_sections.read"
      },
      {
        labelKey: "admin.layout.nav_news_portal_ad_placements",
        path: "/admin/news-portal/ad-placements",
        order: 81,
        requiredPermission: "news_portal.ad_placements.read"
      }
    ]);

    expect(newsPortalModule.permissions).toBeDefined();
  });

  test("every declared `media` activityCode permission reproduces exactly one NEWS_MEDIA_PERMISSIONS constant from #633/#634 — no invented/duplicated/orphaned permission key", () => {
    const permissions = (newsPortalModule.permissions ?? []).filter(
      (p) => p.activityCode === "media"
    );
    const expectedKeys = new Set(Object.values(NEWS_MEDIA_PERMISSIONS));

    expect(permissions.length).toBe(expectedKeys.size);

    const declaredKeys = permissions.map(
      (p) => `news_portal.${p.activityCode}.${p.action}`
    );

    expect(new Set(declaredKeys)).toEqual(expectedKeys);
    // No duplicates.
    expect(declaredKeys.length).toBe(new Set(declaredKeys).size);

    for (const permission of permissions) {
      expect(permission.description.length).toBeGreaterThan(0);
    }
  });

  test("Issue #637 declares exactly the homepage_sections read/configure permission pair", () => {
    const permissions = (newsPortalModule.permissions ?? []).filter(
      (p) => p.activityCode === "homepage_sections"
    );

    expect(permissions.map((p) => p.action).sort()).toEqual([
      "configure",
      "read"
    ]);

    for (const permission of permissions) {
      expect(permission.description.length).toBeGreaterThan(0);
    }
  });

  test("Issue #638 declares exactly the ad_placements read/configure permission pair", () => {
    const permissions = (newsPortalModule.permissions ?? []).filter(
      (p) => p.activityCode === "ad_placements"
    );

    expect(permissions.map((p) => p.action).sort()).toEqual([
      "configure",
      "read"
    ]);

    for (const permission of permissions) {
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
