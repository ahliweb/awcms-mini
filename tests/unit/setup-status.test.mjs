import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { handleSetupStatus } from "../../src/auth/handlers/setup-status.mjs";

const middlewareEntryPath = fileURLToPath(new URL("../../src/auth/middleware-entry.mjs", import.meta.url));
const emdashSetupStatusRoutePath = fileURLToPath(
  new URL("../../node_modules/emdash/src/astro/routes/api/setup/status.ts", import.meta.url),
);
const emdashMiddlewarePath = fileURLToPath(new URL("../../node_modules/emdash/src/astro/middleware.ts", import.meta.url));
const emdashMiddlewareDistPath = fileURLToPath(
  new URL("../../node_modules/emdash/dist/astro/middleware.mjs", import.meta.url),
);
const emdashSetupIndexRoutePath = fileURLToPath(
  new URL("../../node_modules/emdash/src/astro/routes/api/setup/index.ts", import.meta.url),
);
const emdashSetupAdminRoutePath = fileURLToPath(
  new URL("../../node_modules/emdash/src/astro/routes/api/setup/admin.ts", import.meta.url),
);
const emdashSetupAdminVerifyRoutePath = fileURLToPath(
  new URL("../../node_modules/emdash/src/astro/routes/api/setup/admin-verify.ts", import.meta.url),
);
const emdashAdminRoutePath = fileURLToPath(new URL("../../node_modules/emdash/src/astro/routes/admin.astro", import.meta.url));
const emdashPatchPath = fileURLToPath(new URL("../../patches/emdash@0.7.0.patch", import.meta.url));

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
  assert.match(contents, /const db = emdash\?\.db \?\? \(await withTimeout\(getDb\(\)\)\);/);
  assert.doesNotMatch(contents, /apiError\("NOT_CONFIGURED", "EmDash is not initialized", 500\)/);
});

