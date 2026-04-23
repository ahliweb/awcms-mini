import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_DATABASE_URL } from "../src/config/runtime.mjs";

const LOCAL_ENV_FILES = [".env.local", ".env"];
const GENERATED_LOCAL_SECRET_FILES_DIRECTORY = ["dist", "server"];

function usesHyperdriveTransport(env) {
  return env.DATABASE_TRANSPORT !== "direct";
}

export function loadLocalEnvFiles() {
  if (typeof process.loadEnvFile !== "function") {
    return;
  }

  // `process.loadEnvFile()` does not overwrite existing values, so load
  // `.env.local` first to keep operator-local secrets ahead of tracked defaults.
  for (const file of LOCAL_ENV_FILES) {
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
