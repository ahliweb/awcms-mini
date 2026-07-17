/**
 * Integration tests for the per-tenant visitor telemetry batcher (Issue
 * #846, epic #818) against a real PostgreSQL, through the same
 * least-privilege app-role client route handlers use (`getTestSql()`).
 *
 * The load-bearing assertion here is `count(DISTINCT xmin)`. Postgres
 * stamps every row with the id of the transaction that inserted it, so
 * "N events cost ONE transaction" is checked against the database's own
 * bookkeeping rather than inferred from timing — a per-event regression
 * would show N distinct xmin values and fail this suite deterministically,
 * on loopback, with no benchmark required.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import {
  buildVisitEventRecord,
  type VisitEventRecord
} from "../../src/modules/visitor-analytics/application/collector";
import {
  BATCH_LINGER_MS,
  MAX_BATCH_SIZE,
  enqueueVisitEvent,
  flushVisitEventBatches,
  getVisitEventBatcherStats,
  resetVisitEventBatcher
} from "../../src/modules/visitor-analytics/application/visit-event-batcher";
import {
  enqueueVisitorTelemetry,
  flushVisitorTelemetryQueue,
  resetVisitorTelemetryQueue
} from "../../src/modules/visitor-analytics/application/telemetry-queue";
import { VISITOR_ANALYTICS_DEFAULTS } from "../../src/modules/visitor-analytics/domain/visitor-analytics-config";
import { hashVisitorKey } from "../../src/modules/visitor-analytics/domain/visitor-key";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const HUMAN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CONFIG = {
  ...VISITOR_ANALYTICS_DEFAULTS,
  enabled: true,
  hashSalt: "batcher-test-salt"
};

function makeRecord(overrides: {
  visitorKey: string;
  path?: string;
  occurredAt?: Date;
  geo?: VisitEventRecord["geo"];
}): VisitEventRecord {
  const record = buildVisitEventRecord(
    {
      correlationId: `corr-${overrides.visitorKey}`,
      config: CONFIG,
      method: "GET",
      rawPath: overrides.path ?? "/pricing",
      statusCode: 200,
      visitorKey: overrides.visitorKey,
      ipAddress: "203.0.113.7",
      userAgent: HUMAN_UA,
      referrerHeader: null,
      isAuthenticated: false,
      identityId: null,
      geo: overrides.geo ?? {
        countryCode: null,
        region: null,
        city: null,
        timezone: null
      }
    },
    overrides.occurredAt
  );

  if (!record) throw new Error("fixture path must be trackable");

  return record;
}

async function seedTenants(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${TENANT_A}, 'tenant-a', 'Tenant A', 'Tenant A Legal', 'active', 'en', 'light'),
      (${TENANT_B}, 'tenant-b', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
  `;
}

/** How many DISTINCT transactions inserted this tenant's visit events. */
async function distinctInsertingTransactions(
  tenantId: string
): Promise<number> {
  const admin = getAdminSql();
  // `xid` has no ordering operator, so DISTINCT needs the ::text cast.
  const rows = (await admin`
    SELECT count(DISTINCT xmin::text)::int AS c
    FROM awcms_mini_visit_events
    WHERE tenant_id = ${tenantId}
  `) as { c: number }[];

  return rows[0]!.c;
}

