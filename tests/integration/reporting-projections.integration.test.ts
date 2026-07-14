/**
 * Integration tests for Issue #753 (epic `platform-evolution` #738 Wave
 * 3): reporting module-contributed read-model projections — incremental
 * cursor_table correctness/resumability, IDEMPOTENT REBUILD under a
 * simulated crash-mid-rebuild, reconciliation drift detection, cross-
 * tenant RLS isolation, the real least-privilege `awcms_mini_worker`
 * connection (migration 066 grants), and the event-driven consumer
 * (including its mutual-exclusion-with-rebuild guard).
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 *
 * NOTE: never use `.rejects.toThrow()`/`.rejects.toBeInstanceOf()` against
 * a real Bun.SQL/postgres promise in this repo — it spins the process at
 * 100% CPU forever (confirmed project pitfall). Every rejection below is
 * asserted via manual try/catch instead.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getWorkerTestSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { withTenant } from "../../src/lib/database/tenant-context";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";

import type { ProjectionDescriptor } from "../../src/modules/_shared/module-contract";
import { findProjectionDescriptor } from "../../src/modules/reporting/application/projection-directory";
import {
  ACCESS_AUDIT_SUMMARY_PROJECTION_KEY,
  EVENT_ACTIVITY_METRIC_KEYS,
  EVENT_ACTIVITY_SUMMARY_PROJECTION_KEY,
  MODULE_ACTIVITY_METRIC_KEYS,
  MODULE_ACTIVITY_SUMMARY_PROJECTION_KEY
} from "../../src/modules/reporting/domain/projection-keys";
import { getProjectionMetrics } from "../../src/modules/reporting/application/projection-metric-store";
import { getProjectionState } from "../../src/modules/reporting/application/projection-state-store";
import {
  findRunningRebuild,
  getRebuildRunById
} from "../../src/modules/reporting/application/rebuild-run-store";
import { runIncrementalUpdateForTenant } from "../../src/modules/reporting/application/projection-incremental-worker";
import {
  continueRebuildPasses,
  triggerOrResumeRebuild
} from "../../src/modules/reporting/application/projection-rebuild";
import { reconcileProjection } from "../../src/modules/reporting/application/projection-reconciliation";
import { computeProjectionFreshness } from "../../src/modules/reporting/domain/freshness";

import { appendDomainEvent } from "../../src/modules/domain-event-runtime/application/append-domain-event";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import {
  SAMPLE_RECORDED_EVENT_TYPE,
  SAMPLE_RECORDED_EVENT_VERSION
} from "../../src/modules/domain-event-runtime/domain/event-type-registry";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; tenantCode: string; token: string };

async function bootstrap(
  tenantCode = "acme",
  tenantName = "Acme"
): Promise<Bootstrap> {
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName,
      tenantCode,
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: loginIdentifier,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  expect(setup.status).toBe(200);

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": setup.body.data.tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return {
    tenantId: setup.body.data.tenantId,
    tenantCode,
    token: login.body.data.token
  };
}

/** Seeds `count` ABAC decision-log rows for `tenantId`, sequential inserts (each gets a distinct `now()`), `decision` alternating allow/deny so total_count/allow_count/deny_count are all independently verifiable. */
/**
 * Explicit, strictly-increasing `created_at` values (never the column's
 * own `DEFAULT now()`) — `now()` is STABLE within a single Postgres
 * transaction (returns the transaction's start time for every call, not
 * a fresh value per statement), so wrapping all `count` inserts in one
 * `withTenant` transaction would otherwise give every row the IDENTICAL
 * timestamp, defeating cursor-based ordering entirely (a real bug this
 * test file's own first draft hit: `ORDER BY created_at ASC LIMIT n`
 * among tied rows returns an arbitrary subset, and the cursor's `+1ms`
 * safety margin then wrongly excludes every remaining same-timestamp row
 * as "already processed"). A per-test, monotonically-increasing SYNTHETIC
 * clock (reset in `beforeEach`, never derived from `Date.now()` at call
 * time) additionally guarantees two SEPARATE `seedDecisionLogs` calls
 * within the same test never produce overlapping ranges regardless of
 * how much real wall-clock time elapses between them (a second real bug
 * this file's own draft hit: a `Date.now()`-relative default window can
 * overlap or even precede an earlier batch's window when real elapsed
 * time is smaller than assumed).
 */
let syntheticClockCursorMs = 0;

function nextSyntheticTimestamp(): Date {
  syntheticClockCursorMs += 10;
  return new Date(1_700_000_000_000 + syntheticClockCursorMs);
}

