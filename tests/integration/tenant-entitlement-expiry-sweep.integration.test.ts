/**
 * Integration tests for the entitlement expiry sweep (Issue #930, epic #868),
 * against a real PostgreSQL database.
 *
 * The sweep exists to drain the backlog
 * `control_plane_entitlement_expired_unswept` measures, which Wave 1 shipped an
 * alert on with no consumer at all. Two things therefore need proving, and the
 * second matters more than the first:
 *
 *  1. It closes out exactly the rows whose window has elapsed, and nothing
 *     else — the boundary cases (open-ended, still-valid, already suspended or
 *     canceled) must survive untouched.
 *
 *  2. It changes NOBODY'S EFFECTIVE ACCESS. Resolution already ignores an
 *     assignment whose window has closed, so the transition active -> expired
 *     must be a pure bookkeeping move. A sweep that quietly altered what a
 *     tenant is entitled to would be a far worse bug than the drift it exists
 *     to fix, and it would be easy to introduce by mistake (a stray predicate
 *     touching a still-valid row). The resolution snapshot is therefore
 *     captured before and after and compared.
 *
 * Writes run as the real `awcms_mini_worker` role, not the admin connection: a
 * developer DATABASE_URL is typically a superuser, and a superuser bypasses
 * both grants and RLS — so a missing `GRANT UPDATE` (migration 104) would look
 * perfectly fine here and fail only in production.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getWorkerTestSql,
  integrationEnabled,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { withTenant } from "../../src/lib/database/tenant-context";
import {
  countExpirableAssignmentsForTenant,
  sweepExpiredAssignmentsForTenant
} from "../../src/modules/tenant-entitlement/application/expiry-sweep";
import { collectEntitlementSignals } from "../../src/modules/tenant-entitlement/application/control-plane-signals";

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-07-01T00:00:00.000Z");
const EARLIER = new Date("2026-05-01T00:00:00.000Z");
const PAST = new Date("2026-06-01T00:00:00.000Z");
const FUTURE = new Date("2026-08-01T00:00:00.000Z");
const CORRELATION_ID = "44444444-4444-4444-8444-444444444444";

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenant(getAdminSql(), tenantId, fn);
}

/** The sweep's own connection: the real least-privilege worker role. */
function asWorker<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenant(getWorkerTestSql(), tenantId, fn);
}

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code}, ${code}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedAssignment(
  tenantId: string,
  status: string,
  effectiveTo: Date | null,
  planKey: string
): Promise<void> {
  await inTenant(
    tenantId,
    (tx) => tx`
      INSERT INTO awcms_mini_tenant_entitlement_assignments
        (tenant_id, plan_key, offer_version, offer_hash, currency, source,
         status, effective_from, effective_to, suspended_at, canceled_at)
      VALUES (${tenantId}, ${planKey}, 1, ${"c".repeat(64)}, 'IDR', 'manual',
              ${status}, ${EARLIER}, ${effectiveTo},
              ${status === "suspended" ? PAST : null},
              ${status === "canceled" ? PAST : null})
    `
  );
}

async function statusOf(tenantId: string, planKey: string): Promise<string> {
  const rows = await inTenant(
    tenantId,
    (tx) => tx`
      SELECT status FROM awcms_mini_tenant_entitlement_assignments
      WHERE tenant_id = ${tenantId} AND plan_key = ${planKey}
    `
  );
  return (rows as { status: string }[])[0]?.status ?? "(missing)";
}

