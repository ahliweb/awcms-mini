import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyLocalCloudflareRuntimeEnv,
  cleanupGeneratedCloudflareLocalSecretFiles,
} from "../../scripts/_local-env.mjs";

test("applyLocalCloudflareRuntimeEnv derives the local Hyperdrive connection string from DATABASE_URL", async () => {
  const env = {
    DATABASE_TRANSPORT: "hyperdrive",
    DATABASE_URL: "postgres://postgres:postgres@localhost:55432/awcms_mini_dev",
  };

  applyLocalCloudflareRuntimeEnv(env);

  assert.equal(
    env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,
    "postgres://postgres:postgres@localhost:55432/awcms_mini_dev",
  );
});

test("applyLocalCloudflareRuntimeEnv preserves an explicit local Hyperdrive override", async () => {
  const env = {
    DATABASE_TRANSPORT: "hyperdrive",
    DATABASE_URL: "postgres://postgres:postgres@localhost:55432/awcms_mini_dev",
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: "postgres://override:override@localhost:55432/override",
  };

  applyLocalCloudflareRuntimeEnv(env);

  assert.equal(
    env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,
    "postgres://override:override@localhost:55432/override",
  );
});

test("applyLocalCloudflareRuntimeEnv skips Hyperdrive connection-string derivation for direct transport", async () => {
  const env = {
    DATABASE_TRANSPORT: "direct",
    DATABASE_URL: "postgres://postgres:postgres@localhost:55432/awcms_mini_dev",
  };

  applyLocalCloudflareRuntimeEnv(env);

  assert.equal(env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE, undefined);
});

test("applyLocalCloudflareRuntimeEnv falls back to the non-secret default database URL for Hyperdrive tooling", async () => {
  const env = {
  };

  applyLocalCloudflareRuntimeEnv(env);

  assert.equal(env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE, "postgres://localhost:5432/awcms_mini_dev");
});

test("cleanupGeneratedCloudflareLocalSecretFiles removes generated dist/server .dev.vars files only", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "awcms-mini-local-env-"));
  const generatedSecretsDirectory = join(rootDir, "dist", "server");
  const generatedSecretFile = join(generatedSecretsDirectory, ".dev.vars");
  const generatedEnvironmentSecretFile = join(generatedSecretsDirectory, ".dev.vars.production");
  const unrelatedFile = join(generatedSecretsDirectory, "entry.mjs");

  await mkdir(generatedSecretsDirectory, { recursive: true });
  await writeFile(generatedSecretFile, "DATABASE_URL=postgres://user:pass@host/db\n");
  await writeFile(generatedEnvironmentSecretFile, "APP_SECRET=test-secret\n");
  await writeFile(unrelatedFile, "export const ok = true;\n");

  const removedFiles = await cleanupGeneratedCloudflareLocalSecretFiles(rootDir);

  assert.deepEqual(removedFiles.sort(), [generatedEnvironmentSecretFile, generatedSecretFile].sort());
  await assert.rejects(access(generatedSecretFile));
  await assert.rejects(access(generatedEnvironmentSecretFile));
  await access(unrelatedFile);
});
