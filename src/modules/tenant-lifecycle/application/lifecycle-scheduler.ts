/**
 * `tenant_lifecycle` scheduled-transition runner (Issue #873, epic pattern #3).
 * Applies a tenant's DUE scheduled transition (trial/grace/renewal expiry)
 * inside its OWN tenant-scoped transaction, so the row-lock + state+version-
 * predicated UPDATE make the apply IDEMPOTENT under concurrent workers: the
 * FIRST worker transitions the tenant and clears the schedule; a SECOND
 * concurrent worker either blocks on the row lock and then finds the schedule
 * already cleared (a clean no-op), or loses the predicated UPDATE (0 rows -> a
 * no-op). No `Promise.all` on a single tx (memory
 * `promise-all-on-single-tx-hang`) — each tenant is a fully independent
 * transaction. LAN/offline safe: no provider call, DB-only.
 */
import { assertUuid } from "../../../lib/database/tenant-context";
import {
  applyDueSchedule,
  type LifecycleActionContext,
  type LifecycleEngineDeps,
  type ScheduledApplyResult
} from "./lifecycle-transition";

/**
 * Run `fn` in a fresh transaction scoped to `tenantId` (RLS). Deliberately NOT
 * `withTenant` (route-shaped: it can return a 503 `Response` on pool
 * saturation) — the scheduler owns one transaction per tenant apply.
 */
async function inTenantTx<T>(
  sql: Bun.SQL,
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  const safe = assertUuid(tenantId);
  return sql.begin(async (tx: Bun.SQL) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${safe}'`);
    return fn(tx);
  }) as Promise<T>;
}

/** Apply the due scheduled transition for ONE tenant (idempotent). */
export async function runDueScheduleForTenant(
  sql: Bun.SQL,
  tenantId: string,
  deps: LifecycleEngineDeps,
  ctx: LifecycleActionContext,
  now: Date = new Date()
): Promise<ScheduledApplyResult> {
  return inTenantTx(sql, tenantId, (tx) =>
    applyDueSchedule(tx, tenantId, now, deps, ctx)
  );
}