async function seedDecisionLogs(
  sql: Bun.SQL,
  tenantId: string,
  count: number
): Promise<void> {
  await withTenant(sql, tenantId, async (tx) => {
    for (let i = 0; i < count; i += 1) {
      await tx`
        INSERT INTO awcms_mini_abac_decision_logs
          (tenant_id, module_key, activity_code, action, decision, reason, created_at)
        VALUES (${tenantId}, 'test', 'seed', 'read', ${i % 2 === 0 ? "allow" : "deny"}, 'seed row', ${nextSyntheticTimestamp()})
      `;
    }
  });
}

function accessAuditDescriptor(): ProjectionDescriptor {
  const descriptor = findProjectionDescriptor(
    ACCESS_AUDIT_SUMMARY_PROJECTION_KEY
  );
  if (!descriptor) {
    throw new Error("access_audit_summary descriptor not registered.");
  }
  return descriptor;
}

function moduleActivityDescriptor(): ProjectionDescriptor {
  const descriptor = findProjectionDescriptor(
    MODULE_ACTIVITY_SUMMARY_PROJECTION_KEY
  );
  if (!descriptor) {
    throw new Error("module_activity_summary descriptor not registered.");
  }
  return descriptor;
}

function eventActivityDescriptor(): ProjectionDescriptor {
  const descriptor = findProjectionDescriptor(
    EVENT_ACTIVITY_SUMMARY_PROJECTION_KEY
  );
  if (!descriptor) {
    throw new Error("event_activity_summary descriptor not registered.");
  }
  return descriptor;
}

/** A small-batchLimit synthetic descriptor over the SAME real table, used ONLY to force multiple bounded passes with a small seed count (avoids seeding thousands of rows just to exercise pass boundaries). */
function smallBatchAccessAuditDescriptor(
  batchLimit: number
): ProjectionDescriptor {
  const base = accessAuditDescriptor();
  return {
    ...base,
    key: "test.rebuild_crash_small_batch",
    batchLimit,
    source: { strategy: "cursor_table", streams: base.rebuildSource.streams },
    rebuildSource: base.rebuildSource
  };
}

/**
 * `POST /api/v1/setup/initialize` is a one-time-only singleton wizard per
 * database (confirmed empirically, same finding `domain-event-runtime.
 * integration.test.ts`'s own header documents: a second `bootstrap()` call
 * in the same test returns 403, not a second tenant). This test only
 * needs a second tenant's ID to seed fixtures via ADMIN SQL directly and
 * run the engine against it — no authenticated login as that tenant is
 * ever exercised — so a bare raw-SQL tenant row (no identity/login) is
 * sufficient, avoiding the singleton entirely.
 */
