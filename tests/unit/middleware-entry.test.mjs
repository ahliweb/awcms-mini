import test from "node:test";
import assert from "node:assert/strict";

import { isMiniSetupShellPath } from "../../src/auth/middleware-paths.mjs";

test("isMiniSetupShellPath matches the EmDash setup shell route", async () => {
  assert.equal(isMiniSetupShellPath("/_emdash/admin/setup"), true);
  assert.equal(isMiniSetupShellPath("/_emdash/admin/setup/database"), true);
});

test("isMiniSetupShellPath ignores non-setup admin routes", async () => {
  assert.equal(isMiniSetupShellPath("/_emdash/admin"), false);
  assert.equal(isMiniSetupShellPath("/_emdash/api/auth/me"), false);
  assert.equal(isMiniSetupShellPath("/"), false);
});
