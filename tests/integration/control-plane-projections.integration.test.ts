/**
 * Integration tests for Issue #880 (epic #868 SaaS control plane, Wave 3
 * operations): the control-plane modules' own `reporting` projections.
 *
 * What these prove, on a real PostgreSQL database:
 *
 * 1. the generic cursor engine materializes a CONTROL-PLANE module's
 *    projection correctly (per-discriminator counts, resumable, no
 *    double-count);
 * 2. reconciliation agrees with a freshly computed source control total, and
 *    a rebuild recomputes the SAME values (idempotent);
 * 3. a projection whose owning module the tenant has NOT enabled is inert and
 *    invisible — the worker skips it without advancing any cursor, the list
 *    endpoint omits it, and the detail endpoint answers 403 — and enabling
 *    the module afterwards loses NOTHING (the deferred rows are all counted);
 * 4. the real least-privilege `awcms_mini_worker` role can read every source
 *    table these descriptors declare (migration 101's grants) — the failure
 *    this catches is invisible to an admin-role test, which is exactly how a
 *    projection silently reports 0 forever in production; and
 * 5. cross-tenant isolation: tenant B's rows never reach tenant A's metrics.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 *
 * NOTE: never use `.rejects.toThrow()` against a real Bun.SQL promise in this
 * repo — it spins the process at 100% CPU forever (confirmed project
 * pitfall). Rejections are asserted with manual try/catch.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

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
import { GET as listProjectionsRoute } from "../../src/pages/api/v1/reports/projections/index";
import { GET as getProjectionRoute } from "../../src/pages/api/v1/reports/projections/[key]/index";

import { syncModuleDescriptors } from "../../src/modules/module-management/application/descriptor-sync";
import { findProjectionDescriptor } from "../../src/modules/reporting/application/projection-directory";
import { getProjectionMetrics } from "../../src/modules/reporting/application/projection-metric-store";
import { getStreamCursor } from "../../src/modules/reporting/application/projection-cursor-store";
import { runIncrementalUpdateForTenant } from "../../src/modules/reporting/application/projection-incremental-worker";
import { reconcileProjection } from "../../src/modules/reporting/application/projection-reconciliation";
import {
  continueRebuildPasses,
  triggerOrResumeRebuild
} from "../../src/modules/reporting/application/projection-rebuild";

import {
  LIFECYCLE_TRANSITIONS_METRIC_KEYS,
  LIFECYCLE_TRANSITIONS_PROJECTION_KEY
} from "../../src/modules/tenant-lifecycle/domain/projection-keys";
import {
  USAGE_RECONCILIATION_METRIC_KEYS,
  USAGE_RECONCILIATION_PROJECTION_KEY
} from "../../src/modules/usage-metering/domain/projection-keys";
import { PROVISIONING_OUTCOMES_PROJECTION_KEY } from "../../src/modules/tenant-provisioning/domain/projection-keys";
import { ENTITLEMENT_EVALUATIONS_PROJECTION_KEY } from "../../src/modules/tenant-entitlement/domain/projection-keys";
import { INVOICE_LIFECYCLE_PROJECTION_KEY } from "../../src/modules/subscription-billing/domain/projection-keys";
import { PAYMENT_PROCESSING_PROJECTION_KEY } from "../../src/modules/payment-gateway/domain/projection-keys";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string };

async function bootstrap(): Promise<Bootstrap> {
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme",
      tenantCode: "acme",
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: OWNER_LOGIN,
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
    body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token
  };
}

function authHeaders(owner: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": owner.tenantId,
    authorization: `Bearer ${owner.token}`
  };
}

/**
 * `POST /api/v1/setup/initialize` is a one-time-only singleton per database
 * (see `reporting-projections.integration.test.ts`'s own note), so a second
 * tenant is created with bare admin SQL — these tests only need its ID to
 * seed rows against and run the engine for it.
 */
async function createBareSecondTenant(tenantCode: string): Promise<string> {
  const tenantId = crypto.randomUUID();
  await getAdminSql()`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${tenantId}, ${tenantCode}, ${tenantCode}, ${tenantCode}, 'active', 'en', 'light')
  `;
  return tenantId;
}

