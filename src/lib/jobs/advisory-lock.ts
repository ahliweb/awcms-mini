/**
 * PostgreSQL session-level advisory lock helper (Issue #697, epic #679,
 * platform-hardening — shared worker runner). Generalizes the
 * `pg_advisory_lock`/`pg_advisory_unlock` pattern `scripts/db-migrate.ts`
 * already uses for its own migration-ledger lock, so `src/lib/jobs/
 * job-runner.ts` doesn't reinvent locking from scratch.
 *
 * Two deliberate differences from `db-migrate.ts`'s own lock:
 *
 * 1. **Session-level, not transaction-level.** A job's lock must stay held
 *    for its ENTIRE run — which typically spans many separate statements/
 *    transactions across a tenant loop, each on its own pooled connection
 *    (see `batching.ts`) — not just the caller's current transaction.
 *    `pg_advisory_xact_lock` releases at the next `COMMIT`/`ROLLBACK` of
 *    whatever transaction acquired it, which would unlock far too early
 *    here. `pg_advisory_lock`/`pg_advisory_unlock` instead stay held for
 *    exactly as long as the dedicated connection this module reserves
 *    (`sql.reserve()`) stays open — fully controlled by the caller
 *    (`acquireAdvisoryLock`/`AdvisoryLockHandle.release()`), independent of
 *    whatever transactions the job's own handler runs on other connections.
 *
 * 2. **Non-blocking (`pg_try_advisory_lock`), not blocking
 *    (`pg_advisory_lock`).** `db-migrate.ts` blocks because there is exactly
 *    one unavoidable bootstrap wait to coordinate (concurrent deploys
 *    racing to apply migrations) and blocking briefly is the right
 *    behavior there. A *scheduled* job runner must never block a cron tick
 *    indefinitely waiting for a previous, possibly-stuck run to finish —
 *    it should skip this tick and let the next one try again (acceptance
 *    criterion: "eksekusi duplikat konkuren ditolak atau di-skip dengan
 *    aman"). `pg_try_advisory_lock` returns immediately either way.
 *
 * Lock key derivation: Postgres advisory locks take a single `bigint` OR a
 * pair of `int4`s. This uses the two-`int4` form — a fixed namespace
 * constant (`JOB_LOCK_NAMESPACE`, distinct from `db-migrate.ts`'s own
 * single-bigint key `975_202_601_372`) plus a stable 32-bit hash of the
 * job's own name, so every job name maps to its own lock (never a single
 * global lock that would make unrelated jobs block each other) and this
 * namespace can never collide with the migration lock's key space.
 *
 * Because a session-level advisory lock is automatically released by
 * PostgreSQL the moment the session/connection that holds it ends (crash,
 * `pg_terminate_backend`, or a clean `close()`), even a hard process kill
 * that skips `AdvisoryLockHandle.release()` entirely still cannot leave the
 * lock stuck forever — the reserved connection dies with the process, and
 * Postgres reclaims the lock. `job-runner.ts` still calls `release()`
 * explicitly on every path (success, error, timeout, SIGTERM/SIGINT) so the
 * *next* run of the same process doesn't have to wait for a TCP-level
 * connection-drop detection.
 */
import { createHash } from "node:crypto";

/** Distinct from `scripts/db-migrate.ts`'s own single-bigint lock key (975_202_601_372) — different key space entirely (two-int4 vs one-bigint), so no collision is even possible. */
export const JOB_LOCK_NAMESPACE = 890_417_233;

/**
 * Stable, deterministic 32-bit (non-negative, fits Postgres `int4`) hash of
 * a job name. Same job name always hashes to the same key (required for the
 * lock to actually coordinate two instances); different job names collide
 * only in the astronomically unlikely event of a SHA-256 partial-preimage
 * collision on the first 4 bytes — acceptable for this use case (a stuck
 * cron job blocking an unrelated one on a hash collision is not a security
 * issue, just a `bun run <job>` skip that clears on the next tick).
 */
export function hashJobNameToInt32(jobName: string): number {
  const digest = createHash("sha256").update(jobName).digest();

  // Mask to 31 bits: Postgres `int4` is signed; staying within the
  // non-negative range keeps the value trivially valid across every
  // driver/serialization path without needing a two's-complement dance.
  return digest.readUInt32BE(0) & 0x7fffffff;
}

export type AdvisoryLockHandle = {
  /**
   * Releases the advisory lock and returns the reserved connection to the
   * pool. Idempotent — safe to call more than once (e.g. once from a
   * `finally` block and again from a signal handler racing it); only the
   * first call does any work.
   */
  release(): Promise<void>;
};

/**
 * Attempts to acquire the session-level advisory lock scoped to `jobName`
 * on a freshly reserved connection. Returns `null` immediately (never
 * blocks) if another session already holds it — the caller (`job-runner.ts`)
 * treats that as "skip this run", never as an error.
 *
 * Reserves its own connection (`sql.reserve()`) purely for holding the
 * lock — the job handler's own queries run on the ordinary pooled `sql`
 * client (or `withTenant`'s per-tenant transactions), never on this
 * reserved connection. This means a handler that hangs indefinitely can
 * never block the lock's own release: `release()` only ever needs this
 * dedicated connection, which nothing else is contending for.
 */
export async function acquireAdvisoryLock(
  sql: Bun.SQL,
  jobName: string
): Promise<AdvisoryLockHandle | null> {
  const reserved = await sql.reserve();
  const lockKey = hashJobNameToInt32(jobName);

  let acquired: boolean;

  try {
    const rows = (await reserved`
      SELECT pg_try_advisory_lock(${JOB_LOCK_NAMESPACE}, ${lockKey}) AS acquired
    `) as { acquired: boolean }[];

    acquired = rows[0]?.acquired ?? false;
  } catch (error) {
    reserved.release();
    throw error;
  }

  if (!acquired) {
    reserved.release();
    return null;
  }

  let released = false;

  return {
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;

      try {
        await reserved`SELECT pg_advisory_unlock(${JOB_LOCK_NAMESPACE}, ${lockKey})`;
      } finally {
        reserved.release();
      }
    }
  };
}
