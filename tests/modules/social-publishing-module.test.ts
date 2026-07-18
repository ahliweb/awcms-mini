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
    // Issue #845 (epic #818) declared real value imports the #826/#845
    // declared-dependency gate demands:
    //  - `application/social-publishing-port-adapter.ts` imports
    //    `blog_content`'s `fetchEffectivePublicRouteSettings` (resolves the
    //    canonical `publicBasePath` for a published article's social link);
    //  - several `application/*` files call `logging`'s `recordAuditEvent`.
    // Both make `blog_content`/`logging` HARD lifecycle dependencies.
    //
    // `news_portal` is DELIBERATELY ABSENT (Issue #859, epic #818). #845 had
    // declared it solely because `infrastructure/linkedin-provider-adapter.ts`
    // statically imported `news_portal`'s `resolveNewsMediaR2Config` (the R2
    // public base URL for a LinkedIn image post) — a single edge that
    // directly contradicted this module's own `capabilities.consumes`
    // declaration (`news_media`, `optional: true`). #859 routes that config
    // read through `NewsMediaPort.resolveMediaPublicBaseUrl`, injected at the
    // composition root exactly like `resolveMediaReferences`, so the static
    // cross-module import is gone and `news_portal` is optional/disableable
    // per tenant again (image posts degrade to link-share when it is off).
    // The remaining edges keep `modules:dag:check` acyclic (none depend back
    // on social_publishing). See the `capabilities.consumes` assertion below:
    // consuming `news_media` optionally is now consistent with NOT declaring
    // `news_portal` a hard dependency — that consistency is the whole point of
    // #859.
    expect(socialPublishingModule.dependencies).toEqual([
      "tenant_admin",
      "identity_access",
      "blog_content",
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