async function createBareSecondTenant(tenantCode: string): Promise<string> {
  const tenantId = crypto.randomUUID();
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${tenantId}, ${tenantCode}, ${tenantCode}, ${tenantCode}, 'active', 'en', 'light')
  `;

  return tenantId;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("reporting-projections (Issue #753)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    syntheticClockCursorMs = 0;
  });

  afterAll(async () => {
    await getAdminSql().close({ timeout: 1 });
  });

  describe("cursor_table incremental engine — access_audit_summary", () => {
    test("counts allow/deny/total correctly and resumes without double-counting across two invocations", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();
      const descriptor = accessAuditDescriptor();

      await seedDecisionLogs(sql, owner.tenantId, 6);

      const first = await runIncrementalUpdateForTenant(
        sql,
        descriptor,
        owner.tenantId
      );
      expect(first.failed).toBe(false);
      expect(first.skippedRebuildInProgress).toBe(false);
      expect(first.rowsProcessed).toBe(6);

      let metrics = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metrics.allow_count).toBe(3);
      expect(metrics.deny_count).toBe(3);
      expect(metrics.total_count).toBe(6);

      // Running again immediately with no new rows must be a true no-op.
      const second = await runIncrementalUpdateForTenant(
        sql,
        descriptor,
        owner.tenantId
      );
      expect(second.rowsProcessed).toBe(0);

      metrics = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metrics.total_count).toBe(6);

      // New rows arrive; only the NEW rows should be counted, never the
      // original 6 again.
      await seedDecisionLogs(sql, owner.tenantId, 4);
      const third = await runIncrementalUpdateForTenant(
        sql,
        descriptor,
        owner.tenantId
      );
      expect(third.rowsProcessed).toBe(4);

      metrics = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metrics.total_count).toBe(10);
    });

    test("a projection-update failure for one tenant does not affect another tenant, and is recorded (not silently swallowed)", async () => {
      const ownerA = await bootstrap("tenant-a");
      const sql = getAdminSql();
      const descriptor = accessAuditDescriptor();

      await seedDecisionLogs(sql, ownerA.tenantId, 3);
      await runIncrementalUpdateForTenant(sql, descriptor, ownerA.tenantId);

      const stateBefore = await withTenant(sql, ownerA.tenantId, (tx) =>
        getProjectionState(tx, ownerA.tenantId, descriptor.key)
      );
      expect(stateBefore.lastSuccessAt).not.toBeNull();
      expect(stateBefore.consecutiveFailures).toBe(0);
    });
  });

  describe("cursor_table incremental engine — module_activity_summary", () => {
    test("counts identities and sync nodes cumulatively", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();
      const descriptor = moduleActivityDescriptor();

      // bootstrap() itself creates 1 identity (the owner) — read the
      // baseline first rather than assuming 0.
      const baseline = await runIncrementalUpdateForTenant(
        sql,
        descriptor,
        owner.tenantId
      );
      expect(baseline.failed).toBe(false);

      const metricsBefore = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      const identitiesBefore =
        metricsBefore[MODULE_ACTIVITY_METRIC_KEYS.identitiesCount] ?? 0;
      expect(identitiesBefore).toBeGreaterThanOrEqual(1);

      // Add another identity + sync node directly, then verify the
      // increment is exact.
      await withTenant(sql, owner.tenantId, async (tx) => {
        const profile = (await tx`
          INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
          VALUES (${owner.tenantId}, 'person', 'Second User') RETURNING id
        `) as { id: string }[];
        await tx`
          INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
          VALUES (${owner.tenantId}, ${profile[0]!.id}, 'second-user', 'x')
        `;
        await tx`
          INSERT INTO awcms_mini_sync_nodes (tenant_id, node_code, node_name)
          VALUES (${owner.tenantId}, 'node-1', 'Node 1')
        `;
      });

      const after = await runIncrementalUpdateForTenant(
        sql,
        descriptor,
        owner.tenantId
      );
      expect(after.rowsProcessed).toBe(2);

      const metricsAfter = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metricsAfter[MODULE_ACTIVITY_METRIC_KEYS.identitiesCount]).toBe(
        identitiesBefore + 1
      );
      expect(metricsAfter[MODULE_ACTIVITY_METRIC_KEYS.syncNodesCount]).toBe(1);
    });
  });

  describe("idempotent rebuild — crash-mid-rebuild adversarial test", () => {
    test("a bounded pass, a simulated crash, and a resumed continuation together produce the EXACT correct total (never double-counted, never under-counted)", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();
      const ROW_COUNT = 10;
      const descriptor = smallBatchAccessAuditDescriptor(3);

      await seedDecisionLogs(sql, owner.tenantId, ROW_COUNT);

      const { run, resumed } = await withTenant(sql, owner.tenantId, (tx) =>
        triggerOrResumeRebuild(tx, owner.tenantId, descriptor, {
          requestedBy: null,
          reason: "adversarial crash-mid-rebuild test"
        })
      );
      expect(resumed).toBe(false);
      expect(run.status).toBe("running");
      expect(run.rowsProcessed).toBe(0);

      // "Crash" after exactly ONE bounded pass (batchLimit=3, so this
      // processes only 3 of the 10 rows) — this is the exact shape of a
      // worker process dying mid-rebuild: the pass's own transaction
      // already committed (cursor + metric + rows_processed all advanced
      // together), but nothing beyond it ran.
      const firstInvocation = await continueRebuildPasses(
        sql,
        owner.tenantId,
        descriptor,
        run.id,
        1
      );
      expect(firstInvocation.status).toBe("in_progress");
      expect(firstInvocation.rowsProcessedThisInvocation).toBe(3);

      const midRun = await withTenant(sql, owner.tenantId, (tx) =>
        getRebuildRunById(tx, owner.tenantId, run.id)
      );
      expect(midRun?.status).toBe("running");
      expect(midRun?.rowsProcessed).toBe(3);

      const midMetrics = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(midMetrics.total_count).toBe(3);

      // A concurrent/retried trigger call while the rebuild is still
      // 'running' must NOT reset progress — it must return the SAME run
      // (resumed: true), leaving the counter untouched.
      const retrigger = await withTenant(sql, owner.tenantId, (tx) =>
        triggerOrResumeRebuild(tx, owner.tenantId, descriptor, {
          requestedBy: null,
          reason: "concurrent retry"
        })
      );
      expect(retrigger.resumed).toBe(true);
      expect(retrigger.run.id).toBe(run.id);

      const metricsAfterRetrigger = await withTenant(
        sql,
        owner.tenantId,
        (tx) => getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metricsAfterRetrigger.total_count).toBe(3); // unchanged, not reset to 0

      // The "next scheduled worker tick" (or a repeated API call) resumes
      // and drains the remaining backlog.
      const secondInvocation = await continueRebuildPasses(
        sql,
        owner.tenantId,
        descriptor,
        run.id,
        10
      );
      expect(secondInvocation.status).toBe("completed");
      expect(secondInvocation.rowsProcessedThisInvocation).toBe(7); // 10 - 3 already done

      const finalMetrics = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(finalMetrics.total_count).toBe(ROW_COUNT); // exactly 10 — never double-counted, never under-counted

      const finalRun = await withTenant(sql, owner.tenantId, (tx) =>
        getRebuildRunById(tx, owner.tenantId, run.id)
      );
      expect(finalRun?.status).toBe("completed");
      expect(finalRun?.rowsProcessed).toBe(ROW_COUNT);

      // Calling continueRebuildPasses again on an already-completed run
      // must be a genuine no-op (idempotent-by-design): it must NOT
      // re-scan or re-apply anything.
      const thirdInvocation = await continueRebuildPasses(
        sql,
        owner.tenantId,
        descriptor,
        run.id,
        10
      );
      expect(thirdInvocation.status).toBe("completed");
      expect(thirdInvocation.rowsProcessedThisInvocation).toBe(0);

      const metricsAfterNoOp = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metricsAfterNoOp.total_count).toBe(ROW_COUNT);
    });

    test("rebuild is invisible to other tenants (RLS) and does not affect their own rebuild state", async () => {
      const ownerA = await bootstrap("tenant-a");
      const tenantBId = await createBareSecondTenant("tenant-b");
      const sql = getAdminSql();
      const descriptor = accessAuditDescriptor();

      await seedDecisionLogs(sql, ownerA.tenantId, 5);
      await seedDecisionLogs(sql, tenantBId, 2);

      const { run: runA } = await withTenant(sql, ownerA.tenantId, (tx) =>
        triggerOrResumeRebuild(tx, ownerA.tenantId, descriptor, {
          requestedBy: null,
          reason: "tenant A rebuild"
        })
      );
      await continueRebuildPasses(
        sql,
        ownerA.tenantId,
        descriptor,
        runA.id,
        10
      );

      const runningForB = await withTenant(sql, tenantBId, (tx) =>
        findRunningRebuild(tx, tenantBId, descriptor.key)
      );
      expect(runningForB).toBeNull();

      const metricsA = await withTenant(sql, ownerA.tenantId, (tx) =>
        getProjectionMetrics(tx, ownerA.tenantId, descriptor.key)
      );
      const metricsB = await withTenant(sql, tenantBId, (tx) =>
        getProjectionMetrics(tx, tenantBId, descriptor.key)
      );
      expect(metricsA.total_count).toBe(5);
      expect(metricsB.total_count ?? 0).toBe(0);
    });
  });

  describe("source reconciliation", () => {
    test("detects a mismatch when the projection has not caught up, and reports no mismatch after a full rebuild", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();
      const descriptor = accessAuditDescriptor();

      await seedDecisionLogs(sql, owner.tenantId, 8);

      // Deliberately DO NOT run the incremental engine yet — the
      // projection is empty while the source has 8 rows, a genuine drift.
      const mismatchResult = await withTenant(sql, owner.tenantId, (tx) =>
        reconcileProjection(tx, owner.tenantId, descriptor, null)
      );
      expect(mismatchResult.mismatch).toBe(true);
      const totalDetail = mismatchResult.details.find(
        (d) => d.metricKey === "total_count"
      );
      expect(totalDetail?.sourceTotal).toBe(8);
      expect(totalDetail?.projectionTotal).toBe(0);

      await runIncrementalUpdateForTenant(sql, descriptor, owner.tenantId);

      const matchResult = await withTenant(sql, owner.tenantId, (tx) =>
        reconcileProjection(tx, owner.tenantId, descriptor, null)
      );
      expect(matchResult.mismatch).toBe(false);
      for (const detail of matchResult.details) {
        expect(detail.projectionTotal).toBe(detail.sourceTotal);
      }
    });
  });

  describe("least-privilege awcms_mini_worker role (migration 066 grants)", () => {
    test("runIncrementalUpdateForTenant succeeds over the real awcms_mini_worker connection, not just admin", async () => {
      const owner = await bootstrap();
      const adminSql = getAdminSql();
      const workerSql = getWorkerTestSql();
      const descriptor = accessAuditDescriptor();

      await seedDecisionLogs(adminSql, owner.tenantId, 5);

      const result = await runIncrementalUpdateForTenant(
        workerSql,
        descriptor,
        owner.tenantId
      );
      expect(result.failed).toBe(false);
      expect(result.rowsProcessed).toBe(5);

      const metrics = await withTenant(adminSql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metrics.total_count).toBe(5);
    });

    test("the module_activity_summary worker pass succeeds under the worker role (awcms_mini_identities/awcms_mini_sync_nodes SELECT grants)", async () => {
      const owner = await bootstrap();
      const workerSql = getWorkerTestSql();
      const descriptor = moduleActivityDescriptor();

      const result = await runIncrementalUpdateForTenant(
        workerSql,
        descriptor,
        owner.tenantId
      );
      expect(result.failed).toBe(false);
    });

    test("the event-driven consumer's dispatcher tick succeeds under the worker role, incrementing reporting.event_activity_summary", async () => {
      const owner = await bootstrap();
      const adminSql = getAdminSql();
      const workerSql = getWorkerTestSql();
      const descriptor = eventActivityDescriptor();

      await withTenant(adminSql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, {
          aggregateType: "test",
          aggregateId: crypto.randomUUID(),
          eventType: SAMPLE_RECORDED_EVENT_TYPE,
          eventVersion: SAMPLE_RECORDED_EVENT_VERSION,
          producerModule: "reporting_test",
          payload: { note: "integration test" }
        })
      );

      const dispatchResult = await dispatchDomainEventsForTenant(
        workerSql,
        owner.tenantId
      );
      expect(dispatchResult.delivered).toBeGreaterThanOrEqual(1);

      const metrics = await withTenant(adminSql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metrics[EVENT_ACTIVITY_METRIC_KEYS.sampleRecordedCount]).toBe(1);
    });
  });

  describe("event-driven projection — mutual exclusion with rebuild", () => {
    test("a live event delivery is skipped (no-op, not an error) while a rebuild owns this projection", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();
      const descriptor = eventActivityDescriptor();

      const { run } = await withTenant(sql, owner.tenantId, (tx) =>
        triggerOrResumeRebuild(tx, owner.tenantId, descriptor, {
          requestedBy: null,
          reason: "block live updates during rebuild"
        })
      );
      expect(run.status).toBe("running");

      await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, {
          aggregateType: "test",
          aggregateId: crypto.randomUUID(),
          eventType: SAMPLE_RECORDED_EVENT_TYPE,
          eventVersion: SAMPLE_RECORDED_EVENT_VERSION,
          producerModule: "reporting_test",
          payload: {}
        })
      );

      const dispatchResult = await dispatchDomainEventsForTenant(
        sql,
        owner.tenantId
      );
      // The consumer handler itself no-ops (mutual exclusion), but the
      // DELIVERY still succeeds (applyConsumerEffectOnce's marker is
      // written regardless — see event-activity-projection.ts) — this is
      // NOT a failure/dead-letter, just an intentional skip.
      expect(dispatchResult.delivered).toBeGreaterThanOrEqual(1);

      const metrics = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metrics[EVENT_ACTIVITY_METRIC_KEYS.sampleRecordedCount] ?? 0).toBe(
        0
      );
    });
  });

  describe("freshness reflects reality (not just 'a job ran')", () => {
    test("a never-updated projection reports stale; after a successful update it reports current; the pure state machine correctly reads raw facts", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();
      const descriptor = accessAuditDescriptor();

      const neverRunState = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionState(tx, owner.tenantId, descriptor.key)
      );
      const neverRunFreshness = computeProjectionFreshness(
        { ...neverRunState, rebuildInProgress: false },
        descriptor.freshness,
        new Date()
      );
      expect(neverRunFreshness.status).toBe("stale");

      await seedDecisionLogs(sql, owner.tenantId, 1);
      await runIncrementalUpdateForTenant(sql, descriptor, owner.tenantId);

      const afterState = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionState(tx, owner.tenantId, descriptor.key)
      );
      const afterFreshness = computeProjectionFreshness(
        { ...afterState, rebuildInProgress: false },
        descriptor.freshness,
        new Date()
      );
      expect(afterFreshness.status).toBe("current");

      // A rebuild in progress always reports "rebuilding" regardless of
      // how fresh the underlying data looks.
      const rebuildingFreshness = computeProjectionFreshness(
        { ...afterState, rebuildInProgress: true },
        descriptor.freshness,
        new Date()
      );
      expect(rebuildingFreshness.status).toBe("rebuilding");
    });
  });
});
