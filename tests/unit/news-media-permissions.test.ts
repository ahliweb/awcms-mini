import { describe, expect, test } from "bun:test";

import { newsPortalModule } from "../../src/modules/news-portal/module";
import {
  NEWS_MEDIA_PERMISSION_ACTIVITY_CODE,
  NEWS_MEDIA_PERMISSIONS
} from "../../src/modules/news-portal/domain/news-media-permissions";

describe("NEWS_MEDIA_PERMISSIONS", () => {
  test("declares one key per required media lifecycle action", () => {
    expect(Object.keys(NEWS_MEDIA_PERMISSIONS).sort()).toEqual(
      [
        "attach",
        "create",
        "delete",
        "detach",
        "purge",
        "read",
        "restore",
        "verify"
      ].sort()
    );
  });

  test("every permission key follows the news_portal.media.<action> shape", () => {
    for (const value of Object.values(NEWS_MEDIA_PERMISSIONS)) {
      expect(value).toMatch(
        new RegExp(
          `^news_portal\\.${NEWS_MEDIA_PERMISSION_ACTIVITY_CODE}\\.[a-z]+$`
        )
      );
    }
  });

  test("module.ts does not declare these as real permissions yet (Issue #634 does, per this file's own header comment)", () => {
    // `permissions` is deliberately left undeclared on `news_portal`'s module
    // descriptor until a real endpoint exists to enforce them (see
    // `module.ts`'s own description and this file's header comment) — this
    // guards against silently wiring these constants into the descriptor
    // without also adding the endpoint/ABAC check that should come with it.
    expect(newsPortalModule.permissions).toBeUndefined();
  });
});
