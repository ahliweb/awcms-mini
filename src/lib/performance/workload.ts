/**
 * Workload operations (Issue #744, epic #738 platform-evolution) — one
 * function per work class named in doc 16 §Connection pooling dan
 * backpressure / `src/lib/database/work-class.ts`, each going through the
 * REAL `withTenant` (`src/lib/database/tenant-context.ts`) chokepoint every
 * production endpoint already uses. This is deliberately NOT a simulated
 * or reimplemented saturation mechanism — it drives the SAME
 * `acquireWorkClassSlot`/circuit-breaker/503+Retry-After path Issue #743
 * shipped, which is the issue's own explicit requirement ("Saturation
 * behavior matches #743 and recovery is demonstrated").
 *
 * Maps the issue's workload-model list onto this repo's five work classes:
 * - "interactive API reads/writes"        -> `interactiveAuditRead` (interactive)
 * - "critical idempotent transactions"    -> `criticalIdempotentWrite` (critical_transaction, reuses the REAL idempotency store)
 * - "reporting/analytics reads"           -> `reportingAggregateRead` (reporting)
 * - "sync/event/job workloads"            -> `backgroundSyncClaim` (background_sync)
 * - "controlled degradation"/maintenance  -> `maintenancePurgeProbe` (maintenance, reuses the REAL `purgeExpiredAuditEvents`)
 */
import { withTenant } from "../database/tenant-context";
import type { WorkClass } from "../database/work-class";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../modules/_shared/idempotency";
import { purgeExpiredAuditEvents } from "../../modules/logging/application/audit-purge";
import { legalHoldGuardPortAdapter } from "../../modules/data-lifecycle/application/legal-hold-guard-port-adapter";

export type WorkloadCallResult = {
  ok: boolean;
  /** Present only when `withTenant` itself short-circuited to a `fail(...)` Response (503 DATABASE_BUSY, 409 IDEMPOTENCY_CONFLICT, ...) rather than running `fn` to completion. */
  status?: number;
  retryAfterSeconds?: number | null;
  errorCode?: string;
};

/**
 * Every real endpoint's handler returns `withTenant`'s result directly as
 * an HTTP `Response` (see `tenant-context.ts`'s own docblock: "in practice
 * every real call site uses `T = Response`"). This workload harness's `fn`
 * callbacks return a plain `{ ok: true }` marker on success instead (no
 * Astro context available outside a real request) — so at runtime the
 * result is EITHER that marker OR a genuine `Response` object from
 * `withTenant`'s own catch paths (pool-busy/circuit-open/idempotency-race).
 * This is the single place that tells those two shapes apart.
 */
/**
 * `withTenant`'s catch paths return `fail(...) as T` — a genuine `Response`
 * object cast, purely for TypeScript's benefit, to whatever type the
 * caller's own `fn` happens to return (see `tenant-context.ts`'s own
 * docblock on this). At runtime that means a caller whose `fn` returns a
 * plain value (not a `Response`) must still be ready to receive a REAL
 * `Response` instance instead, on the saturation/circuit-open/idempotency-
 * race paths. This is the one place that tells the two shapes apart,
 * shared by every `runWorkClassCall`-based probe AND `maintenancePurgeProbe`
 * (which calls `withTenant` indirectly through `purgeExpiredAuditEvents`).
 */
async function classifyResult(result: unknown): Promise<WorkloadCallResult> {
  if (result instanceof Response) {
    const body = (await result.clone().json()) as {
      error?: { code?: string };
    };

    return {
      ok: result.status < 300,
      status: result.status,
      retryAfterSeconds: result.headers.get("Retry-After")
        ? Number(result.headers.get("Retry-After"))
        : null,
      errorCode: body?.error?.code
    };
  }

  return { ok: true };
}

async function runWorkClassCall(
  sql: Bun.SQL,
  tenantId: string,
  workClass: WorkClass,
  fn: (tx: Bun.TransactionSQL) => Promise<unknown>,
  queueTimeoutMs?: number
): Promise<WorkloadCallResult> {
  const result = await withTenant(
    sql,
    tenantId,
    async (tx) => {
      await fn(tx);
      return { __workloadOk: true as const };
    },
    { workClass, queueTimeoutMs }
  );

  return classifyResult(result);
}

const AUDIT_READ_LIMIT = 50;

/** "interactive" — real RLS-scoped keyset-style read of `awcms_mini_audit_events`, same shape as `GET /api/v1/logs/audit`. */
export async function interactiveAuditRead(
  sql: Bun.SQL,
  tenantId: string,
  queueTimeoutMs?: number
): Promise<WorkloadCallResult> {
  return runWorkClassCall(
    sql,
    tenantId,
    "interactive",
    async (tx) => {
      await tx`
        SELECT id, action, severity, created_at
        FROM awcms_mini_audit_events
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${AUDIT_READ_LIMIT}
      `;
    },
    queueTimeoutMs
  );
}

const CRITICAL_TRANSACTION_REQUEST_SCOPE =
  "performance.synthetic.critical_transaction";

