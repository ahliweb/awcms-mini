import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { handleSetupStatus } from "../../src/auth/handlers/setup-status.mjs";

const middlewareEntryPath = fileURLToPath(new URL("../../src/auth/middleware-entry.mjs", import.meta.url));
const emdashSetupStatusRoutePath = fileURLToPath(
  new URL("../../node_modules/emdash/src/astro/routes/api/setup/status.ts", import.meta.url),
);
const emdashPatchPath = fileURLToPath(new URL("../../patches/emdash@0.5.0.patch", import.meta.url));

function createDbStub({ options = [], userCount = 0, throwOptions = false, throwUsers = false } = {}) {
  return {
    selectFrom(table) {
      return {
        select() {
          return this;
        },
        where(column, operator, value) {
          void column;
          void operator;
          this.value = value;
          return this;
        },
        executeTakeFirst() {
          if (table === "options") {
            if (throwOptions) {
              throw new Error("options table missing");
            }

            const match = options.find((entry) => entry.name === this.value);
            return Promise.resolve(match ? { value: match.value } : undefined);
          }

          return Promise.resolve(undefined);
        },
        executeTakeFirstOrThrow() {
          if (table === "users") {
            if (throwUsers) {
              throw new Error("users table missing");
            }

            return Promise.resolve({ count: userCount });
          }

          throw new Error(`Unsupported table ${table}`);
        },
      };
    },
  };
}

test("handleSetupStatus reports a fresh setup state when Mini tables are missing", async () => {
  const response = await handleSetupStatus({
    db: createDbStub({ throwOptions: true, throwUsers: true }),
  });

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.deepEqual(body, {
    data: {
      needsSetup: true,
      step: "start",
      seedInfo: null,
      authMode: "passkey",
    },
  });
});

test("handleSetupStatus reports setup complete when the flag is set and users exist", async () => {
  const response = await handleSetupStatus({
    db: createDbStub({
      options: [{ name: "emdash:setup_complete", value: "true" }],
      userCount: 1,
    }),
  });

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.deepEqual(body, {
    data: {
      needsSetup: false,
    },
  });
});

test("Mini middleware no longer overrides the EmDash setup-status route locally", async () => {
  const contents = await readFile(middlewareEntryPath, "utf8");

  assert.doesNotMatch(contents, /\/_emdash\/api\/setup\/status/);
});

test("patched EmDash setup-status route includes the db fallback compatibility seam", async () => {
  const contents = await readFile(emdashSetupStatusRoutePath, "utf8");

  assert.match(contents, /import \{ getDb \} from "\.\.\/\.\.\/\.\.\/\.\.\/loader\.js";/);
  assert.match(contents, /const db = emdash\?\.db \?\? \(await getDb\(\)\);/);
  assert.doesNotMatch(contents, /apiError\("NOT_CONFIGURED", "EmDash is not initialized", 500\)/);
});

test("tracked EmDash patch preserves the shared setup-status compatibility seam", async () => {
  const contents = await readFile(emdashPatchPath, "utf8");

  assert.match(contents, /diff --git a\/src\/astro\/routes\/api\/setup\/status\.ts b\/src\/astro\/routes\/api\/setup\/status\.ts/);
  assert.match(contents, /\+import \{ getDb \} from "\.\.\/\.\.\/\.\.\/\.\.\/loader\.js";/);
  assert.match(contents, /\+\t\tconst db = emdash\?\.db \?\? \(await getDb\(\)\);/);
  assert.match(contents, /\+\t\tconst useExternalAuth = authMode\?\.type === "external";/);
});
