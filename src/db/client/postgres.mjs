import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

import { getRuntimeConfig } from "../../config/runtime.mjs";

const { Pool } = pg;

export function createPostgresPool() {
  const { databaseUrl } = getRuntimeConfig();

  return new Pool({
    connectionString: databaseUrl,
  });
}

export function createDatabase() {
  return new Kysely({
    dialect: new PostgresDialect({
      pool: createPostgresPool(),
    }),
  });
}
