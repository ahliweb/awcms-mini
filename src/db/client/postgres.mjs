import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

import { getRuntimeConfig } from "../../config/runtime.mjs";

const { Pool } = pg;
let cloudflareWorkersEnv = null;

try {
  ({ env: cloudflareWorkersEnv } = await import("cloudflare:workers"));
} catch {
  cloudflareWorkersEnv = null;
}

function readLocalHyperdriveConnectionString(bindingName, env = process.env) {
  const variableName = `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${bindingName}`;
  const value = env[variableName];

  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  return null;
}

export function resolvePostgresConnectionString(runtimeConfig = getRuntimeConfig(), options = {}) {
  if (runtimeConfig.databaseTransport !== "hyperdrive") {
    return runtimeConfig.databaseUrl;
  }

  const workersEnv = options.workersEnv ?? cloudflareWorkersEnv;
  const binding = workersEnv?.[runtimeConfig.hyperdriveBinding];
  const connectionString = binding?.connectionString;

  if (typeof connectionString === "string" && connectionString.trim().length > 0) {
    return connectionString;
  }

  const localConnectionString = readLocalHyperdriveConnectionString(runtimeConfig.hyperdriveBinding, options.env);

  if (localConnectionString) {
    return localConnectionString;
  }

  throw new Error(
    `Hyperdrive transport requires the Cloudflare binding '${runtimeConfig.hyperdriveBinding}' with a connectionString value.`,
  );
}

export function buildPostgresPoolConfig(runtimeConfig = getRuntimeConfig(), options = {}) {
  return {
    connectionString: resolvePostgresConnectionString(runtimeConfig, options),
    connectionTimeoutMillis: runtimeConfig.databaseConnectTimeoutMs,
    allowExitOnIdle: true,
  };
}

export function createPostgresPool(runtimeConfig = getRuntimeConfig()) {
  const poolConfig = buildPostgresPoolConfig(runtimeConfig);

  const pool = new Pool(poolConfig);

  pool.on("error", (error) => {
    console.error("[db] idle client error", error);
  });

  return pool;
}

export function createDatabase() {
  return new Kysely({
    dialect: new PostgresDialect({
      pool: createPostgresPool(),
    }),
  });
}
