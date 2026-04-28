import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyLocalCloudflareRuntimeEnv,
  assertRequiredWorkerSecretsPresent,
  cleanupGeneratedCloudflareLocalSecretFiles,
  findMissingRequiredWorkerSecrets,
  getRequiredWorkerSecrets,
  resolveLocalEnvFiles,
} from "../../scripts/_local-env.mjs";

test("resolveLocalEnvFiles follows Cloudflare .env precedence for environment-specific files", async () => {
  assert.deepEqual(resolveLocalEnvFiles({ CLOUDFLARE_ENV: "staging" }), [
    ".env.staging.local",
    ".env.local",
    ".env.staging",
    ".env",
  ]);
});

test("resolveLocalEnvFiles falls back to NODE_ENV when CLOUDFLARE_ENV is unset", async () => {
  assert.deepEqual(resolveLocalEnvFiles({ NODE_ENV: "production" }), [
    ".env.production.local",
    ".env.local",
    ".env.production",
    ".env",
  ]);
});

test("resolveLocalEnvFiles keeps the generic local env files when no environment is set", async () => {
  assert.deepEqual(resolveLocalEnvFiles({}), [".env.local", ".env"]);
});

test("getRequiredWorkerSecrets reads the reviewed required secret names from wrangler config", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "awcms-mini-worker-secrets-"));
  const configPath = join(rootDir, "wrangler.jsonc");

  await writeFile(
    configPath,
    JSON.stringify({
      secrets: {
        required: ["APP_SECRET", "EDGE_API_JWT_SECRET"],
      },
    }),
  );

  assert.deepEqual(getRequiredWorkerSecrets(configPath), ["APP_SECRET", "EDGE_API_JWT_SECRET"]);
});

test("findMissingRequiredWorkerSecrets reports only missing reviewed secret names", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "awcms-mini-worker-secrets-"));
  const configPath = join(rootDir, "wrangler.jsonc");

  await writeFile(
    configPath,
    JSON.stringify({
      secrets: {
        required: ["APP_SECRET", "EDGE_API_JWT_SECRET", "TURNSTILE_SECRET_KEY"],
      },
    }),
  );

  assert.deepEqual(
    findMissingRequiredWorkerSecrets(
      {
        APP_SECRET: "local-app-secret",
        TURNSTILE_SECRET_KEY: "turnstile-secret",
      },
      configPath,
    ),
    ["EDGE_API_JWT_SECRET"],
  );
});

test("assertRequiredWorkerSecretsPresent fails clearly when reviewed Worker secrets are missing", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "awcms-mini-worker-secrets-"));
  const configPath = join(rootDir, "wrangler.jsonc");

  await writeFile(
    configPath,
    JSON.stringify({
      secrets: {
        required: ["APP_SECRET", "EDGE_API_JWT_SECRET"],
      },
    }),
  );

  assert.throws(
    () => assertRequiredWorkerSecretsPresent({ APP_SECRET: "local-app-secret" }, configPath),
    /Missing required Worker secrets: EDGE_API_JWT_SECRET/,
  );
});

test("applyLocalCloudflareRuntimeEnv remains a no-op for direct backend database access", async () => {
  const env = {
    DATABASE_TRANSPORT: "direct",
    DATABASE_URL: "postgres://postgres:postgres@localhost:55432/awcms_mini_dev",
  };

  assert.equal(applyLocalCloudflareRuntimeEnv(env), env);
});

test("applyLocalCloudflareRuntimeEnv remains a no-op when transport is unset", async () => {
  const env = {};

  assert.equal(applyLocalCloudflareRuntimeEnv(env), env);
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
