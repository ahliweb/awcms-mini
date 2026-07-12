import { describe, expect, test } from "bun:test";

import { getModuleByKey, listModules } from "../../src/modules";
import { socialPublishingModule } from "../../src/modules/social-publishing/module";

describe("social_publishing module descriptor (Issue #643)", () => {
  test("listModules() includes social_publishing", () => {
    expect(listModules().some((m) => m.key === "social_publishing")).toBe(true);
    expect(getModuleByKey("social_publishing")).toBe(socialPublishingModule);
  });

  test("descriptor shape matches Issue #643's scope", () => {
    expect(socialPublishingModule.key).toBe("social_publishing");
    expect(socialPublishingModule.status).toBe("active");
    expect(socialPublishingModule.type).toBe("domain");
    // Deliberately NOT blog_content — see module.ts's own comment: the
    // composition root already holds the published article's fields and
    // passes them into SocialPublishingPort directly, so this module never
    // needs a hard dependency on blog_content to re-fetch post data.
    expect(socialPublishingModule.dependencies).toEqual([
      "tenant_admin",
      "identity_access"
    ]);
  });

  test("declares exactly the ten permissions from the issue's suggested list", () => {
    const permissions = socialPublishingModule.permissions ?? [];
    const keys = permissions.map((p) => `${p.activityCode}.${p.action}`).sort();

    expect(keys).toEqual(
      [
        "accounts.read",
        "accounts.connect",
        "accounts.disconnect",
        "rules.read",
        "rules.configure",
        "jobs.read",
        "jobs.approve",
        "jobs.cancel",
        "jobs.retry",
        "logs.read"
      ].sort()
    );
  });

  test("navigation has one entry each for accounts/rules/jobs admin pages", () => {
    const paths = (socialPublishingModule.navigation ?? []).map(
      (entry) => entry.path
    );
    expect(paths).toEqual([
      "/admin/social-publishing/accounts",
      "/admin/social-publishing/rules",
      "/admin/social-publishing/jobs"
    ]);
  });

  test("declares the social_publishing capability it provides and consumes news_media optionally", () => {
    expect(socialPublishingModule.capabilities?.provides).toEqual([
      "social_publishing"
    ]);
    expect(socialPublishingModule.capabilities?.consumes).toEqual([
      { capability: "news_media", providedBy: "news_portal", optional: true }
    ]);
  });

  test("declares the social-publishing:dispatch background job, not safe in offline/LAN", () => {
    expect(socialPublishingModule.jobs).toHaveLength(1);
    expect(socialPublishingModule.jobs?.[0]?.command).toBe(
      "bun run social-publishing:dispatch"
    );
    expect(socialPublishingModule.jobs?.[0]?.safeInOfflineLan).toBe(false);
  });

  test("declares its AsyncAPI events (one per audited job/account/rule lifecycle transition)", () => {
    expect(socialPublishingModule.events?.asyncApiPath).toBe(
      "asyncapi/awcms-mini-domain-events.asyncapi.yaml"
    );
    // 15 from Issue #643 (foundation) + 1 from Issue #644 (Meta adapter's
    // "verify connection" success outcome, `account.verified`).
    expect(socialPublishingModule.events?.publishes?.length).toBe(16);
    expect(socialPublishingModule.events?.publishes).toContain(
      "awcms-mini.social-publishing.account.verified"
    );
  });

  test("settings/health remain undeclared — no per-tenant setting or health check exists yet for this module specifically", () => {
    expect(socialPublishingModule.settings).toBeUndefined();
    expect(socialPublishingModule.health).toBeUndefined();
  });
});
