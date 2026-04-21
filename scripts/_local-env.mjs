import { existsSync } from "node:fs";

import { DEFAULT_DATABASE_URL } from "../src/config/runtime.mjs";

const LOCAL_ENV_FILES = [".env.local", ".env"];

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