describe.skipIf(!integrationEnabled)(
  "tenant_entitlement expiry sweep (Issue #930)",
  () => {
    beforeAll(async () => {
      await applyMigrations();
      await provisionWorkerRole();
    });

    beforeEach(async () => {
      await resetDatabase();
      await seedTenant(TENANT_ID, "sweep_a");
      await seedTenant(OTHER_TENANT_ID, "sweep_b");
    });

    test("expires exactly the assignments whose window has elapsed", async () => {
      await seedAssignment(TENANT_ID, "active", PAST, "elapsed");
      await seedAssignment(TENANT_ID, "active", FUTURE, "still_valid");
      await seedAssignment(TENANT_ID, "active", null, "open_ended");
      await seedAssignment(TENANT_ID, "suspended", PAST, "already_suspended");
      await seedAssignment(TENANT_ID, "canceled", PAST, "already_canceled");

      const outcome = await asWorker(TENANT_ID, (tx) =>
        sweepExpiredAssignmentsForTenant(tx, TENANT_ID, {
          now: NOW,
          correlationId: CORRELATION_ID
        })
      );

      expect(outcome.expired).toBe(1);
      expect(outcome.truncated).toBe(false);

      // Assert every boundary explicitly rather than only the count: a
      // predicate that expired the wrong row would still report 1.
      expect(await statusOf(TENANT_ID, "elapsed")).toBe("expired");
      expect(await statusOf(TENANT_ID, "still_valid")).toBe("active");
      expect(await statusOf(TENANT_ID, "open_ended")).toBe("active");
      expect(await statusOf(TENANT_ID, "already_suspended")).toBe("suspended");
      expect(await statusOf(TENANT_ID, "already_canceled")).toBe("canceled");
    });

    test("does NOT change what any tenant is entitled to (bookkeeping only)", async () => {
      // The property the whole design rests on. Resolution already ignores a
      // closed window, so the effective entitlement must be byte-identical
      // before and after. If this ever fails, the sweep has started making
      // authorization decisions, which it must never do.
      await seedAssignment(TENANT_ID, "active", PAST, "elapsed");
      await seedAssignment(TENANT_ID, "active", FUTURE, "still_valid");

      const before = await asWorker(TENANT_ID, (tx) =>
        collectEntitlementSignals(tx, NOW)
      );
      const activeBefore = await inTenant(
        TENANT_ID,
        (tx) => tx`
          SELECT plan_key FROM awcms_mini_tenant_entitlement_assignments
          WHERE tenant_id = ${TENANT_ID}
            AND status = 'active'
            AND (effective_to IS NULL OR effective_to > ${NOW})
          ORDER BY plan_key
        `
      );

      await asWorker(TENANT_ID, (tx) =>
        sweepExpiredAssignmentsForTenant(tx, TENANT_ID, {
          now: NOW,
          correlationId: CORRELATION_ID
        })
      );

      const activeAfter = await inTenant(
        TENANT_ID,
        (tx) => tx`
          SELECT plan_key FROM awcms_mini_tenant_entitlement_assignments
          WHERE tenant_id = ${TENANT_ID}
            AND status = 'active'
            AND (effective_to IS NULL OR effective_to > ${NOW})
          ORDER BY plan_key
        `
      );

      // The set of assignments that actually grant anything is unchanged.
      expect(JSON.stringify(activeAfter)).toBe(JSON.stringify(activeBefore));
      // And the backlog the sweep exists to drain has in fact drained.
      expect(before.expiredUnswept).toBe(1);
      const after = await asWorker(TENANT_ID, (tx) =>
        collectEntitlementSignals(tx, NOW)
      );
      expect(after.expiredUnswept).toBe(0);
    });

    test("is idempotent: a second pass finds nothing left to do", async () => {
      await seedAssignment(TENANT_ID, "active", PAST, "elapsed");

      const first = await asWorker(TENANT_ID, (tx) =>
        sweepExpiredAssignmentsForTenant(tx, TENANT_ID, {
          now: NOW,
          correlationId: CORRELATION_ID
        })
      );
      const second = await asWorker(TENANT_ID, (tx) =>
        sweepExpiredAssignmentsForTenant(tx, TENANT_ID, {
          now: NOW,
          correlationId: CORRELATION_ID
        })
      );

      expect(`${first.expired}/${second.expired}`).toBe("1/0");
    });

    test("never touches another tenant's rows", async () => {
      await seedAssignment(TENANT_ID, "active", PAST, "elapsed");
      await seedAssignment(OTHER_TENANT_ID, "active", PAST, "elapsed");

      await asWorker(TENANT_ID, (tx) =>
        sweepExpiredAssignmentsForTenant(tx, TENANT_ID, {
          now: NOW,
          correlationId: CORRELATION_ID
        })
      );

      expect(await statusOf(TENANT_ID, "elapsed")).toBe("expired");
      expect(await statusOf(OTHER_TENANT_ID, "elapsed")).toBe("active");
    });

    test("records the transition timestamp, satisfying the consistency CHECK", async () => {
      // Migration 104 constrains (status = 'expired') = (expired_at IS NOT
      // NULL) in both directions, so a sweep that set one without the other
      // would fail the write outright rather than store a half-state.
      await seedAssignment(TENANT_ID, "active", PAST, "elapsed");
      await asWorker(TENANT_ID, (tx) =>
        sweepExpiredAssignmentsForTenant(tx, TENANT_ID, {
          now: NOW,
          correlationId: CORRELATION_ID
        })
      );

      const rows = await inTenant(
        TENANT_ID,
        (tx) => tx`
          SELECT status, expired_at
          FROM awcms_mini_tenant_entitlement_assignments
          WHERE tenant_id = ${TENANT_ID} AND plan_key = 'elapsed'
        `
      );
      const row = (rows as { status: string; expired_at: Date | null }[])[0]!;
      expect(row.status).toBe("expired");
      expect(row.expired_at).not.toBeNull();
    });

    test("writes an audit row for every closed assignment", async () => {
      await seedAssignment(TENANT_ID, "active", PAST, "elapsed");
      await asWorker(TENANT_ID, (tx) =>
        sweepExpiredAssignmentsForTenant(tx, TENANT_ID, {
          now: NOW,
          correlationId: CORRELATION_ID
        })
      );

      const rows = await inTenant(
        TENANT_ID,
        (tx) => tx`
          SELECT action, severity, resource_type
          FROM awcms_mini_audit_events
          WHERE tenant_id = ${TENANT_ID}
            AND module_key = 'tenant_entitlement'
            AND resource_type = 'tenant_entitlement_assignment'
        `
      );
      const audit = rows as {
        action: string;
        severity: string;
        resource_type: string;
      }[];
      expect(audit.length).toBe(1);
      // `info`, not `warning`: a window closing on schedule is the system
      // working, and filing it beside suspensions and revocations would bury
      // the rows an auditor actually needs.
      expect(`${audit[0]!.action}:${audit[0]!.severity}`).toBe("expire:info");
    });

    test("the dry-run counter predicts exactly what the sweep would close", async () => {
      // The two share a predicate by intent; if they ever diverge, --dry-run
      // stops predicting the real run, which is its only purpose.
      await seedAssignment(TENANT_ID, "active", PAST, "elapsed_one");
      await seedAssignment(TENANT_ID, "active", PAST, "elapsed_two");
      await seedAssignment(TENANT_ID, "active", FUTURE, "still_valid");

      const predicted = await asWorker(TENANT_ID, (tx) =>
        countExpirableAssignmentsForTenant(tx, TENANT_ID, NOW)
      );
      const actual = await asWorker(TENANT_ID, (tx) =>
        sweepExpiredAssignmentsForTenant(tx, TENANT_ID, {
          now: NOW,
          correlationId: CORRELATION_ID
        })
      );

      expect(`predicted=${predicted}`).toBe(`predicted=${actual.expired}`);
    });

    test("honours the batch limit and reports truncation", async () => {
      await seedAssignment(TENANT_ID, "active", PAST, "elapsed_one");
      await seedAssignment(TENANT_ID, "active", PAST, "elapsed_two");
      await seedAssignment(TENANT_ID, "active", PAST, "elapsed_three");

      const first = await asWorker(TENANT_ID, (tx) =>
        sweepExpiredAssignmentsForTenant(tx, TENANT_ID, {
          now: NOW,
          correlationId: CORRELATION_ID,
          batchLimit: 2
        })
      );
      expect(`${first.expired}:${first.truncated}`).toBe("2:true");

      const second = await asWorker(TENANT_ID, (tx) =>
        sweepExpiredAssignmentsForTenant(tx, TENANT_ID, {
          now: NOW,
          correlationId: CORRELATION_ID,
          batchLimit: 2
        })
      );
      expect(`${second.expired}:${second.truncated}`).toBe("1:false");
    });
  }
);
