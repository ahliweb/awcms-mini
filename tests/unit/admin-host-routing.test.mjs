import test from "node:test";
import assert from "node:assert/strict";

import { redirectAdminHostEntry } from "../../src/auth/admin-host-routing.mjs";
import { DEFAULT_ADMIN_ENTRY_PATH, getRuntimeConfig } from "../../src/config/runtime.mjs";

test("redirectAdminHostEntry redirects the admin hostname root to the EmDash admin entry", async () => {
  const response = redirectAdminHostEntry(
    new URL("https://awcms-mini-admin.ahlikoding.com/"),
    {
      adminSiteUrl: "https://awcms-mini-admin.ahlikoding.com",
      adminHostRouting: {
        enabled: true,
        adminEntryPath: DEFAULT_ADMIN_ENTRY_PATH,
      },
    },
  );

  assert.ok(response instanceof Response);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/_emdash/admin");
});

test("redirectAdminHostEntry ignores non-root or non-admin-host requests", async () => {
  const runtimeConfig = {
    adminSiteUrl: "https://awcms-mini-admin.ahlikoding.com",
    adminHostRouting: {
      enabled: true,
      adminEntryPath: DEFAULT_ADMIN_ENTRY_PATH,
    },
  };

  assert.equal(
    redirectAdminHostEntry(new URL("https://awcms-mini.ahlikoding.com/"), runtimeConfig),
    null,
  );
  assert.equal(
    redirectAdminHostEntry(new URL("https://awcms-mini-admin.ahlikoding.com/_emdash/admin"), runtimeConfig),
    null,
  );
});

test("getRuntimeConfig enables admin host routing only when both site URLs are configured", async () => {
  const previousSiteUrl = process.env.SITE_URL;
  const previousAdminSiteUrl = process.env.ADMIN_SITE_URL;
  const previousAdminEntryPath = process.env.ADMIN_ENTRY_PATH;

  process.env.SITE_URL = "https://awcms-mini.ahlikoding.com";
  process.env.ADMIN_SITE_URL = "https://awcms-mini-admin.ahlikoding.com";
  process.env.ADMIN_ENTRY_PATH = "/_emdash/admin";

  try {
    const runtimeConfig = getRuntimeConfig();

    assert.equal(runtimeConfig.siteUrl, "https://awcms-mini.ahlikoding.com");
    assert.equal(runtimeConfig.adminSiteUrl, "https://awcms-mini-admin.ahlikoding.com");
    assert.equal(runtimeConfig.adminHostRouting.enabled, true);
    assert.equal(runtimeConfig.adminHostRouting.adminEntryPath, "/_emdash/admin");
  } finally {
    if (previousSiteUrl === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = previousSiteUrl;

    if (previousAdminSiteUrl === undefined) delete process.env.ADMIN_SITE_URL;
    else process.env.ADMIN_SITE_URL = previousAdminSiteUrl;

    if (previousAdminEntryPath === undefined) delete process.env.ADMIN_ENTRY_PATH;
    else process.env.ADMIN_ENTRY_PATH = previousAdminEntryPath;
  }
});
