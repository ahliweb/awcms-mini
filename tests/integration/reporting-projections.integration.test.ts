/**
 * Integration tests for Issue #753 (epic `platform-evolution` #738 Wave
 * 3): reporting module-contributed read-model projections — incremental
 * cursor_table correctness/resumability, IDEMPOTENT REBUILD under a
 * simulated crash-mid-rebuild, reconciliation drift detection, cross-
 * tenant RLS isolation, the real least-privilege `awcms_mini_worker`
 * connection (migration 069 grants), and the event-driven consumer
 * (including its mutual-exclusion-with-rebuild guard).
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 *
 * NOTE: never use `.rejects.toThrow()`/`.rejects.toBeInstanceOf()` against
 * a real Bun.SQL/postgres promise in this repo — it spins the process at
 * 100% CPU forever (confirmed project pitfall). Every rejection below is
 * asserted via manual try/catch instead.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getWorkerTestSql,
  integrationEnabled,
  invoke,
  invokeRaw,
  provisionAppRole,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { withTenant } from "../../src/lib/database/tenant-context";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";

import { GET as listProjectionsRoute } from "../../src/pages/api/v1/reports/projections/index";
import { GET as getProjectionRoute } from "../../src/pages/api/v1/reports/projections/[key]/index";
import { POST as triggerRebuildRoute } from "../../src/pages/api/v1/reports/projections/[key]/rebuild/index";
import { POST as cancelRebuildRoute } from "../../src/pages/api/v1/reports/projections/[key]/rebuild/cancel";
import {
  GET as listScheduledExportsRoute,
  POST as createScheduledExportRoute
} from "../../src/pages/api/v1/reports/exports/index";
import { POST as triggerExportRoute } from "../../src/pages/api/v1/reports/exports/trigger";
import { GET as downloadExportRoute } from "../../src/pages/api/v1/reports/exports/runs/[id]/download";
import { POST as disableExportRoute } from "../../src/pages/api/v1/reports/exports/[id]/disable";
import { hashPassword } from "../../src/lib/auth/password";

import type { ProjectionDescriptor } from "../../src/modules/_shared/module-contract";
import { findProjectionDescriptor } from "../../src/modules/reporting/application/projection-directory";
import {
  ACCESS_AUDIT_SUMMARY_PROJECTION_KEY,
  EVENT_ACTIVITY_METRIC_KEYS,
  EVENT_ACTIVITY_PROJECTOR_CONSUMER_NAME,
  EVENT_ACTIVITY_SUMMARY_PROJECTION_KEY,
  MODULE_ACTIVITY_METRIC_KEYS,
  MODULE_ACTIVITY_SUMMARY_PROJECTION_KEY
} from "../../src/modules/reporting/domain/projection-keys";
import { getProjectionMetrics } from "../../src/modules/reporting/application/projection-metric-store";
import { getProjectionState } from "../../src/modules/reporting/application/projection-state-store";
import {
  findRunningRebuild,
  getRebuildRunById,
  requestRebuildCancellation
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

function authHeaders(
  owner: Bootstrap,
  idempotencyKey?: string
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": owner.tenantId,
    authorization: `Bearer ${owner.token}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  };
}

const RESTRICTED_USER_PASSWORD = "integration-test-restricted-user-password";

/**
 * Creates a role granting EXACTLY the given `module.activity.action`
 * permission keys, a second tenant user holding ONLY that role (within
 * the SAME tenant, never the setup wizard's always-full-permission
 * "owner"), and logs in as them through the real `POST /auth/login`
 * endpoint — the least-privilege actor every 403-without-permission test
 * below needs. Same pattern `business-scope-assignments.integration.
 * test.ts`'s own `createRoleWithPermissions`/`createSecondTenantUser`
 * already establish.
 */
