import { PostgresDialect } from "kysely";
import pg from "pg";

import { buildPostgresPoolConfig } from "../db/client/postgres.mjs";
import { getRuntimeConfig } from "../config/runtime.mjs";

const { Pool } = pg;

export function createDialect(config = {}) {
  return new PostgresDialect({
    pool: async () => {
      const runtimeConfig = getRuntimeConfig();

      return new Pool({
        ...buildPostgresPoolConfig(runtimeConfig),
        min: config.pool?.min ?? 0,
        max: config.pool?.max ?? 10,
      });
    },
  });
}
