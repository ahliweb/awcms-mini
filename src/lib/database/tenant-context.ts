import { fail } from "../../modules/_shared/api-response";
import { log } from "../logging/logger";
import { getDatabaseCircuitBreaker } from "./circuit-breaker";
import {
  acquireWorkClassSlot,
  getWorkClassSaturation,
  WorkClassTimeoutError,
  type WorkClass
} from "./work-class";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_QUEUE_TIMEOUT_MS = 2000;

export function assertUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`Expected a UUID, received: ${value}`);
  }

  return value;
}

export type WithTenantOptions = {
  /** Defaults to "interactive" (doc 16 §Connection pooling dan backpressure). */
  workClass?: WorkClass;
  /** Defaults to 2000ms. */
  queueTimeoutMs?: number;
};

/**
 * Runs `fn` inside a tenant-scoped transaction, protected by the Issue 10.2
 * pool gate + circuit breaker (doc 16). This is the single highest-leverage
 * integration point: every existing endpoint already calls `withTenant`, so
 * extending it here protects all of them without touching ~25 route files.
 *
 * `T` is generic for backward compatibility, but in practice every real call
 * site uses `T = Response` (every existing endpoint returns the result of
 * `withTenant` directly from its handler, matching how Issue 8.1/9.1's
 * endpoints already implicitly assume this). The `fail(...)` calls below are
 * therefore cast to `T` — this is type-safe in practice, even though the
 * generic signature doesn't statically enforce `T = Response`.
 */
export async function withTenant<T>(
  sql: Bun.SQL,
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>,
  options?: WithTenantOptions
): Promise<T> {
  const safeTenantId = assertUuid(tenantId);
  const workClass = options?.workClass ?? "interactive";
  const queueTimeoutMs = options?.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  const breaker = getDatabaseCircuitBreaker();
  const now = new Date();

  if (!breaker.canAttempt(now)) {
    return fail(503, "DATABASE_BUSY", "Database circuit breaker is open.") as T;
  }

  let slot;

  try {
    slot = await acquireWorkClassSlot(workClass, queueTimeoutMs);
  } catch (error) {
    if (error instanceof WorkClassTimeoutError) {
      log("warning", "database.pool.saturated", {
        moduleKey: "database-connectivity",
        workClass,
        queueTimeoutMs,
        saturation: getWorkClassSaturation()
      });

      return fail(
        503,
        "DATABASE_BUSY",
        `Database work-class "${workClass}" is saturated.`
      ) as T;
    }

    throw error;
  }

  try {
    const result = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${safeTenantId}'`);

      return fn(tx);
    });

    breaker.recordSuccess(new Date());

    return result;
  } catch (error) {
    breaker.recordFailure(new Date());
    throw error;
  } finally {
    slot.release();
  }
}
