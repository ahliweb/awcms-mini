/**
 * Koneksi PostgreSQL AWCMS-Mini (doc 16 — Backend Data Access).
 * Driver: postgres.js — parameterized, pooled, kompatibel Bun & Node.
 */
import postgres, { type Sql } from "postgres";
import { getConfig } from "../config";

let cachedSql: Sql | undefined;

export function getSql(): Sql {
  if (!cachedSql) {
    const config = getConfig();
    cachedSql = postgres(config.database.url, {
      max: config.database.poolMax,
      // PgBouncer transaction pooling tidak aman dengan prepared statements.
      prepare: !config.database.pgbouncer,
      connection: {
        statement_timeout: config.database.statementTimeoutMs
      },
      onnotice: () => {
        /* redam notice; migration runner menangani outputnya sendiri */
      }
    });
  }
  return cachedSql;
}

export async function closeSql(): Promise<void> {
  if (cachedSql) {
    await cachedSql.end({ timeout: 5 });
    cachedSql = undefined;
  }
}