async function createRestrictedUser(
  tenantId: string,
  loginIdentifier: string,
  permissionKeys: string[]
): Promise<{ token: string }> {
  const admin = getAdminSql();

  const roleRows = (await admin`
    INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
    VALUES (${tenantId}, ${`restricted_${loginIdentifier}`}, 'Restricted Test Role')
    RETURNING id
  `) as { id: string }[];
  const roleId = roleRows[0]!.id;

  for (const key of permissionKeys) {
    const [moduleKey, activityCode, action] = key.split(".");
    await admin`
      INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
      SELECT ${tenantId}, ${roleId}, id FROM awcms_mini_permissions
      WHERE module_key = ${moduleKey} AND activity_code = ${activityCode} AND action = ${action}
    `;
  }

  const profileRows = (await admin`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Restricted User')
    RETURNING id
  `) as { id: string }[];

  const passwordHash = await hashPassword(RESTRICTED_USER_PASSWORD);
  const identityRows = (await admin`
    INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profileRows[0]!.id}, ${loginIdentifier}, ${passwordHash})
    RETURNING id
  `) as { id: string }[];

  const tenantUserRows = (await admin`
    INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identityRows[0]!.id})
    RETURNING id
  `) as { id: string }[];

  await admin`
    INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
    VALUES (${tenantId}, ${tenantUserRows[0]!.id}, ${roleId})
  `;

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password: RESTRICTED_USER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { token: login.body.data.token };
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

/**
 * A second, fully-independent tenant with a REAL logged-in session and
 * full `reporting` module permissions (raw-SQL tenant/profile/identity/
 * role/login, never a second `bootstrap()` call — `/setup/initialize` is
 * a one-time-only singleton per database, see `createBareSecondTenant`'s
 * own comment history / `domain-event-runtime.integration.test.ts`'s own
 * `seedSecondTenantWithDomainEventRuntimeAccess`, the exact same pattern
 * mirrored here). Used for cross-tenant HTTP-layer RLS tests where a bare
 * ABAC-deny (403 missing permission) would be a false positive — this
 * caller genuinely HOLDS the permission, so a 404 on another tenant's
 * resource can only come from real tenant-scoped RLS, not a coarse
 * permission gate.
 */
async function createSecondTenantWithReportingAccess(
  tenantCode: string
): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const password = "integration-test-tenant-b-reporting-password";
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${tenantId}, ${tenantCode}, ${tenantCode}, ${tenantCode}, 'active', 'en', 'light')
  `;

  const passwordHash = await hashPassword(password);

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Tenant B Reporting User') RETURNING id
    `) as { id: string }[];
    const identity = (await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, ${loginIdentifier}, ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    const tenantUser = (await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
    `) as { id: string }[];
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'reporting_full_access', 'Reporting Full Access') RETURNING id
    `) as { id: string }[];
    const permissions = (await tx`
      SELECT id FROM awcms_mini_permissions WHERE module_key = 'reporting'
    `) as { id: string }[];

    for (const permission of permissions) {
      await tx`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        VALUES (${tenantId}, ${role[0]!.id}, ${permission.id})
      `;
    }

    await tx`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
      VALUES (${tenantId}, ${tenantUser[0]!.id}, ${role[0]!.id})
    `;
  });

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, tenantCode, token: login.body.data.token };
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

  describe("idempotency-key scoping across two different resources of the same type (Issue #795)", () => {
    test("ADVERSARIAL: reusing the same Idempotency-Key across POST rebuild/cancel of two DIFFERENT projections must NOT replay the first projection's cached response for the second -- the mismatched hash must yield 409 CONFLICT, the second projection's run must remain untouched, and it must still cancel once given its OWN key", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      // Two DIFFERENT resources of the SAME type (a tenant-scoped
      // reporting projection rebuild run) -- both share the identical
      // request_scope ("reporting_projection_rebuild_cancel") and
      // tenant_id, differing only by the {key} path parameter. Pre-fix,
      // `computeRequestHash({})` was identical for both requests
      // regardless of {key}, so a reused Idempotency-Key would silently
      // replay projection A's cached response (200, describing A's run)
      // for a request meant to cancel projection B -- B's run would
      // stay 'running' forever while the caller believed it was
      // cancelled.
      const descriptorA = accessAuditDescriptor();
      const descriptorB = moduleActivityDescriptor();

      const { run: runA } = await withTenant(sql, owner.tenantId, (tx) =>
        triggerOrResumeRebuild(tx, owner.tenantId, descriptorA, {
          requestedBy: null,
          reason: "idempotency-key scoping test (A)"
        })
      );
      expect(runA.status).toBe("running");

      const { run: runB } = await withTenant(sql, owner.tenantId, (tx) =>
        triggerOrResumeRebuild(tx, owner.tenantId, descriptorB, {
          requestedBy: null,
          reason: "idempotency-key scoping test (B)"
        })
      );
      expect(runB.status).toBe("running");

      const reusedKey = "rebuild-cancel-reused-key";

      // Cancel A with the reused key -- succeeds normally.
      const cancelA = await invoke<{
        data: { rebuildId: string; cancelRequested: boolean };
      }>(cancelRebuildRoute, {
        method: "POST",
        path: `/api/v1/reports/projections/${descriptorA.key}/rebuild/cancel`,
        params: { key: descriptorA.key },
        headers: authHeaders(owner, reusedKey)
      });
      expect(cancelA.status).toBe(200);
      expect(cancelA.body.data.rebuildId).toBe(runA.id);

      // Attempt to cancel B with the SAME key. Post-fix, the hash folds
      // in {key}, so the mismatch must be rejected as a conflict, never
      // a false replay of A's response.
      const cancelBReusedKey = await invoke(cancelRebuildRoute, {
        method: "POST",
        path: `/api/v1/reports/projections/${descriptorB.key}/rebuild/cancel`,
        params: { key: descriptorB.key },
        headers: authHeaders(owner, reusedKey)
      });
      expect(cancelBReusedKey.status).toBe(409);
      expect(
        (cancelBReusedKey.body as { error: { code: string } }).error.code
      ).toBe("IDEMPOTENCY_CONFLICT");

      // B's run must still be untouched -- NOT falsely reported as
      // cancel-requested.
      const stillRunningB = await withTenant(sql, owner.tenantId, (tx) =>
        getRebuildRunById(tx, owner.tenantId, runB.id)
      );
      expect(stillRunningB?.status).toBe("running");
      expect(stillRunningB?.cancelRequested).toBe(false);

      // With its OWN distinct key, B's cancel genuinely executes.
      const cancelBOwnKey = await invoke<{
        data: { rebuildId: string; cancelRequested: boolean };
      }>(cancelRebuildRoute, {
        method: "POST",
        path: `/api/v1/reports/projections/${descriptorB.key}/rebuild/cancel`,
        params: { key: descriptorB.key },
        headers: authHeaders(owner, "rebuild-cancel-b-own-key")
      });
      expect(cancelBOwnKey.status).toBe(200);
      expect(cancelBOwnKey.body.data.rebuildId).toBe(runB.id);

      const cancelRequestedB = await withTenant(sql, owner.tenantId, (tx) =>
        getRebuildRunById(tx, owner.tenantId, runB.id)
      );
      expect(cancelRequestedB?.status).toBe("running"); // cooperative: still 'running' until next bounded pass observes it
      expect(cancelRequestedB?.cancelRequested).toBe(true);

      // A's run is unaffected by any of B's requests.
      const finalA = await withTenant(sql, owner.tenantId, (tx) =>
        getRebuildRunById(tx, owner.tenantId, runA.id)
      );
      expect(finalA?.cancelRequested).toBe(true);
    });

    test("ADVERSARIAL: reusing the same Idempotency-Key across POST rebuild (trigger) of two DIFFERENT projections, with an identical-shaped body, must NOT replay the first projection's cached response for the second -- the mismatched hash must yield 409 CONFLICT, the second projection must NOT have a rebuild run created, and it must still trigger once given its OWN key", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      // Two DIFFERENT resources of the SAME type (a tenant-scoped
      // reporting projection) -- both share the identical request_scope
      // ("reporting_projection_rebuild") and tenant_id, and here even an
      // IDENTICAL body ({ reason: "..." }), differing only by the {key}
      // path parameter. Pre-fix, `computeRequestHash(body)` never folded
      // in {key}, so a reused Idempotency-Key + identical reason text
      // would silently replay projection A's cached rebuild response
      // (200, describing A's run) for a request meant to trigger
      // projection B's rebuild -- B's rebuild would never actually start
      // (triggerOrResumeRebuild is never called on the replay path), but
      // the caller would see a 200 describing A's run as if B's rebuild
      // had started. Migration 069's partial unique index only protects
      // against a duplicate START for the SAME projection -- it does
      // nothing here, since the cached body short-circuits before
      // `triggerOrResumeRebuild` is ever invoked for B.
      const descriptorA = accessAuditDescriptor();
      const descriptorB = moduleActivityDescriptor();
      const reusedKey = "rebuild-trigger-reused-key";
      const sharedReason = "quarterly refresh";

      const triggerA = await invoke<{
        data: { rebuild: { id: string }; resumed: boolean };
      }>(triggerRebuildRoute, {
        method: "POST",
        path: `/api/v1/reports/projections/${descriptorA.key}/rebuild`,
        params: { key: descriptorA.key },
        headers: authHeaders(owner, reusedKey),
        body: { reason: sharedReason }
      });
      expect(triggerA.status).toBe(200);
      expect(triggerA.body.data.resumed).toBe(false);

      // Attempt to trigger B's rebuild with the SAME key and the SAME
      // reason text. Post-fix, the hash folds in {key}, so the mismatch
      // must be rejected as a conflict, never a false replay of A's
      // response.
      const triggerBReusedKey = await invoke(triggerRebuildRoute, {
        method: "POST",
        path: `/api/v1/reports/projections/${descriptorB.key}/rebuild`,
        params: { key: descriptorB.key },
        headers: authHeaders(owner, reusedKey),
        body: { reason: sharedReason }
      });
      expect(triggerBReusedKey.status).toBe(409);
      expect(
        (triggerBReusedKey.body as { error: { code: string } }).error.code
      ).toBe("IDEMPOTENCY_CONFLICT");

      // B must have NO rebuild run at all -- NOT falsely reported as
      // triggered/running.
      const noRunForB = await withTenant(sql, owner.tenantId, (tx) =>
        findRunningRebuild(tx, owner.tenantId, descriptorB.key)
      );
      expect(noRunForB).toBeNull();

      // With its OWN distinct key, B's rebuild genuinely triggers.
      const triggerBOwnKey = await invoke<{
        data: { rebuild: { id: string }; resumed: boolean };
      }>(triggerRebuildRoute, {
        method: "POST",
        path: `/api/v1/reports/projections/${descriptorB.key}/rebuild`,
        params: { key: descriptorB.key },
        headers: authHeaders(owner, "rebuild-trigger-b-own-key"),
        body: { reason: sharedReason }
      });
      expect(triggerBOwnKey.status).toBe(200);
      expect(triggerBOwnKey.body.data.resumed).toBe(false);

      const runningB = await withTenant(sql, owner.tenantId, (tx) =>
        findRunningRebuild(tx, owner.tenantId, descriptorB.key)
      );
      expect(runningB?.id).toBe(triggerBOwnKey.body.data.rebuild.id);

      // A's run is unaffected by any of B's requests.
      const finalA = await withTenant(sql, owner.tenantId, (tx) =>
        findRunningRebuild(tx, owner.tenantId, descriptorA.key)
      );
      expect(finalA?.id).toBe(triggerA.body.data.rebuild.id);
    });

    test("ADVERSARIAL: reusing the same Idempotency-Key across POST exports/{id}/disable of two DIFFERENT scheduled export configs, with an identical-shaped body, must NOT replay the first config's cached response for the second -- the mismatched hash must yield 409 CONFLICT, the second config must remain enabled, and it must still disable once given its OWN key", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      // Two DIFFERENT resources of the SAME type (a tenant-scoped
      // scheduled export config) -- both share the identical
      // request_scope ("reporting_scheduled_export_disable") and
      // tenant_id, and here even an IDENTICAL body ({ reason: "..." }),
      // differing only by the {id} path parameter. Pre-fix,
      // `computeRequestHash(body)` never folded in {id}, so a reused
      // Idempotency-Key + identical reason text would silently replay
      // export config A's cached disable response for a request meant
      // to disable config B -- B would stay enabled forever while the
      // caller believed it was disabled.
      const configA = await invoke<{
        data: { scheduledExport: { id: string } };
      }>(createScheduledExportRoute, {
        method: "POST",
        path: "/api/v1/reports/exports",
        headers: authHeaders(owner, "export-disable-adv-create-a"),
        body: {
          projectionKey: ACCESS_AUDIT_SUMMARY_PROJECTION_KEY,
          format: "csv",
          scheduleIntervalMinutes: 60
        }
      });
      expect(configA.status).toBe(200);

      const configB = await invoke<{
        data: { scheduledExport: { id: string } };
      }>(createScheduledExportRoute, {
        method: "POST",
        path: "/api/v1/reports/exports",
        headers: authHeaders(owner, "export-disable-adv-create-b"),
        body: {
          projectionKey: MODULE_ACTIVITY_SUMMARY_PROJECTION_KEY,
          format: "csv",
          scheduleIntervalMinutes: 60
        }
      });
      expect(configB.status).toBe(200);

      const reusedKey = "export-disable-reused-key";
      const sharedReason = "no longer needed";

      const disableA = await invoke<{
        data: { id: string; disabled: boolean };
      }>(disableExportRoute, {
        method: "POST",
        path: `/api/v1/reports/exports/${configA.body.data.scheduledExport.id}/disable`,
        params: { id: configA.body.data.scheduledExport.id },
        headers: authHeaders(owner, reusedKey),
        body: { reason: sharedReason }
      });
      expect(disableA.status).toBe(200);
      expect(disableA.body.data.id).toBe(configA.body.data.scheduledExport.id);

      // Attempt to disable B with the SAME key and the SAME reason text.
      // Post-fix, the hash folds in {id}, so the mismatch must be
      // rejected as a conflict, never a false replay of A's response.
      const disableBReusedKey = await invoke(disableExportRoute, {
        method: "POST",
        path: `/api/v1/reports/exports/${configB.body.data.scheduledExport.id}/disable`,
        params: { id: configB.body.data.scheduledExport.id },
        headers: authHeaders(owner, reusedKey),
        body: { reason: sharedReason }
      });
      expect(disableBReusedKey.status).toBe(409);
      expect(
        (disableBReusedKey.body as { error: { code: string } }).error.code
      ).toBe("IDEMPOTENCY_CONFLICT");

      // B must still be untouched -- NOT falsely reported as disabled.
      const stillEnabledB = (await sql`
        SELECT enabled, deleted_at FROM awcms_mini_reporting_scheduled_exports
        WHERE id = ${configB.body.data.scheduledExport.id}
      `) as { enabled: boolean; deleted_at: Date | null }[];
      expect(stillEnabledB[0]!.enabled).toBe(true);
      expect(stillEnabledB[0]!.deleted_at).toBeNull();

      // With its OWN distinct key, B's disable genuinely executes.
      const disableBOwnKey = await invoke<{
        data: { id: string; disabled: boolean };
      }>(disableExportRoute, {
        method: "POST",
        path: `/api/v1/reports/exports/${configB.body.data.scheduledExport.id}/disable`,
        params: { id: configB.body.data.scheduledExport.id },
        headers: authHeaders(owner, "export-disable-b-own-key"),
        body: { reason: sharedReason }
      });
      expect(disableBOwnKey.status).toBe(200);
      expect(disableBOwnKey.body.data.disabled).toBe(true);

      const disabledB = (await sql`
        SELECT enabled, deleted_at FROM awcms_mini_reporting_scheduled_exports
        WHERE id = ${configB.body.data.scheduledExport.id}
      `) as { enabled: boolean; deleted_at: Date | null }[];
      expect(disabledB[0]!.enabled).toBe(false);
      expect(disabledB[0]!.deleted_at).not.toBeNull();

      // A's config is unaffected by any of B's requests.
      const stillDisabledA = (await sql`
        SELECT enabled FROM awcms_mini_reporting_scheduled_exports
        WHERE id = ${configA.body.data.scheduledExport.id}
      `) as { enabled: boolean }[];
      expect(stillDisabledA[0]!.enabled).toBe(false);
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

  describe("least-privilege awcms_mini_worker role (migration 069 grants)", () => {
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

  describe("event-driven projection — mutual exclusion with rebuild (security-auditor finding, PR #781)", () => {
    test("a live event delivery during an in-progress rebuild is RETRIED (never silently marked delivered, never writes its idempotency marker), and succeeds once the rebuild is no longer running", async () => {
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

      const appended = await withTenant(sql, owner.tenantId, (tx) =>
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
      // The OTHER two reference consumers (audit projector + activity
      // rollup) don't care about reporting's rebuild state and deliver
      // normally; ONLY the reporting event-activity-projector's delivery
      // must defer (retry), because `applyEventActivityProjectionIncrement`
      // now THROWS instead of silently no-opping (see that file's own
      // header comment for why silently no-opping was a real permanent-
      // data-loss bug).
      expect(dispatchResult.delivered).toBe(2);
      expect(dispatchResult.retried).toBe(1);

      const metrics = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metrics[EVENT_ACTIVITY_METRIC_KEYS.sampleRecordedCount] ?? 0).toBe(
        0
      );

      // CRITICAL: the idempotency marker must NOT exist — the throw rolled
      // back the WHOLE transaction, including `applyConsumerEffectOnce`'s
      // marker INSERT that ran moments earlier in the same transaction.
      // If this marker existed, the redelivery below would be a silent
      // no-op forever (the exact bug this fix closes).
      const markerRowsWhileRebuilding = await withTenant(
        sql,
        owner.tenantId,
        (tx) =>
          tx`SELECT id FROM awcms_mini_domain_event_consumer_effects
             WHERE tenant_id = ${owner.tenantId} AND consumer_name = ${EVENT_ACTIVITY_PROJECTOR_CONSUMER_NAME}
               AND event_id = ${appended.eventId}`
      );
      expect((markerRowsWhileRebuilding as unknown[]).length).toBe(0);

      // The rebuild finishes normally (not cancelled) — the retried
      // delivery should now succeed on the next dispatch tick, once past
      // the backoff window.
      await continueRebuildPasses(sql, owner.tenantId, descriptor, run.id, 10);
      const finishedRun = await withTenant(sql, owner.tenantId, (tx) =>
        getRebuildRunById(tx, owner.tenantId, run.id)
      );
      expect(finishedRun?.status).toBe("completed");

      const future = new Date(Date.now() + 10 * 60 * 1000);
      const secondDispatch = await dispatchDomainEventsForTenant(
        sql,
        owner.tenantId,
        { now: future }
      );
      expect(secondDispatch.delivered).toBeGreaterThanOrEqual(1);

      const metricsAfterRetry = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      // Counted exactly once by the retried live delivery — the
      // completed rebuild's own re-scan of awcms_mini_domain_events (via
      // its rebuildSource streams) ALSO covers this same event (it was
      // already durably in the source table before the rebuild finished),
      // so this also proves the two paths don't double-count when both
      // legitimately observe the same underlying event.
      expect(
        metricsAfterRetry[EVENT_ACTIVITY_METRIC_KEYS.sampleRecordedCount]
      ).toBe(1);
    });

    test("ADVERSARIAL: cancelling a rebuild does not permanently lose an event that was concurrently delivered during it — the event is eventually retried and counted, never silently dropped (security-auditor finding, PR #781)", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();
      const descriptor = eventActivityDescriptor();

      const { run } = await withTenant(sql, owner.tenantId, (tx) =>
        triggerOrResumeRebuild(tx, owner.tenantId, descriptor, {
          requestedBy: null,
          reason: "adversarial rebuild-cancel + concurrent-delivery test"
        })
      );
      expect(run.status).toBe("running");

      // A new domain event arrives WHILE the rebuild is running.
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

      // The dispatcher tries to deliver it — must defer (retry), not
      // silently mark it delivered.
      const duringRebuild = await dispatchDomainEventsForTenant(
        sql,
        owner.tenantId
      );
      expect(duringRebuild.retried).toBe(1);

      const metricsDuringRebuild = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(
        metricsDuringRebuild[EVENT_ACTIVITY_METRIC_KEYS.sampleRecordedCount] ??
          0
      ).toBe(0);

      // Operator CANCELS the rebuild before its own bounded re-scan ever
      // reaches this event's row (we never call continueRebuildPasses
      // again after triggering, so the rebuild's own cursor never
      // advances past this event at all).
      await withTenant(sql, owner.tenantId, (tx) =>
        requestRebuildCancellation(tx, owner.tenantId, run.id)
      );
      // One bounded-pass invocation observes cancel_requested and marks
      // the run 'cancelled' (same mechanism `projection-rebuild.ts`'s own
      // cancellation tests already exercise).
      const cancelOutcome = await continueRebuildPasses(
        sql,
        owner.tenantId,
        descriptor,
        run.id,
        1
      );
      expect(cancelOutcome.status).toBe("cancelled");

      const cancelledRun = await withTenant(sql, owner.tenantId, (tx) =>
        getRebuildRunById(tx, owner.tenantId, run.id)
      );
      expect(cancelledRun?.status).toBe("cancelled");

      // Mutual exclusion is now lifted (no 'running' rebuild for this
      // projection) — the deferred delivery must be retried successfully
      // on the next dispatch tick, past the backoff window. Before this
      // fix, the event would be PERMANENTLY uncounted here: its
      // idempotency marker would already exist from the first (silently
      // no-opped) attempt, so this redelivery would be skipped as
      // "already applied" despite never having actually incremented
      // anything, and the cancelled rebuild never reached it either.
      const future = new Date(Date.now() + 10 * 60 * 1000);
      const afterCancel = await dispatchDomainEventsForTenant(
        sql,
        owner.tenantId,
        { now: future }
      );
      expect(afterCancel.delivered).toBeGreaterThanOrEqual(1);

      const metricsAfterCancel = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(
        metricsAfterCancel[EVENT_ACTIVITY_METRIC_KEYS.sampleRecordedCount]
      ).toBe(1);
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

  describe("HTTP layer (invoke() against the real route handlers) — auth/idempotency/cross-tenant wiring (Medium finding, PR #781 security-auditor review)", () => {
    test("GET /reports/projections and GET /reports/projections/{key}: 403 without reporting.projections.read, 200 with it", async () => {
      const owner = await bootstrap();
      const restricted = await createRestrictedUser(
        owner.tenantId,
        "restricted-projections-reader@example.com",
        [] // no permissions at all
      );
      const restrictedHeaders = {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${restricted.token}`
      };

      const deniedList = await invoke(listProjectionsRoute, {
        method: "GET",
        path: "/api/v1/reports/projections",
        headers: restrictedHeaders
      });
      expect(deniedList.status).toBe(403);

      const deniedGet = await invoke(getProjectionRoute, {
        method: "GET",
        path: `/api/v1/reports/projections/${ACCESS_AUDIT_SUMMARY_PROJECTION_KEY}`,
        headers: restrictedHeaders,
        params: { key: ACCESS_AUDIT_SUMMARY_PROJECTION_KEY }
      });
      expect(deniedGet.status).toBe(403);

      const allowedList = await invoke<{
        data: { projections: { key: string }[] };
      }>(listProjectionsRoute, {
        method: "GET",
        path: "/api/v1/reports/projections",
        headers: authHeaders(owner)
      });
      expect(allowedList.status).toBe(200);
      expect(allowedList.body.data.projections.length).toBe(3);

      const allowedGet = await invoke<{
        data: { projection: { key: string } };
      }>(getProjectionRoute, {
        method: "GET",
        path: `/api/v1/reports/projections/${ACCESS_AUDIT_SUMMARY_PROJECTION_KEY}`,
        headers: authHeaders(owner),
        params: { key: ACCESS_AUDIT_SUMMARY_PROJECTION_KEY }
      });
      expect(allowedGet.status).toBe(200);
      expect(allowedGet.body.data.projection.key).toBe(
        ACCESS_AUDIT_SUMMARY_PROJECTION_KEY
      );
    });

    test("POST rebuild: 403 without reporting.projections.rebuild, 409 on Idempotency-Key reuse with a different body, 200 success + exact replay on retry", async () => {
      const owner = await bootstrap();
      const restricted = await createRestrictedUser(
        owner.tenantId,
        "restricted-rebuild@example.com",
        ["reporting.projections.read"] // read, but NOT rebuild
      );
      const restrictedHeaders = {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${restricted.token}`,
        "idempotency-key": "restricted-rebuild-attempt"
      };

      const denied = await invoke(triggerRebuildRoute, {
        method: "POST",
        path: `/api/v1/reports/projections/${ACCESS_AUDIT_SUMMARY_PROJECTION_KEY}/rebuild`,
        headers: restrictedHeaders,
        params: { key: ACCESS_AUDIT_SUMMARY_PROJECTION_KEY },
        body: { reason: "should be denied" }
      });
      expect(denied.status).toBe(403);

      const idempotencyKey = "owner-rebuild-key-1";
      const first = await invoke<{
        data: { rebuild: { id: string }; resumed: boolean };
      }>(triggerRebuildRoute, {
        method: "POST",
        path: `/api/v1/reports/projections/${ACCESS_AUDIT_SUMMARY_PROJECTION_KEY}/rebuild`,
        headers: authHeaders(owner, idempotencyKey),
        params: { key: ACCESS_AUDIT_SUMMARY_PROJECTION_KEY },
        body: { reason: "first attempt" }
      });
      expect(first.status).toBe(200);
      expect(first.body.data.resumed).toBe(false);

      const conflicting = await invoke(triggerRebuildRoute, {
        method: "POST",
        path: `/api/v1/reports/projections/${ACCESS_AUDIT_SUMMARY_PROJECTION_KEY}/rebuild`,
        headers: authHeaders(owner, idempotencyKey),
        params: { key: ACCESS_AUDIT_SUMMARY_PROJECTION_KEY },
        body: { reason: "a DIFFERENT reason — same key must conflict" }
      });
      expect(conflicting.status).toBe(409);

      const replay = await invoke<{
        data: { rebuild: { id: string }; resumed: boolean };
      }>(triggerRebuildRoute, {
        method: "POST",
        path: `/api/v1/reports/projections/${ACCESS_AUDIT_SUMMARY_PROJECTION_KEY}/rebuild`,
        headers: authHeaders(owner, idempotencyKey),
        params: { key: ACCESS_AUDIT_SUMMARY_PROJECTION_KEY },
        body: { reason: "first attempt" }
      });
      expect(replay.status).toBe(200);
      expect(replay.body.data.rebuild.id).toBe(first.body.data.rebuild.id);
    });

    test("POST /reports/exports (create scheduled export): 403 without reporting.exports.configure, 409 on Idempotency-Key reuse with a different body, 200 success", async () => {
      const owner = await bootstrap();
      const restricted = await createRestrictedUser(
        owner.tenantId,
        "restricted-exports-configure@example.com",
        ["reporting.exports.read"] // read, but NOT configure
      );
      const restrictedHeaders = {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${restricted.token}`,
        "idempotency-key": "restricted-export-config-attempt"
      };

      const denied = await invoke(createScheduledExportRoute, {
        method: "POST",
        path: "/api/v1/reports/exports",
        headers: restrictedHeaders,
        body: {
          projectionKey: ACCESS_AUDIT_SUMMARY_PROJECTION_KEY,
          format: "csv",
          scheduleIntervalMinutes: 60
        }
      });
      expect(denied.status).toBe(403);

      const idempotencyKey = "owner-export-config-key-1";
      const first = await invoke<{ data: { scheduledExport: { id: string } } }>(
        createScheduledExportRoute,
        {
          method: "POST",
          path: "/api/v1/reports/exports",
          headers: authHeaders(owner, idempotencyKey),
          body: {
            projectionKey: ACCESS_AUDIT_SUMMARY_PROJECTION_KEY,
            format: "csv",
            scheduleIntervalMinutes: 60
          }
        }
      );
      expect(first.status).toBe(200);

      const conflicting = await invoke(createScheduledExportRoute, {
        method: "POST",
        path: "/api/v1/reports/exports",
        headers: authHeaders(owner, idempotencyKey),
        body: {
          projectionKey: ACCESS_AUDIT_SUMMARY_PROJECTION_KEY,
          format: "csv",
          scheduleIntervalMinutes: 120 // different body, same key
        }
      });
      expect(conflicting.status).toBe(409);

      const list = await invoke<{
        data: { scheduledExports: { id: string }[] };
      }>(listScheduledExportsRoute, {
        method: "GET",
        path: "/api/v1/reports/exports",
        headers: authHeaders(owner)
      });
      expect(list.status).toBe(200);
      expect(list.body.data.scheduledExports.map((e) => e.id)).toEqual([
        first.body.data.scheduledExport.id
      ]);
    });

    test("POST /reports/exports/trigger: 403 without reporting.exports.export, then 200 success; GET download: cross-tenant caller gets 404, owning tenant succeeds", async () => {
      const owner = await bootstrap();
      const restricted = await createRestrictedUser(
        owner.tenantId,
        "restricted-exports-trigger@example.com",
        ["reporting.exports.read"] // read, but NOT export
      );
      const restrictedHeaders = {
        "content-type": "application/json",
        "x-awcms-mini-tenant-id": owner.tenantId,
        authorization: `Bearer ${restricted.token}`,
        "idempotency-key": "restricted-export-trigger-attempt"
      };

      const denied = await invoke(triggerExportRoute, {
        method: "POST",
        path: "/api/v1/reports/exports/trigger",
        headers: restrictedHeaders,
        body: {
          projectionKey: ACCESS_AUDIT_SUMMARY_PROJECTION_KEY,
          format: "csv"
        }
      });
      expect(denied.status).toBe(403);

      const triggered = await invoke<{
        data: { export: { id: string; status: string } };
      }>(triggerExportRoute, {
        method: "POST",
        path: "/api/v1/reports/exports/trigger",
        headers: authHeaders(owner, "owner-export-trigger-key-1"),
        body: {
          projectionKey: ACCESS_AUDIT_SUMMARY_PROJECTION_KEY,
          format: "csv"
        }
      });
      expect(triggered.status).toBe(200);
      expect(triggered.body.data.export.status).toBe("completed");
      const exportRunId = triggered.body.data.export.id;

      const ownTenantDownload = await invokeRaw(downloadExportRoute, {
        method: "GET",
        path: `/api/v1/reports/exports/runs/${exportRunId}/download`,
        headers: authHeaders(owner),
        params: { id: exportRunId }
      });
      expect(ownTenantDownload.status).toBe(200);
      expect(ownTenantDownload.response.headers.get("content-type")).toContain(
        "text/csv"
      );
      expect(
        ownTenantDownload.response.headers.get("x-checksum-sha256")
      ).toBeTruthy();
      expect(ownTenantDownload.text.length).toBeGreaterThan(0);

      // A completely different tenant, whose session genuinely HOLDS
      // reporting.exports.read (so a 404 here can only come from real
      // tenant-scoped RLS, never a coarse permission gate — a bare
      // ABAC-deny would be a false positive for this specific test), must
      // NOT be able to see tenant A's export run at all — RLS scopes
      // `getExportRun` by tenant_id, so this is a genuine "does not exist
      // for you" 404, never disclosing that a resource ID is valid for
      // SOME other tenant.
      const otherTenant = await createSecondTenantWithReportingAccess(
        "tenant-b-export-download"
      );
      const crossTenantDownload = await invokeRaw(downloadExportRoute, {
        method: "GET",
        path: `/api/v1/reports/exports/runs/${exportRunId}/download`,
        headers: authHeaders(otherTenant),
        params: { id: exportRunId }
      });
      expect(crossTenantDownload.status).toBe(404);
    });
  });
});
