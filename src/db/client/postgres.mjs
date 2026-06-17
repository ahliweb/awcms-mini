import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

import { getRuntimeConfig } from "../../config/runtime.mjs";

const { Pool } = pg;

function sslOptionsFromConnectionString(connectionString) {
  try {
    const parsed = new URL(connectionString);
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

export function resolvePostgresSslOptions(runtimeConfig = getRuntimeConfig()) {
  return sslOptionsFromConnectionString(runtimeConfig.databaseUrl);
}

/**
 * Mode pooling efektif (ADR-013; personal-coding awcms-shared-standards.md §7.1).
 * - "session" (default): app long-running (Hono); konteks sesi & RLS set_config terjaga.
 * - "transaction": serverless/auto-scaling; koneksi berpindah per-transaksi.
 *
 * Catatan prepared statement (§7.2): driver `pg` + Kysely TIDAK memprepare
 * statement (query tanpa `name`), sehingga aman di transaction mode tanpa flag
 * `prepare:false` khusus. Jangan beri `name` pada query di hot path.
 */
export function resolvePostgresPoolingMode(runtimeConfig = getRuntimeConfig()) {
  return runtimeConfig.databasePoolingMode === "transaction" ? "transaction" : "session";
}

export function resolvePostgresConnectionTarget(runtimeConfig = getRuntimeConfig(), options = {}) {
  // Transport "pooler" (ADR-013): pakai DATABASE_POOLER_URL bila tersedia.
  // Default tetap "direct" (DATABASE_URL) agar backward-compatible.
  if (runtimeConfig.databaseTransport === "pooler" && runtimeConfig.databasePoolerUrl) {
    return {
      transport: "pooler",
      source: "DATABASE_POOLER_URL",
      connectionString: runtimeConfig.databasePoolerUrl,
      poolingMode: resolvePostgresPoolingMode(runtimeConfig),
    };
  }

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
  const connectionString = resolvePostgresConnectionString(runtimeConfig, options);
  return {
    connectionString,
    connectionTimeoutMillis: runtimeConfig.databaseConnectTimeoutMs,
    allowExitOnIdle: true,
    // SSL diturunkan dari connection string aktif (pooler URL bila transport=pooler).
    ssl: sslOptionsFromConnectionString(connectionString),
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
