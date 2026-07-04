/**
 * Kesehatan pool database (doc 16 — pooling & backpressure).
 * Dipakai endpoint /api/v1/database/pool/health dan script db:pool:health.
 */
import { getSql } from "./db";
import { getConfig } from "../config";

export type PoolHealth = {
  status: "ok" | "degraded" | "down";
  latencyMs?: number;
  poolMax: number;
  pgbouncer: boolean;
  checkedAt: string;
  error?: string;
};

export async function checkPoolHealth(timeoutMs = 5000): Promise<PoolHealth> {
  const config = getConfig();
  const base = {
    poolMax: config.database.poolMax,
    pgbouncer: config.database.pgbouncer,
    checkedAt: new Date().toISOString()
  };
  const started = performance.now();
  try {
    const sql = getSql();
    await Promise.race([
      sql`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("pool health timeout")), timeoutMs)
      )
    ]);
    const latencyMs = Math.round(performance.now() - started);
    return {
      ...base,
      status: latencyMs > 1000 ? "degraded" : "ok",
      latencyMs
    };
  } catch (error) {
    return {
      ...base,
      status: "down",
      error: error instanceof Error ? error.message : "unknown error"
    };
  }
}
