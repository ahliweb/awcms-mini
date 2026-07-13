/**
 * Thin I/O metrics sampling (Issue #744, epic #738 platform-evolution) —
 * the CPU/memory/pool/queue/lock-wait side of the issue's required metric
 * list, complementing `metrics-aggregate.ts`'s pure latency/throughput
 * aggregation. Every function here is a narrow, read-only wrapper around
 * either Bun/Node's own process introspection or an EXISTING mechanism
 * this repo already ships (`getWorkClassSaturation`, Issue 10.2/#698) —
 * nothing here reimplements pool/queue accounting a second time.
 */
import {
  getWorkClassSaturation,
  type WorkClassSaturation
} from "../database/work-class";

export type ProcessResourceSnapshot = {
  atMs: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  rssBytes: number;
  heapUsedBytes: number;
};

/** Absolute snapshot — callers diff two snapshots (`diffProcessResources`) to get a scenario's own delta, never a process-lifetime cumulative number. */
export function sampleProcessResources(): ProcessResourceSnapshot {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();

  return {
    atMs: performance.now(),
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed
  };
}

export type ProcessResourceDelta = {
  wallClockMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  rssDeltaMb: number;
  heapUsedDeltaMb: number;
};

export function diffProcessResources(
  before: ProcessResourceSnapshot,
  after: ProcessResourceSnapshot
): ProcessResourceDelta {
  return {
    wallClockMs: after.atMs - before.atMs,
    cpuUserMs: (after.cpuUserMicros - before.cpuUserMicros) / 1000,
    cpuSystemMs: (after.cpuSystemMicros - before.cpuSystemMicros) / 1000,
    rssDeltaMb: (after.rssBytes - before.rssBytes) / (1024 * 1024),
    heapUsedDeltaMb:
      (after.heapUsedBytes - before.heapUsedBytes) / (1024 * 1024)
  };
}

/** Direct passthrough to the REAL work-class gate snapshot (Issue 10.2/#743/#698) — never a shadow re-implementation of active/queued accounting. */
export function sampleWorkClassSaturation(): WorkClassSaturation[] {
  return getWorkClassSaturation();
}

export type DatabaseActivitySnapshot = {
  activeConnections: number;
  waitingLocks: number;
  longestRunningQuerySeconds: number;
};

/**
 * Read-only snapshot of `pg_stat_activity`/`pg_locks` for the CURRENT
 * database only (`datname = current_database()`), scoped to non-idle
 * backends so a large idle connection pool doesn't inflate
 * `activeConnections`. This is the "statement duration" and "lock waits"
 * signal the issue's metric list names — sourced from PostgreSQL's own
 * system views, never a second bookkeeping mechanism.
 */
export async function sampleDatabaseActivity(
  sql: Bun.SQL
): Promise<DatabaseActivitySnapshot> {
  const [activityRows, lockRows] = await Promise.all([
    sql`
      SELECT count(*)::int AS active_count,
             coalesce(max(extract(epoch FROM (now() - query_start))), 0) AS longest_seconds
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND pid <> pg_backend_pid()
    `,
    sql`
      SELECT count(*)::int AS waiting_count
      FROM pg_locks
      WHERE NOT granted
    `
  ]);

  const activityRow = (
    activityRows as { active_count: number; longest_seconds: number }[]
  )[0];
  const lockRow = (lockRows as { waiting_count: number }[])[0];

  return {
    activeConnections: activityRow?.active_count ?? 0,
    waitingLocks: lockRow?.waiting_count ?? 0,
    longestRunningQuerySeconds: Number(activityRow?.longest_seconds ?? 0)
  };
}
