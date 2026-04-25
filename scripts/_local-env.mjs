import { existsSync, readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_DATABASE_URL } from "../src/config/runtime.mjs";

const GENERATED_LOCAL_SECRET_FILES_DIRECTORY = ["dist", "server"];
const DEFAULT_WORKER_CONFIG_PATH = "wrangler.jsonc";

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function resolveLocalEnvironmentName(env = process.env) {
  return normalizeOptionalString(env.CLOUDFLARE_ENV) || normalizeOptionalString(env.NODE_ENV);
}

export function resolveLocalEnvFiles(env = process.env) {
  const environmentName = resolveLocalEnvironmentName(env);
  const files = [];

  if (environmentName) {
    files.push(`.env.${environmentName}.local`);
  }

  files.push(".env.local");

  if (environmentName) {
    files.push(`.env.${environmentName}`);
  }

  files.push(".env");

  return [...new Set(files)];
}

export function getRequiredWorkerSecrets(configPath = DEFAULT_WORKER_CONFIG_PATH) {
  if (!existsSync(configPath)) {
    return [];
  }

  const contents = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(contents);
  const entries = Array.isArray(parsed?.secrets?.required) ? parsed.secrets.required : [];

  return entries
    .map((value) => normalizeOptionalString(value))
    .filter(Boolean);
}

export function findMissingRequiredWorkerSecrets(env = process.env, configPath = DEFAULT_WORKER_CONFIG_PATH) {
  return getRequiredWorkerSecrets(configPath).filter((name) => !normalizeOptionalString(env[name]));
}

export function assertRequiredWorkerSecretsPresent(env = process.env, configPath = DEFAULT_WORKER_CONFIG_PATH) {
  const missing = findMissingRequiredWorkerSecrets(env, configPath);

  if (missing.length > 0) {
    throw new Error(
      `Missing required Worker secrets: ${missing.join(", ")}. Set them in .env.local, .env.<environment>.local, Cloudflare-managed Worker secrets, or process.env.`,
    );
  }

  return getRequiredWorkerSecrets(configPath);
}

function usesHyperdriveTransport(env) {
  return env.DATABASE_TRANSPORT !== "direct";
}

export function loadLocalEnvFiles(env = process.env) {
  if (typeof process.loadEnvFile !== "function") {
    return;
  }

  // `process.loadEnvFile()` does not overwrite existing values, so load the
  // most specific Cloudflare-compatible env file first to keep operator-local
  // secrets ahead of broader tracked defaults.
  for (const file of resolveLocalEnvFiles(env)) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
    }
  }
}

export function applyLocalCloudflareRuntimeEnv(env = process.env) {
  if (
    usesHyperdriveTransport(env) &&
    (env.DATABASE_URL || DEFAULT_DATABASE_URL) &&
    !env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
  ) {
    env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = env.DATABASE_URL || DEFAULT_DATABASE_URL;
  }

  return env;
}

export async function cleanupGeneratedCloudflareLocalSecretFiles(rootDir = process.cwd()) {
  const generatedSecretsDirectory = join(rootDir, ...GENERATED_LOCAL_SECRET_FILES_DIRECTORY);

  let entries;

  try {
    entries = await readdir(generatedSecretsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const removedFiles = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name !== ".dev.vars" && !entry.name.startsWith(".dev.vars.")) {
      continue;
    }

    const filePath = join(generatedSecretsDirectory, entry.name);
    await rm(filePath, { force: true });
    removedFiles.push(filePath);
  }

  return removedFiles;
}
