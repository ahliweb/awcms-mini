import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const driftScriptPath = fileURLToPath(new URL("../../scripts/check-emdash-drift.mjs", import.meta.url));
const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

test("EmDash drift checker targets the canonical reference checkout", async () => {
  const contents = await readFile(driftScriptPath, "utf8");

  assert.match(contents, /EMDASH_REFERENCE_ROOT/);
  assert.match(contents, /\.\.\/emdash\/packages\/core/);
  assert.match(contents, /\.\.\/emdash-awcms\/packages\/core/);
  assert.match(contents, /patches\/emdash@0\.9\.0\.patch/);
  assert.match(contents, /apply", "--check", "--exclude=dist\/\*\*"/);
  assert.match(contents, /apply", "--reverse", "--check", "--exclude=dist\/\*\*"/);
  assert.match(contents, /EmDash compatibility patch drift detected/);
});

test("package.json exposes the drift check command", async () => {
  const contents = await readFile(packageJsonPath, "utf8");
  const pkg = JSON.parse(contents);

  assert.equal(pkg.scripts["check:emdash-drift"], "node ./scripts/check-emdash-drift.mjs");
});
