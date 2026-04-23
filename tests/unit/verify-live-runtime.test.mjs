import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

const scriptSource = readFileSync(new URL("../../scripts/verify-live-runtime.mjs", import.meta.url), "utf8");

test("verify-live-runtime composes the reviewed verification commands", () => {
  assert.match(scriptSource, /node", \["\.\/scripts\/smoke-deployed-runtime-health\.mjs", baseUrl\]/);
  assert.match(scriptSource, /node", \["\.\/scripts\/smoke-cloudflare-admin\.mjs", baseUrl\]/);
});

test("verify-live-runtime applies the reviewed Hyperdrive expectations by default", () => {
  assert.match(scriptSource, /DATABASE_TRANSPORT: "hyperdrive"/);
  assert.match(scriptSource, /HYPERDRIVE_BINDING: "HYPERDRIVE"/);
  assert.match(scriptSource, /MINI_RUNTIME_TARGET: "cloudflare"/);
  assert.match(scriptSource, /HEALTHCHECK_EXPECT_DATABASE_TRANSPORT: "hyperdrive"/);
  assert.match(scriptSource, /HEALTHCHECK_EXPECT_HYPERDRIVE_BINDING: "HYPERDRIVE"/);
});

test("verify-live-runtime lets explicit operator env values override the defaults", () => {
  assert.match(scriptSource, /\.\.\.DEFAULT_LIVE_RUNTIME_EXPECTATIONS,\s+\.\.\.env/);
});

test("verify-live-runtime reapplies the local Hyperdrive compatibility env before running child steps", () => {
  assert.match(scriptSource, /applyLocalCloudflareRuntimeEnv\(verificationEnv\)/);
});

test("verify-live-runtime runs local EmDash verification only when explicitly requested", () => {
  assert.match(scriptSource, /VERIFY_LIVE_RUNTIME_INCLUDE_LOCAL_EMDASH_VERIFY/);
  assert.match(scriptSource, /Local EmDash compatibility verify/);
});

test("verify-live-runtime resolves the smoke target from argv before env", () => {
  assert.match(scriptSource, /resolveCliBaseUrlArg/);
  assert.match(scriptSource, /env\.SMOKE_TEST_BASE_URL/);
  assert.match(scriptSource, /env\.SITE_URL/);
});

test("verify-live-runtime requires a reviewed target URL", () => {
  assert.match(scriptSource, /Set SITE_URL or SMOKE_TEST_BASE_URL, or pass a base URL as the first argument\./);
});
