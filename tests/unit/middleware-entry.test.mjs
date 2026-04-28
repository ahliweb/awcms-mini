import test from "node:test";
import assert from "node:assert/strict";

import {
  isMiniAdminLoginPath,
  isMiniAdminShellPath,
  isMiniSetupShellPath,
} from "../../src/auth/middleware-paths.mjs";

test("isMiniSetupShellPath matches the EmDash setup shell route", async () => {
  assert.equal(isMiniSetupShellPath("/_emdash/admin/setup"), true);
  assert.equal(isMiniSetupShellPath("/_emdash/admin/setup/database"), true);
});

test("isMiniSetupShellPath ignores non-setup admin routes", async () => {
  assert.equal(isMiniSetupShellPath("/_emdash/admin"), false);
  assert.equal(isMiniSetupShellPath("/_emdash/api/auth/me"), false);
  assert.equal(isMiniSetupShellPath("/"), false);
});

test("isMiniAdminShellPath matches admin shell routes", async () => {
  assert.equal(isMiniAdminShellPath("/_emdash/admin"), true);
  assert.equal(isMiniAdminShellPath("/_emdash/admin/content/posts"), true);
  assert.equal(isMiniAdminShellPath("/_emdash/api/auth/me"), false);
});

test("isMiniAdminLoginPath matches login shell route only", async () => {
  assert.equal(isMiniAdminLoginPath("/_emdash/admin/login"), true);
  assert.equal(isMiniAdminLoginPath("/_emdash/admin/login/challenge"), true);
  assert.equal(isMiniAdminLoginPath("/_emdash/admin"), false);
});