async function countEvents(tenantId: string): Promise<number> {
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT count(*)::int AS c FROM awcms_mini_visit_events WHERE tenant_id = ${tenantId}
  `) as { c: number }[];

  return rows[0]!.c;
}

async function countSessions(tenantId: string): Promise<number> {
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT count(*)::int AS c FROM awcms_mini_visitor_sessions WHERE tenant_id = ${tenantId}
  `) as { c: number }[];

  return rows[0]!.c;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("visit event batcher", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    resetVisitEventBatcher();
    resetVisitorTelemetryQueue();
    await resetDatabase();
    await seedTenants();
  });

  test("N events for one tenant cost exactly ONE transaction", async () => {
    const sql = getTestSql();

    for (let index = 0; index < 20; index += 1) {
      enqueueVisitEvent(
        sql,
        TENANT_A,
        makeRecord({ visitorKey: `v-${index}` })
      );
    }

    await flushVisitEventBatches(5_000);

    expect(await countEvents(TENANT_A)).toBe(20);
    // The whole point of Issue #846. A regression to a transaction per event
    // makes this 20.
    expect(await distinctInsertingTransactions(TENANT_A)).toBe(1);
  });

  test("each tenant gets its own transaction (a batch is necessarily per-tenant)", async () => {
    const sql = getTestSql();

    for (let index = 0; index < 5; index += 1) {
      enqueueVisitEvent(
        sql,
        TENANT_A,
        makeRecord({ visitorKey: `a-${index}` })
      );
      enqueueVisitEvent(
        sql,
        TENANT_B,
        makeRecord({ visitorKey: `b-${index}` })
      );
    }

    await flushVisitEventBatches(5_000);

    expect(await countEvents(TENANT_A)).toBe(5);
    expect(await countEvents(TENANT_B)).toBe(5);
    expect(await distinctInsertingTransactions(TENANT_A)).toBe(1);
    expect(await distinctInsertingTransactions(TENANT_B)).toBe(1);
    // ...and tenant A's rows were not written by tenant B's transaction.
    const admin = getAdminSql();
    const shared = (await admin`
      SELECT count(*)::int AS c FROM (
        SELECT xmin::text FROM awcms_mini_visit_events WHERE tenant_id = ${TENANT_A}
        INTERSECT
        SELECT xmin::text FROM awcms_mini_visit_events WHERE tenant_id = ${TENANT_B}
      ) AS s
    `) as { c: number }[];
    expect(shared[0]!.c).toBe(0);
  });

  // The two tests below cover what the intra-batch grouping test does NOT.
  // Found by mutation testing: breaking `if (existing && withinSameSession)`
  // outright left the single-batch test GREEN (one batch collapses to one
  // group, so it inserts one session either way), and breaking the bulk
  // UPDATE statement left the WHOLE suite green — because that statement was
  // reached by no test at all, and lives inside the collector's fail-open
  // catch, so a syntax error in it would be swallowed and logged forever
  // rather than failing anything.
  test("a returning visitor reuses the session a PREVIOUS batch created", async () => {
    const sql = getTestSql();

    for (let index = 0; index < 3; index += 1) {
      enqueueVisitEvent(
        sql,
        TENANT_A,
        makeRecord({ visitorKey: "returning", path: `/first-${index}` })
      );
    }
    await flushVisitEventBatches(5_000);
    expect(await countSessions(TENANT_A)).toBe(1);

    // A second, entirely separate batch from the same visitor must find the
    // existing row — not open a new session per batch, which would fragment
    // every returning visitor's session once per flush.
    for (let index = 0; index < 3; index += 1) {
      enqueueVisitEvent(
        sql,
        TENANT_A,
        makeRecord({ visitorKey: "returning", path: `/second-${index}` })
      );
    }
    await flushVisitEventBatches(5_000);

    expect(await countSessions(TENANT_A)).toBe(1);
    expect(await countEvents(TENANT_A)).toBe(6);

    const admin = getAdminSql();
    const sessions = (await admin`
      SELECT DISTINCT visitor_session_id FROM awcms_mini_visit_events
      WHERE tenant_id = ${TENANT_A}
    `) as { visitor_session_id: string }[];
    // All six events point at that one session.
    expect(sessions).toHaveLength(1);
  });

  test("a session past the write throttle is refreshed by the bulk UPDATE", async () => {
    const sql = getTestSql();
    const admin = getAdminSql();

    // Seed a session that is still INSIDE the online window (300s) but older
    // than SESSION_UPDATE_THROTTLE_MS (30s), so the batch is due for a write.
    const staleSeenAt = new Date(Date.now() - 60_000);
    const keyHash = hashVisitorKey("throttled", CONFIG.hashSalt);
    await admin`
      INSERT INTO awcms_mini_visitor_sessions
        (tenant_id, visitor_key_hash, area, current_path, is_authenticated,
         first_seen_at, last_seen_at)
      VALUES (${TENANT_A}, ${keyHash}, 'public', '/stale', false,
              ${staleSeenAt}, ${staleSeenAt})
    `;

    enqueueVisitEvent(
      sql,
      TENANT_A,
      makeRecord({ visitorKey: "throttled", path: "/fresh" })
    );
    await flushVisitEventBatches(5_000);

    // Still the same session (reused, not replaced)...
    expect(await countSessions(TENANT_A)).toBe(1);

    const rows = (await admin`
      SELECT current_path, last_seen_at, browser_name, device_type
      FROM awcms_mini_visitor_sessions WHERE tenant_id = ${TENANT_A}
    `) as {
      current_path: string;
      last_seen_at: string;
      browser_name: string | null;
      device_type: string | null;
    }[];

    // ...and it was actually refreshed. Without this, the bulk UPDATE could
    // be broken outright and every test would still pass.
    expect(rows[0]!.current_path).toBe("/fresh");
    expect(new Date(rows[0]!.last_seen_at).getTime()).toBeGreaterThan(
      staleSeenAt.getTime()
    );
    // Columns carried by the unnest'd UPDATE, not just last_seen_at.
    expect(rows[0]!.browser_name).toBe("Chrome");
    expect(rows[0]!.device_type).toBe("desktop");
  });

  test("many events from ONE visitor resolve to a single shared session", async () => {
    const sql = getTestSql();

    for (let index = 0; index < 12; index += 1) {
      enqueueVisitEvent(
        sql,
        TENANT_A,
        makeRecord({ visitorKey: "same-visitor", path: `/page-${index}` })
      );
    }

    await flushVisitEventBatches(5_000);

    expect(await countEvents(TENANT_A)).toBe(12);
    // The batched session resolution collapses the per-event SELECT +
    // INSERT/UPDATE into one lookup per (visitor_key_hash, area).
    expect(await countSessions(TENANT_A)).toBe(1);

    const admin = getAdminSql();
    const events = (await admin`
      SELECT DISTINCT visitor_session_id FROM awcms_mini_visit_events
      WHERE tenant_id = ${TENANT_A}
    `) as { visitor_session_id: string | null }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.visitor_session_id).not.toBeNull();
  });

  describe("shutdown must not lose the tail", () => {
    test("flush writes a PARTIAL batch — it does not wait for MAX_BATCH_SIZE", async () => {
      const sql = getTestSql();
      // Deliberately far below MAX_BATCH_SIZE, so nothing auto-flushes...
      const partial = 3;
      expect(partial).toBeLessThan(MAX_BATCH_SIZE);

      for (let index = 0; index < partial; index += 1) {
        enqueueVisitEvent(
          sql,
          TENANT_A,
          makeRecord({ visitorKey: `p-${index}` })
        );
      }

      // ...and nothing has been written yet: these records exist only in memory.
      expect(getVisitEventBatcherStats().pending).toBe(partial);
      expect(await countEvents(TENANT_A)).toBe(0);

      await flushVisitEventBatches(5_000);

      // A batcher that could only flush FULL batches would silently lose the
      // tail of every deploy. All three must land.
      expect(await countEvents(TENANT_A)).toBe(partial);
      expect(getVisitEventBatcherStats()).toEqual({
        pending: 0,
        buckets: 0,
        inFlight: 0
      });
    });

    test("flush does not wait out the linger timer", async () => {
      const sql = getTestSql();
      enqueueVisitEvent(sql, TENANT_A, makeRecord({ visitorKey: "linger" }));

      const startedAt = performance.now();
      await flushVisitEventBatches(5_000);
      const elapsed = performance.now() - startedAt;

      expect(await countEvents(TENANT_A)).toBe(1);
      // Shutdown must not pay the linger. Generous bound (the real write is
      // in here too) but far below a flush that slept out BATCH_LINGER_MS.
      expect(elapsed).toBeLessThan(BATCH_LINGER_MS + 400);
    });

    test("flushVisitorTelemetryQueue drains BOTH stages end to end", async () => {
      const sql = getTestSql();

      // Exactly what src/middleware.ts does: a stage-1 task whose whole job
      // is to buffer a record into stage 2. Flushing stage 2 before stage 1
      // is idle would leave this behind.
      enqueueVisitorTelemetry(async () => {
        await Bun.sleep(20);
        enqueueVisitEvent(
          sql,
          TENANT_A,
          makeRecord({ visitorKey: "two-stage" })
        );
      });

      await flushVisitorTelemetryQueue(5_000);

      expect(await countEvents(TENANT_A)).toBe(1);
    });
  });

  describe("batching must not corrupt the data it defers", () => {
    test("occurred_at is the request's time, not the flush's", async () => {
      const sql = getTestSql();
      const past = new Date(Date.now() - 60_000);

      enqueueVisitEvent(
        sql,
        TENANT_A,
        makeRecord({ visitorKey: "timed", occurredAt: past })
      );
      await flushVisitEventBatches(5_000);

      const admin = getAdminSql();
      const rows = (await admin`
        SELECT occurred_at FROM awcms_mini_visit_events WHERE tenant_id = ${TENANT_A}
      `) as { occurred_at: string }[];

      // Letting the column's now() default win would smear every event onto
      // its flush instant — silently corrupting the analytics this module
      // exists to produce.
      expect(new Date(rows[0]!.occurred_at).getTime()).toBe(past.getTime());
    });

    test("jsonb columns read back as objects, not strings (Issue #623 trap, live in the batched shape)", async () => {
      const sql = getTestSql();

      enqueueVisitEvent(
        sql,
        TENANT_A,
        makeRecord({
          visitorKey: "jsonb",
          geo: {
            countryCode: "ID",
            region: "Jakarta",
            city: "Jakarta",
            timezone: "Asia/Jakarta"
          }
        })
      );
      await flushVisitEventBatches(5_000);

      const admin = getAdminSql();
      const rows = (await admin`
        SELECT user_agent_parsed, geo FROM awcms_mini_visit_events
        WHERE tenant_id = ${TENANT_A}
      `) as { user_agent_parsed: unknown; geo: unknown }[];

      // The natural bulk form — unnest + tx.array(rows.map(JSON.stringify),
      // "jsonb") — stores identical BYTES but reads back as a string,
      // reintroducing Issue #623. Measured, which is why the batch insert
      // uses the tx(rows) row helper instead.
      expect(typeof rows[0]!.geo).toBe("object");
      expect(typeof rows[0]!.user_agent_parsed).toBe("object");
      expect(rows[0]!.geo).toMatchObject({
        countryCode: "ID",
        city: "Jakarta"
      });
      expect(rows[0]!.user_agent_parsed).toMatchObject({
        browserName: "Chrome",
        deviceType: "desktop"
      });
    });

    test("a full batch preserves every event's own path and correlation id", async () => {
      const sql = getTestSql();

      for (let index = 0; index < 8; index += 1) {
        enqueueVisitEvent(
          sql,
          TENANT_A,
          makeRecord({ visitorKey: `mix-${index}`, path: `/p-${index}` })
        );
      }
      await flushVisitEventBatches(5_000);

      const admin = getAdminSql();
      const rows = (await admin`
        SELECT path_sanitized, correlation_id FROM awcms_mini_visit_events
        WHERE tenant_id = ${TENANT_A} ORDER BY path_sanitized
      `) as { path_sanitized: string; correlation_id: string }[];

      // Guards against a bulk insert that broadcasts one row's values across
      // the batch — a mistake a "20 rows exist" assertion would not catch.
      expect(rows.map((r) => r.path_sanitized)).toEqual([
        "/p-0",
        "/p-1",
        "/p-2",
        "/p-3",
        "/p-4",
        "/p-5",
        "/p-6",
        "/p-7"
      ]);
      expect(rows.map((r) => r.correlation_id)).toEqual([
        "corr-mix-0",
        "corr-mix-1",
        "corr-mix-2",
        "corr-mix-3",
        "corr-mix-4",
        "corr-mix-5",
        "corr-mix-6",
        "corr-mix-7"
      ]);
    });
  });

  test("a bucket reaching MAX_BATCH_SIZE flushes without waiting for the linger", async () => {
    const sql = getTestSql();

    for (let index = 0; index < MAX_BATCH_SIZE; index += 1) {
      enqueueVisitEvent(
        sql,
        TENANT_A,
        makeRecord({ visitorKey: `f-${index}` })
      );
    }

    // The size trigger fired synchronously at the MAX_BATCH_SIZE-th enqueue:
    // nothing is left buffered, without any flush call or timer.
    expect(getVisitEventBatcherStats().pending).toBe(0);

    await flushVisitEventBatches(5_000);
    expect(await countEvents(TENANT_A)).toBe(MAX_BATCH_SIZE);
    expect(await distinctInsertingTransactions(TENANT_A)).toBe(1);
  });
});
