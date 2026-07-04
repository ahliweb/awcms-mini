/**
 * Idempotency store berbasis PostgreSQL (doc 16) — tabel awcms_idempotency_keys.
 * Retention 7–30 hari (doc 04); pembersihan lewat job maintenance.
 */
import type { Sql } from "postgres";
import { getSql } from "./db";
import type { IdempotencyRecord, IdempotencyStore } from "../../modules/_shared/idempotency";

type Row = {
  idempotency_key: string;
  request_hash: string;
  status: "in_progress" | "completed";
  response_status: number | null;
  response_body: unknown;
};

export function createIdempotencyStore(sql: Sql = getSql()): IdempotencyStore {
  return {
    async find(tenantId, key) {
      const rows = await sql<Row[]>`
        SELECT idempotency_key, request_hash, status, response_status, response_body
        FROM awcms_idempotency_keys
        WHERE tenant_id = ${tenantId} AND idempotency_key = ${key}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return undefined;
      return {
        key: row.idempotency_key,
        requestHash: row.request_hash,
        status: row.status,
        responseStatus: row.response_status ?? undefined,
        responseBody: row.response_body ?? undefined
      } satisfies IdempotencyRecord;
    },

    async start(tenantId, key, requestHash) {
      await sql`
        INSERT INTO awcms_idempotency_keys (tenant_id, idempotency_key, request_hash, status)
        VALUES (${tenantId}, ${key}, ${requestHash}, 'in_progress')
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      `;
    },

    async complete(tenantId, key, responseStatus, responseBody) {
      await sql`
        UPDATE awcms_idempotency_keys
        SET status = 'completed',
            response_status = ${responseStatus},
            response_body = ${sql.json(responseBody as never)},
            completed_at = now()
        WHERE tenant_id = ${tenantId} AND idempotency_key = ${key}
      `;
    }
  };
}
