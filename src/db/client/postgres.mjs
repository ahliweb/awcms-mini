import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

import { getRuntimeConfig } from "../../config/runtime.mjs";

const { Pool } = pg;

export function buildPostgresPoolConfig(runtimeConfig = getRuntimeConfig()) {
  return {
    // Keep SSL/TLS posture in `DATABASE_URL` so deployment config remains the
    // single source of truth for direct PostgreSQL transport settings.
    connectionString: runtimeConfig.databaseUrl,
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
