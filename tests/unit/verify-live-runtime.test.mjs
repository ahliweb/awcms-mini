import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

const scriptSource = readFileSync(new URL("../../scripts/verify-live-runtime.mjs", import.meta.url), "utf8");

test("verify-live-runtime composes the reviewed verification commands", () => {
  assert.match(scriptSource, /node", \["\.\/scripts\/healthcheck\.mjs"\]/);
  assert.match(scriptSource, /node", \["\.\/scripts\/db-migrate\.mjs", "emdash-verify"\]/);
  assert.match(scriptSource, /node", \["\.\/scripts\/smoke-cloudflare-admin\.mjs", baseUrl\]/);
});

test("verify-live-runtime applies the reviewed Hyperdrive expectations by default", () => {
  assert.match(scriptSource, /HEALTHCHECK_EXPECT_DATABASE_TRANSPORT: "hyperdrive"/);
  assert.match(scriptSource, /HEALTHCHECK_EXPECT_HYPERDRIVE_BINDING: "HYPERDRIVE"/);
});

test("verify-live-runtime lets explicit operator env values override the defaults", () => {
  assert.match(scriptSource, /\.\.\.DEFAULT_LIVE_RUNTIME_EXPECTATIONS,\s+\.\.\.env/);
});

test("verify-live-runtime resolves the smoke target from argv before env", () => {
  assert.match(scriptSource, /process\.argv\[2\]/);
  assert.match(scriptSource, /env\.SMOKE_TEST_BASE_URL/);
  assert.match(scriptSource, /env\.SITE_URL/);
});

test("verify-live-runtime requires a reviewed target URL", () => {
  assert.match(scriptSource, /Set SITE_URL or SMOKE_TEST_BASE_URL, or pass a base URL as the first argument\./);
});
