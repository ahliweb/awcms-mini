import { createHash } from "node:crypto";

/**
 * Cross-cutting idempotency store helper (doc 10 §Idempotency wrapper rules,
 * doc 16 §Idempotency store, skill `awcms-mini-idempotency`). Backed by the
 * generic `awcms_mini_idempotency_keys` table (migration 012), first
 * consumed by the workflow decision endpoint (Issue 11.1) — any future
 * high-risk mutation endpoint in a derived app can reuse the same table with
 * its own `requestScope` string.
 *
 * Flow: same key + same request hash -> replay the stored response; same key
 * + different hash -> `409 IDEMPOTENCY_CONFLICT`; unseen key -> caller runs
 * the mutation and persists the result via `saveIdempotencyRecord`.
 */

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = sortKeysDeep(record[key]);
        return accumulator;
      }, {});
  }

  return value;
}

/** Stable SHA-256 hash of a JSON-serializable payload (key order normalized). */
export function computeRequestHash(payload: unknown): string {
  const stable = JSON.stringify(sortKeysDeep(payload));

  return createHash("sha256").update(stable).digest("hex");
}

export type IdempotencyRecord = {
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
};

/**
 * Thrown by `saveIdempotencyRecord` when a concurrent request already won
 * the race for the same `(tenant_id, request_scope, idempotency_key)` under
 * READ COMMITTED — both requests can pass `findIdempotencyRecord` before
 * either commits. Caught centrally by `withTenant` (the one chokepoint every
 * caller already goes through, per that function's own docblock), which
 * rolls back this transaction (so the loser's mutation never persists —
 * required by the "double submit paralel -> tidak dobel" rule in skill
 * `awcms-mini-idempotency`) and returns a clean `409 IDEMPOTENCY_CONFLICT`
 * instead of leaking a raw unique-violation error to ~25 route files.
 */
export class IdempotencyRaceLostError extends Error {
  constructor(requestScope: string, idempotencyKey: string) {
    super(
      `Idempotency key "${idempotencyKey}" for scope "${requestScope}" was already claimed by a concurrent request.`
    );
    this.name = "IdempotencyRaceLostError";
  }
}

export async function findIdempotencyRecord(
  tx: Bun.SQL,
  tenantId: string,
  requestScope: string,
  idempotencyKey: string
): Promise<IdempotencyRecord | null> {
  const rows = await tx`
    SELECT request_hash, response_status, response_body
    FROM awcms_mini_idempotency_keys
    WHERE tenant_id = ${tenantId} AND request_scope = ${requestScope}
      AND idempotency_key = ${idempotencyKey}
  `;
  const row = rows[0] as
    | { request_hash: string; response_status: number; response_body: unknown }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    requestHash: row.request_hash,
    responseStatus: Number(row.response_status),
    responseBody: row.response_body
  };
}

export async function saveIdempotencyRecord(
  tx: Bun.SQL,
  tenantId: string,
  requestScope: string,
  idempotencyKey: string,
  requestHash: string,
  responseStatus: number,
  responseBody: unknown
): Promise<void> {
  const rows = await tx`
    INSERT INTO awcms_mini_idempotency_keys
      (tenant_id, request_scope, idempotency_key, request_hash, response_status, response_body)
    VALUES (
      ${tenantId}, ${requestScope}, ${idempotencyKey}, ${requestHash},
      ${responseStatus}, ${responseBody}
    )
    ON CONFLICT (tenant_id, request_scope, idempotency_key) DO NOTHING
    RETURNING id
  `;

  if (rows.length === 0) {
    throw new IdempotencyRaceLostError(requestScope, idempotencyKey);
  }
}
