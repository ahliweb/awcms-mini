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
    // Issue #845 (epic #818) declared three previously-undeclared real value
    // imports the #826/#845 declared-dependency gate now demands:
    //  - `application/social-publishing-port-adapter.ts` imports
    //    `blog_content`'s `fetchEffectivePublicRouteSettings` (resolves the
    //    canonical `publicBasePath` for a published article's social link);
    //  - `infrastructure/linkedin-provider-adapter.ts` imports
    //    `news_portal`'s `resolveNewsMediaR2Config` (R2 public base URL for
    //    the image the LinkedIn post references);
    //  - several `application/*` files call `logging`'s `recordAuditEvent`.
    //
    // Declaring `blog_content`/`news_portal` makes them HARD lifecycle
    // dependencies: with social_publishing enabled (the default), a tenant
    // can no longer disable blog_content or news_portal until it first
    // disables social_publishing. That reverse-dependency constraint is
    // accepted as correct new behaviour per epic #818's Opsi A — social
    // publishing exists to fan a tenant's published blog/news content out to
    // social channels and genuinely cannot run without those content
    // modules. All three edges keep `modules:dag:check` acyclic (none depend
    // back on social_publishing).
    expect(socialPublishingModule.dependencies).toEqual([
      "tenant_admin",
      "identity_access",
      "blog_content",
      "news_portal",
      "logging"
    ]);
  });

  test("declares the ten permissions from the issue's suggested list plus accounts.verify (Issue #646)", () => {
    const permissions = socialPublishingModule.permissions ?? [];
    const keys = permissions.map((p) => `${p.activityCode}.${p.action}`).sort();

    expect(keys).toEqual(
      [
        "accounts.read",
        "accounts.connect",
        "accounts.disconnect",
        "accounts.verify",
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
    // 15 from Issue #643 (foundation) + 2 from the "verify connection"
    // action's two outcomes: `account.verified` (Issue #644, also used by
    // Meta's `verifyCredentials`) and `account.verification-failed`
    // (Issue #646, Telegram).
    expect(socialPublishingModule.events?.publishes?.length).toBe(17);
    expect(socialPublishingModule.events?.publishes).toContain(
      "awcms-mini.social-publishing.account.verified"
    );
    expect(socialPublishingModule.events?.publishes).toContain(
      "awcms-mini.social-publishing.account.verification-failed"
    );
  });

  test("settings/health remain undeclared — no per-tenant setting or health check exists yet for this module specifically", () => {
    expect(socialPublishingModule.settings).toBeUndefined();
    expect(socialPublishingModule.health).toBeUndefined();
  });
});
