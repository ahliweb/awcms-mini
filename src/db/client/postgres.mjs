import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

import { getRuntimeConfig } from "../../config/runtime.mjs";

const { Pool } = pg;

export function resolvePostgresSslOptions(runtimeConfig = getRuntimeConfig()) {
  try {
    const parsed = new URL(runtimeConfig.databaseUrl);
    const sslmode = parsed.searchParams.get("sslmode");

    if (sslmode === "verify-full") {
      return { rejectUnauthorized: true };
    }

    if (sslmode === "require" || sslmode === "verify-ca" || sslmode === "prefer") {
      return { rejectUnauthorized: false };
    }
  } catch {
    // Fall back to the reviewed production TLS posture below.
  }

  return undefined;
}

export function resolvePostgresConnectionTarget(runtimeConfig = getRuntimeConfig(), options = {}) {
  return {
    transport: "direct",
    source: "DATABASE_URL",
    connectionString: runtimeConfig.databaseUrl,
  };
}

export function resolvePostgresConnectionString(runtimeConfig = getRuntimeConfig(), options = {}) {
  return resolvePostgresConnectionTarget(runtimeConfig, options).connectionString;
}

export function buildPostgresPoolConfig(runtimeConfig = getRuntimeConfig(), options = {}) {
  return {
    connectionString: resolvePostgresConnectionString(runtimeConfig, options),
    connectionTimeoutMillis: runtimeConfig.databaseConnectTimeoutMs,
    allowExitOnIdle: true,
    ssl: resolvePostgresSslOptions(runtimeConfig),
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
