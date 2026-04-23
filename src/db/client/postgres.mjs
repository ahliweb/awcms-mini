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

function describeLocalHyperdriveVariable(bindingName) {
  return `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${bindingName}`;
}

export function resolvePostgresConnectionTarget(runtimeConfig = getRuntimeConfig(), options = {}) {
  if (runtimeConfig.databaseTransport !== "hyperdrive") {
    return {
      transport: "direct",
      source: "DATABASE_URL",
      connectionString: runtimeConfig.databaseUrl,
    };
  }

  const workersEnv = options.workersEnv ?? cloudflareWorkersEnv;
  const binding = workersEnv?.[runtimeConfig.hyperdriveBinding];
  const connectionString = binding?.connectionString;

  if (typeof connectionString === "string" && connectionString.trim().length > 0) {
    return {
      transport: "hyperdrive",
      source: "Cloudflare Hyperdrive binding",
      binding: runtimeConfig.hyperdriveBinding,
      connectionString,
    };
  }

  const localConnectionString = readLocalHyperdriveConnectionString(runtimeConfig.hyperdriveBinding, options.env);

  if (localConnectionString) {
    return {
      transport: "hyperdrive",
      source: "Local Hyperdrive compatibility env",
      binding: runtimeConfig.hyperdriveBinding,
      localConnectionStringVariable: describeLocalHyperdriveVariable(runtimeConfig.hyperdriveBinding),
      connectionString: localConnectionString,
    };
  }

  throw new Error(
    `Hyperdrive transport requires the Cloudflare binding '${runtimeConfig.hyperdriveBinding}' with a connectionString value.`,
  );
}

export function resolvePostgresConnectionString(runtimeConfig = getRuntimeConfig(), options = {}) {
  return resolvePostgresConnectionTarget(runtimeConfig, options).connectionString;
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