/** Populates `awcms_mini_modules` (the FK target of `awcms_mini_tenant_modules`) — the module registry is not seeded by the setup wizard. */
async function syncModuleRegistry(): Promise<void> {
  const admin = getAdminSql();
  await admin.begin((tx) => syncModuleDescriptors(tx as unknown as Bun.SQL));
}

/** Explicit per-tenant module state — every control-plane module is `defaultTenantState: "disabled"` (ADR-0022 §7), so "enabled" is never implicit here. */
async function setModuleEnabled(
  tenantId: string,
  moduleKey: string,
  enabled: boolean
): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key, enabled)
    VALUES (${tenantId}, ${moduleKey}, ${enabled})
    ON CONFLICT (tenant_id, module_key) DO UPDATE SET enabled = ${enabled}
  `;
}

/**
 * Explicit, strictly-increasing `created_at` values, never the column's own
 * `DEFAULT now()`: `now()` is STABLE within one Postgres transaction, so
 * seeding several rows in a single transaction would give them all the
 * IDENTICAL timestamp and defeat cursor ordering entirely (the exact trap
 * `reporting-projections.integration.test.ts`'s own `seedDecisionLogs`
 * documents). The synthetic clock is reset per test.
 */
let syntheticClockCursorMs = 0;

function nextSyntheticTimestamp(): Date {
  syntheticClockCursorMs += 10;
  return new Date(1_700_000_000_000 + syntheticClockCursorMs);
}

type LifecycleEventSeed = { eventKind: string; toState: string };

async function seedLifecycleHistory(
  tenantId: string,
  events: readonly LifecycleEventSeed[]
): Promise<void> {
  const admin = getAdminSql();

  for (const [index, event] of events.entries()) {
    // One INSERT per transaction (not one transaction for all of them) so
    // each row really commits separately, matching production writes.
    await withTenant(admin, tenantId, async (tx) => {
      await tx`
        INSERT INTO awcms_mini_tenant_lifecycle_history
          (tenant_id, event_kind, from_state, to_state, version, source, created_at)
        VALUES (
          ${tenantId}, ${event.eventKind}, NULL, ${event.toState},
          ${index + 1}, 'system', ${nextSyntheticTimestamp()}
        )
      `;
    });
  }
}

async function seedUsageReconciliationRuns(
  tenantId: string,
  statuses: readonly string[]
): Promise<void> {
  const admin = getAdminSql();

  for (const status of statuses) {
    await withTenant(admin, tenantId, async (tx) => {
      await tx`
        INSERT INTO awcms_mini_usage_reconciliation_runs
          (tenant_id, window_type, range_from, range_to, status, created_at)
        VALUES (
          ${tenantId}, 'day',
          ${new Date(1_699_000_000_000)}, ${new Date(1_699_100_000_000)},
          ${status}, ${nextSyntheticTimestamp()}
        )
      `;
    });
  }
}

function lifecycleDescriptor() {
  const descriptor = findProjectionDescriptor(
    LIFECYCLE_TRANSITIONS_PROJECTION_KEY
  );
  if (!descriptor) {
    throw new Error(
      `${LIFECYCLE_TRANSITIONS_PROJECTION_KEY} is not registered — the descriptor must be declared by tenant_lifecycle's own module.ts.`
    );
  }
  return descriptor;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("control-plane reporting projections (Issue #880)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    syntheticClockCursorMs = 0;
  });

  describe("cursor engine over a control-plane source table", () => {
    test("counts by event kind and destination state, resumes without double-counting", async () => {
      const owner = await bootstrap();
      await syncModuleRegistry();
      await setModuleEnabled(owner.tenantId, "tenant_lifecycle", true);

      const sql = getAdminSql();
      const descriptor = lifecycleDescriptor();

      await seedLifecycleHistory(owner.tenantId, [
        { eventKind: "transition", toState: "trial" },
        { eventKind: "transition", toState: "active" },
        { eventKind: "transition", toState: "past_due" },
        { eventKind: "schedule_set", toState: "past_due" },
        { eventKind: "transition", toState: "suspended" }
      ]);

      const first = await runIncrementalUpdateForTenant(
        sql,
        descriptor,
        owner.tenantId
      );
      expect(first.failed).toBe(false);
      expect(first.skippedModuleDisabled).toBe(false);
      expect(first.rowsProcessed).toBe(5);

      let metrics = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.historyTotal]).toBe(5);
      expect(metrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.transitionCount]).toBe(
        4
      );
      expect(metrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.scheduleSetCount]).toBe(
        1
      );
      expect(metrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredPastDue]).toBe(2);
      expect(metrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredSuspended]).toBe(
        1
      );
      expect(
        metrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredCanceled] ?? 0
      ).toBe(0);

      // A second pass with no new rows is a true no-op.
      const second = await runIncrementalUpdateForTenant(
        sql,
        descriptor,
        owner.tenantId
      );
      expect(second.rowsProcessed).toBe(0);

      // Only NEW rows are counted on the next pass.
      await seedLifecycleHistory(owner.tenantId, [
        { eventKind: "restore", toState: "active" }
      ]);
      const third = await runIncrementalUpdateForTenant(
        sql,
        descriptor,
        owner.tenantId
      );
      expect(third.rowsProcessed).toBe(1);

      metrics = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.historyTotal]).toBe(6);
      expect(metrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.restoreCount]).toBe(1);
      expect(metrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredActive]).toBe(2);
    });

    test("reconciliation matches the source, and a rebuild recomputes the same values", async () => {
      const owner = await bootstrap();
      await syncModuleRegistry();
      await setModuleEnabled(owner.tenantId, "tenant_lifecycle", true);

      const sql = getAdminSql();
      const descriptor = lifecycleDescriptor();

      await seedLifecycleHistory(owner.tenantId, [
        { eventKind: "transition", toState: "trial" },
        { eventKind: "transition", toState: "active" },
        { eventKind: "downgrade", toState: "active" },
        { eventKind: "transition", toState: "grace" }
      ]);

      await runIncrementalUpdateForTenant(sql, descriptor, owner.tenantId);

      const reconciliation = await withTenant(sql, owner.tenantId, (tx) =>
        reconcileProjection(tx, owner.tenantId, descriptor, null, null)
      );
      expect(reconciliation.mismatch).toBe(false);
      expect(reconciliation.details.length).toBeGreaterThan(0);
      for (const detail of reconciliation.details) {
        expect(detail.projectionTotal).toBe(detail.sourceTotal);
      }

      const before = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );

      const { run } = await withTenant(sql, owner.tenantId, (tx) =>
        triggerOrResumeRebuild(tx, owner.tenantId, descriptor, {
          requestedBy: null,
          reason: "issue-880 integration rebuild",
          correlationId: null
        })
      );
      await continueRebuildPasses(sql, owner.tenantId, descriptor, run.id);

      const after = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );

      // A rebuild recomputes EVERY declared metric, so it additionally
      // materializes the zeros the incremental path never wrote a row for
      // (a discriminator that has not occurred yet). Every value the
      // incremental path did produce must be identical, and every extra key
      // the rebuild added must be exactly 0 — anything else is the rebuild
      // disagreeing with the steady state, which is the failure this asserts
      // against.
      for (const [metricKey, value] of Object.entries(before)) {
        expect(after[metricKey], `metric ${metricKey} changed on rebuild`).toBe(
          value
        );
      }
      for (const [metricKey, value] of Object.entries(after)) {
        if (!(metricKey in before)) {
          expect(value, `rebuild invented a non-zero ${metricKey}`).toBe(0);
        }
      }
      expect(after[LIFECYCLE_TRANSITIONS_METRIC_KEYS.historyTotal]).toBe(4);
      expect(after[LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredActive]).toBe(2);
    });

    test("a second control-plane module's projection works the same way (the pattern is not one-off)", async () => {
      const owner = await bootstrap();
      await syncModuleRegistry();
      await setModuleEnabled(owner.tenantId, "usage_metering", true);

      const sql = getAdminSql();
      const descriptor = findProjectionDescriptor(
        USAGE_RECONCILIATION_PROJECTION_KEY
      )!;
      expect(descriptor).toBeDefined();

      await seedUsageReconciliationRuns(owner.tenantId, [
        "consistent",
        "consistent",
        "drift_detected",
        "failed"
      ]);

      const outcome = await runIncrementalUpdateForTenant(
        sql,
        descriptor,
        owner.tenantId
      );
      expect(outcome.rowsProcessed).toBe(4);

      const metrics = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metrics[USAGE_RECONCILIATION_METRIC_KEYS.runTotal]).toBe(4);
      expect(metrics[USAGE_RECONCILIATION_METRIC_KEYS.consistentCount]).toBe(2);
      expect(metrics[USAGE_RECONCILIATION_METRIC_KEYS.driftDetectedCount]).toBe(
        1
      );
      expect(metrics[USAGE_RECONCILIATION_METRIC_KEYS.failedCount]).toBe(1);
    });
  });

  describe("a disabled owning module is inert and invisible", () => {
    test("the worker skips it, advances no cursor, and loses nothing once enabled", async () => {
      const owner = await bootstrap();
      await syncModuleRegistry();
      // Deliberately NOT enabled: `tenant_lifecycle` is default-disabled, so
      // the absence of a row is already "disabled" (ADR-0022 §7).

      const sql = getAdminSql();
      const descriptor = lifecycleDescriptor();

      await seedLifecycleHistory(owner.tenantId, [
        { eventKind: "transition", toState: "trial" },
        { eventKind: "transition", toState: "active" }
      ]);

      const skipped = await runIncrementalUpdateForTenant(
        sql,
        descriptor,
        owner.tenantId
      );
      expect(skipped.skippedModuleDisabled).toBe(true);
      expect(skipped.failed).toBe(false);
      expect(skipped.rowsProcessed).toBe(0);

      const metrics = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.historyTotal] ?? 0).toBe(
        0
      );

      // The critical property: no cursor moved, so nothing was consumed.
      const cursor = await withTenant(sql, owner.tenantId, (tx) =>
        getStreamCursor(
          tx,
          owner.tenantId,
          descriptor.key,
          descriptor.rebuildSource.streams[0]!.streamKey
        )
      );
      expect(cursor).toBeNull();

      // Enabling the module now counts the rows written while it was off.
      await setModuleEnabled(owner.tenantId, "tenant_lifecycle", true);
      const resumed = await runIncrementalUpdateForTenant(
        sql,
        descriptor,
        owner.tenantId
      );
      expect(resumed.skippedModuleDisabled).toBe(false);
      expect(resumed.rowsProcessed).toBe(2);
    });

    test("the API omits it from the list and answers 403 on direct access", async () => {
      const owner = await bootstrap();
      await syncModuleRegistry();

      const listWhileDisabled = await invoke<{
        data: { projections: { key: string }[] };
      }>(listProjectionsRoute, {
        method: "GET",
        path: "/api/v1/reports/projections",
        headers: authHeaders(owner)
      });
      expect(listWhileDisabled.status).toBe(200);
      const disabledKeys = listWhileDisabled.body.data.projections.map(
        (projection) => projection.key
      );
      // Every control-plane projection is hidden — the tenant has enabled
      // none of these modules.
      for (const key of [
        LIFECYCLE_TRANSITIONS_PROJECTION_KEY,
        PROVISIONING_OUTCOMES_PROJECTION_KEY,
        ENTITLEMENT_EVALUATIONS_PROJECTION_KEY,
        USAGE_RECONCILIATION_PROJECTION_KEY,
        INVOICE_LIFECYCLE_PROJECTION_KEY,
        PAYMENT_PROCESSING_PROJECTION_KEY
      ]) {
        expect(disabledKeys).not.toContain(key);
      }
      // ...while `reporting`'s own projections (a base module) stay visible,
      // so this is a module gate, not a broken list.
      expect(disabledKeys.length).toBeGreaterThan(0);

      const detailWhileDisabled = await invoke(getProjectionRoute, {
        method: "GET",
        path: `/api/v1/reports/projections/${LIFECYCLE_TRANSITIONS_PROJECTION_KEY}`,
        headers: authHeaders(owner),
        params: { key: LIFECYCLE_TRANSITIONS_PROJECTION_KEY }
      });
      expect(detailWhileDisabled.status).toBe(403);

      await setModuleEnabled(owner.tenantId, "tenant_lifecycle", true);

      const listWhileEnabled = await invoke<{
        data: { projections: { key: string }[] };
      }>(listProjectionsRoute, {
        method: "GET",
        path: "/api/v1/reports/projections",
        headers: authHeaders(owner)
      });
      expect(listWhileEnabled.status).toBe(200);
      expect(
        listWhileEnabled.body.data.projections.map(
          (projection) => projection.key
        )
      ).toContain(LIFECYCLE_TRANSITIONS_PROJECTION_KEY);

      const detailWhileEnabled = await invoke<{
        data: {
          projection: {
            metrics: Record<string, number>;
            metricLabels: Record<string, string>;
          };
        };
      }>(getProjectionRoute, {
        method: "GET",
        path: `/api/v1/reports/projections/${LIFECYCLE_TRANSITIONS_PROJECTION_KEY}`,
        headers: authHeaders(owner),
        params: { key: LIFECYCLE_TRANSITIONS_PROJECTION_KEY }
      });
      expect(detailWhileEnabled.status).toBe(200);

      // Every DECLARED metric is reported, defaulting to 0 — a discriminator
      // that has never occurred reads as 0, not as an absent key that a
      // client would render as blank/undefined (Issue #880).
      const { metrics, metricLabels } = detailWhileEnabled.body.data.projection;
      for (const metricKey of Object.keys(metricLabels)) {
        expect(metrics[metricKey], `metric ${metricKey} missing`).toBe(0);
      }
    });
  });

  describe("least-privilege worker role and tenant isolation", () => {
    test("the real awcms_mini_worker connection can read every declared control-plane source", async () => {
      const owner = await bootstrap();
      await syncModuleRegistry();
      await setModuleEnabled(owner.tenantId, "tenant_lifecycle", true);

      await seedLifecycleHistory(owner.tenantId, [
        { eventKind: "transition", toState: "active" },
        { eventKind: "transition", toState: "grace" }
      ]);

      // The refresh job runs as this role, NOT as the admin/app role: a
      // missing GRANT here is invisible to every other test in this file and
      // would make the projection report 0 forever in production.
      const workerSql = getWorkerTestSql();
      const descriptor = lifecycleDescriptor();

      const outcome = await runIncrementalUpdateForTenant(
        workerSql,
        descriptor,
        owner.tenantId
      );
      expect(outcome.failed).toBe(false);
      expect(outcome.skippedModuleDisabled).toBe(false);
      expect(outcome.rowsProcessed).toBe(2);

      const metrics = await withTenant(workerSql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      expect(metrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.historyTotal]).toBe(2);
    });

    test("another tenant's rows never reach this tenant's metrics", async () => {
      const owner = await bootstrap();
      await syncModuleRegistry();
      await setModuleEnabled(owner.tenantId, "tenant_lifecycle", true);

      const otherTenantId = await createBareSecondTenant("beta");
      await setModuleEnabled(otherTenantId, "tenant_lifecycle", true);

      const sql = getAdminSql();
      const descriptor = lifecycleDescriptor();

      await seedLifecycleHistory(owner.tenantId, [
        { eventKind: "transition", toState: "active" }
      ]);
      await seedLifecycleHistory(otherTenantId, [
        { eventKind: "transition", toState: "suspended" },
        { eventKind: "transition", toState: "canceled" }
      ]);

      await runIncrementalUpdateForTenant(sql, descriptor, owner.tenantId);
      await runIncrementalUpdateForTenant(sql, descriptor, otherTenantId);

      const ownerMetrics = await withTenant(sql, owner.tenantId, (tx) =>
        getProjectionMetrics(tx, owner.tenantId, descriptor.key)
      );
      const otherMetrics = await withTenant(sql, otherTenantId, (tx) =>
        getProjectionMetrics(tx, otherTenantId, descriptor.key)
      );

      expect(ownerMetrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.historyTotal]).toBe(
        1
      );
      expect(
        ownerMetrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredCanceled] ?? 0
      ).toBe(0);
      expect(otherMetrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.historyTotal]).toBe(
        2
      );
      expect(
        otherMetrics[LIFECYCLE_TRANSITIONS_METRIC_KEYS.enteredCanceled]
      ).toBe(1);
    });
  });
});