test("patched EmDash middleware treats setup-status as a setup-safe path", async () => {
  const contents = await readFile(emdashMiddlewarePath, "utf8");

  assert.match(contents, /const isSetupApiRoute = url\.pathname\.startsWith\("\/_emdash\/api\/setup"\);/);
  assert.match(contents, /if \(isSetupShellRoute \|\| isSetupApiRoute(?: \|\| isPublicEdgeHealthRoute)?\) \{/);
});

test("patched EmDash dist middleware treats setup-status as a setup-safe path", async () => {
  const contents = await readFile(emdashMiddlewareDistPath, "utf8");

  assert.match(contents, /const isSetupShellRoute = url\.pathname\.startsWith\("\/_emdash\/admin\/setup"\);/);
  assert.match(contents, /const isSetupApiRoute = url\.pathname\.startsWith\("\/_emdash\/api\/setup"\);/);
  assert.match(contents, /if \(isSetupShellRoute \|\| isSetupApiRoute \|\| isPublicEdgeHealthRoute\) \{/);
});

test("patched EmDash setup API routes use shared db and config fallbacks", async () => {
  const setupIndexContents = await readFile(emdashSetupIndexRoutePath, "utf8");
  const setupAdminContents = await readFile(emdashSetupAdminRoutePath, "utf8");
  const setupAdminVerifyContents = await readFile(emdashSetupAdminVerifyRoutePath, "utf8");

  assert.match(setupIndexContents, /import virtualConfig from "virtual:emdash\/config";/);
  assert.match(setupIndexContents, /import \{ createStorage as virtualCreateStorage \} from "virtual:emdash\/storage";/);
  assert.match(setupIndexContents, /import \{ getDb \} from "\.\.\/\.\.\/\.\.\/\.\.\/loader\.js";/);
  assert.match(setupIndexContents, /const db = emdash\?\.db \?\? \(await getDb\(\)\);/);
  assert.match(setupIndexContents, /const config = emdash\?\.config \?\? virtualConfig;/);
  assert.match(setupIndexContents, /const storage =/);
  assert.match(setupIndexContents, /async function shouldRunSetupCoreMigrations\(db\) \{/);
  assert.match(setupIndexContents, /const applied = await db\.selectFrom\("_emdash_migrations"\)\.select\("name"\)\.limit\(1\)\.execute\(\);/);
  assert.match(setupIndexContents, /const miniMigrations = await db\.selectFrom\("kysely_migration"\)\.select\("name"\)\.limit\(1\)\.execute\(\);/);
  assert.match(setupIndexContents, /async function ensureSetupCompatibilitySchema\(db\) \{/);
  assert.match(setupIndexContents, /ADD COLUMN IF NOT EXISTS has_seo INTEGER NOT NULL DEFAULT 0/);
  assert.match(setupIndexContents, /ADD COLUMN IF NOT EXISTS searchable INTEGER DEFAULT 0/);
  assert.match(setupIndexContents, /if \(await shouldRunSetupCoreMigrations\(db\)\) \{/);
  assert.match(setupIndexContents, /await ensureSetupCompatibilitySchema\(db\);/);
  assert.doesNotMatch(setupIndexContents, /apiError\("NOT_CONFIGURED", "EmDash is not initialized", 500\)/);

  assert.match(setupAdminContents, /import virtualConfig from "virtual:emdash\/config";/);
  assert.match(setupAdminContents, /import \{ getDb \} from "\.\.\/\.\.\/\.\.\/\.\.\/loader\.js";/);
  assert.match(setupAdminContents, /const db = emdash\?\.db \?\? \(await getDb\(\)\);/);
  assert.match(setupAdminContents, /const config = emdash\?\.config \?\? virtualConfig;/);
  assert.doesNotMatch(setupAdminContents, /apiError\("NOT_CONFIGURED", "EmDash is not initialized", 500\)/);

  assert.match(setupAdminVerifyContents, /import virtualConfig from "virtual:emdash\/config";/);
  assert.match(setupAdminVerifyContents, /import \{ getDb \} from "\.\.\/\.\.\/\.\.\/\.\.\/loader\.js";/);
  assert.match(setupAdminVerifyContents, /const db = emdash\?\.db \?\? \(await getDb\(\)\);/);
  assert.match(setupAdminVerifyContents, /const config = emdash\?\.config \?\? virtualConfig;/);
  assert.doesNotMatch(setupAdminVerifyContents, /apiError\("NOT_CONFIGURED", "EmDash is not initialized", 500\)/);
});

test("patched EmDash admin setup route defaults to English", async () => {
  const contents = await readFile(emdashAdminRoutePath, "utf8");

  assert.match(contents, /import \{ DEFAULT_LOCALE, resolveLocale, loadMessages, getLocaleDir \} from "@emdash-cms\/admin\/locales";/);
  assert.match(contents, /const isSetupRoute = new URL\(Astro\.request\.url\)\.pathname === "\/_emdash\/admin\/setup";/);
  assert.match(contents, /const resolvedLocale = isSetupRoute \? DEFAULT_LOCALE : resolveLocale\(Astro\.request\);/);
});

test("tracked EmDash patch preserves the shared setup-status compatibility seam", async () => {
  const contents = await readFile(emdashPatchPath, "utf8");

  assert.match(contents, /diff --git a\/src\/astro\/routes\/api\/setup\/status\.ts b\/src\/astro\/routes\/api\/setup\/status\.ts/);
  assert.match(contents, /\+import \{ getDb \} from "\.\.\/\.\.\/\.\.\/\.\.\/loader\.js";/);
  assert.match(contents, /\+\t\tconst db = emdash\?\.db \?\? \(await getDb\(\)\);/);
  assert.match(contents, /\+\t\tconst useExternalAuth = authMode\?\.type === "external";/);
  assert.match(contents, /\+\t+const isSetupApiRoute = url\.pathname\.startsWith\("\/_emdash\/api\/setup"\);/);
  assert.match(contents, /\+\t+if \(isSetupShellRoute \|\| isSetupApiRoute(?: \|\| isPublicEdgeHealthRoute)?\) \{/);
  assert.match(contents, /diff --git a\/src\/astro\/routes\/api\/setup\/index\.ts b\/src\/astro\/routes\/api\/setup\/index\.ts/);
  assert.match(contents, /\+async function shouldRunSetupCoreMigrations\(db\) \{/);
  assert.match(contents, /\+\t\tconst applied = await db\.selectFrom\("_emdash_migrations"\)\.select\("name"\)\.limit\(1\)\.execute\(\);/);
  assert.match(contents, /\+\t\tconst miniMigrations = await db\.selectFrom\("kysely_migration"\)\.select\("name"\)\.limit\(1\)\.execute\(\);/);
  assert.match(contents, /\+async function ensureSetupCompatibilitySchema\(db\) \{/);
  assert.match(contents, /\+\tawait sql`ALTER TABLE _emdash_collections ADD COLUMN IF NOT EXISTS has_seo INTEGER NOT NULL DEFAULT 0`\.execute\(db\);/);
  assert.match(contents, /\+\t\t\tawait ensureSetupCompatibilitySchema\(db\);/);
  assert.match(contents, /diff --git a\/src\/astro\/routes\/api\/setup\/admin\.ts b\/src\/astro\/routes\/api\/setup\/admin\.ts/);
  assert.match(contents, /diff --git a\/src\/astro\/routes\/api\/setup\/admin-verify\.ts b\/src\/astro\/routes\/api\/setup\/admin-verify\.ts/);
  assert.match(contents, /diff --git a\/src\/astro\/routes\/admin\.astro b\/src\/astro\/routes\/admin\.astro/);
  assert.match(contents, /\+const resolvedLocale = isSetupRoute \? DEFAULT_LOCALE : resolveLocale\(Astro\.request\);/);
});
