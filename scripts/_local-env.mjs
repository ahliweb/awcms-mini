import { existsSync } from "node:fs";

const LOCAL_ENV_FILES = [".env.local", ".env"];

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
  if (env.DATABASE_URL && !env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE) {
    env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = env.DATABASE_URL;
  }

  return env;
}