/**
 * "critical_transaction" — reuses the REAL idempotency store
 * (`src/modules/_shared/idempotency.ts`), the same mechanism every
 * high-risk mutation endpoint in this repo already depends on. Calling
 * this concurrently with the SAME `idempotencyKey` is exactly the
 * "critical transactions remain atomic/idempotent... under load" proof —
 * `withTenant` itself catches the real `IdempotencyRaceLostError` and
 * returns the SAME replayed response to every loser, which is what
 * `ok: true` for every caller (not just the winner) demonstrates.
 */
export async function criticalIdempotentWrite(
  sql: Bun.SQL,
  tenantId: string,
  idempotencyKey: string,
  queueTimeoutMs?: number
): Promise<WorkloadCallResult> {
  const payload = { synthetic: true, idempotencyKey };
  const requestHash = computeRequestHash(payload);

  return runWorkClassCall(
    sql,
    tenantId,
    "critical_transaction",
    async (tx) => {
      const existing = await findIdempotencyRecord(
        tx,
        tenantId,
        CRITICAL_TRANSACTION_REQUEST_SCOPE,
        idempotencyKey
      );

      if (existing) {
        return;
      }

      await saveIdempotencyRecord(
        tx,
        tenantId,
        CRITICAL_TRANSACTION_REQUEST_SCOPE,
        idempotencyKey,
        requestHash,
        200,
        { synthetic: true }
      );
    },
    queueTimeoutMs
  );
}

/** "reporting" — real RLS-scoped aggregate read (severity histogram), never `interactive`-classed, matching doc 16's "reports must not compete with interactive traffic for the same pool slots" rule. */
export async function reportingAggregateRead(
  sql: Bun.SQL,
  tenantId: string,
  queueTimeoutMs?: number
): Promise<WorkloadCallResult> {
  return runWorkClassCall(
    sql,
    tenantId,
    "reporting",
    async (tx) => {
      await tx`
        SELECT severity, count(*)::int AS event_count
        FROM awcms_mini_audit_events
        WHERE tenant_id = ${tenantId}
        GROUP BY severity
      `;
    },
    queueTimeoutMs
  );
}

const SYNC_CLAIM_LIMIT = 25;

/** "background_sync" — same claim shape as `object-dispatch.ts`'s real outbox-claim query (`FOR UPDATE SKIP LOCKED`), without invoking any real external provider (never dials R2/email — this is a pure DB-side claim probe). */
export async function backgroundSyncClaim(
  sql: Bun.SQL,
  tenantId: string,
  queueTimeoutMs?: number
): Promise<WorkloadCallResult> {
  return runWorkClassCall(
    sql,
    tenantId,
    "background_sync",
    async (tx) => {
      const leaseExpiry = new Date(Date.now() + 2 * 60_000);

      await tx`
        UPDATE awcms_mini_object_sync_queue
        SET status = 'sending', next_retry_at = ${leaseExpiry}
        WHERE id IN (
          SELECT id FROM awcms_mini_object_sync_queue
          WHERE tenant_id = ${tenantId}
            AND status = 'pending'
            AND (next_retry_at IS NULL OR next_retry_at <= now())
          ORDER BY created_at
          LIMIT ${SYNC_CLAIM_LIMIT}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `;
    },
    queueTimeoutMs
  );
}

/**
 * Retention/purge cutoff so far in the past (~274 years) that this probe
 * NEVER actually deletes any seeded fixture row — the saturation scenario
 * only needs to exercise the real "maintenance" work-class slot/queue, not
 * mutate data other scenarios in the same run depend on (see
 * `fixture-generator.ts`'s synthetic rows, all within the last ~400 days).
 */
const MAINTENANCE_PROBE_RETENTION_DAYS = 100_000;

/**
 * "maintenance" — reuses the REAL `purgeExpiredAuditEvents` (Issue #447),
 * the same function `scripts/audit-log-purge.ts` schedules in production,
 * with a retention window guaranteed to match zero rows (see constant
 * above) so this probe is side-effect-free against fixture data.
 *
 * `purgeExpiredAuditEvents` calls `withTenant` with `T = number`
 * (`deleted.length`) — so on the saturation/circuit-open path,
 * `withTenant`'s catch block still returns `fail(...) as T`: a real
 * `Response` object, TYPED as `number` but never actually one at runtime.
 * `purgeExpiredAuditEvents` itself never inspects that value (it just
 * forwards it as `purgedCount` in its own return shape), so nothing
 * throws — the saturation outcome must be read back out of
 * `result.purgedCount` here, not caught as an exception.
 *
 * Passes the REAL `legalHoldGuardPortAdapter` (Issue #745, epic #738 —
 * `src/modules/data-lifecycle/application/legal-hold-guard-port-adapter.ts`),
 * the same composition-root wiring `scripts/audit-log-purge.ts` uses, not a
 * fake/no-op guard — this module lives outside any module's `application`/
 * `domain` tree (like that script), so importing it directly here does not
 * create the cross-module cycle `tests/unit/module-boundary-cycles.test.ts`
 * forbids.
 */
export async function maintenancePurgeProbe(
  sql: Bun.SQL,
  tenantId: string
): Promise<WorkloadCallResult> {
  const result = await purgeExpiredAuditEvents(
    sql,
    tenantId,
    legalHoldGuardPortAdapter,
    {
      retentionDays: MAINTENANCE_PROBE_RETENTION_DAYS,
      batchLimit: 1
    }
  );

  return classifyResult(result.purgedCount);
}
