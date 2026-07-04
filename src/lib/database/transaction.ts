/**
 * Transaction wrapper + RLS tenant context (doc 16).
 *
 * Aturan:
 * - Semua mutation multi-table lewat withTransaction/withTenant.
 * - RLS context di-set pada AWAL transaction via SET LOCAL (aman untuk
 *   PgBouncer transaction pooling — konteks tidak bocor antar koneksi).
 * - Jangan memanggil provider eksternal di dalam transaction.
 * - Nilai tenantId berasal dari auth middleware, bukan header publik mentah.
 */
import type { Sql, TransactionSql } from "postgres";
import { getSql } from "./db";
import { assertUuid } from "../../modules/_shared/validation";

export type Tx = TransactionSql;

export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  sql: Sql = getSql()
): Promise<T> {
  return sql.begin(async (tx) => fn(tx)) as Promise<T>;
}

/**
 * Menjalankan fn dalam transaction dengan RLS tenant context aktif.
 * Semua query di dalamnya tunduk policy `tenant_id = app.current_tenant_id`.
 * Query tetap wajib memfilter tenant_id eksplisit (defense in depth).
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  sql: Sql = getSql()
): Promise<T> {
  assertUuid(tenantId, "tenantId");
  return withTransaction(async (tx) => {
    // set_config(..., true) = SET LOCAL (transaction-scoped), terparametrisasi.
    await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }, sql);
}
