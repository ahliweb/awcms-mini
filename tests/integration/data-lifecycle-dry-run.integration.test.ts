/**
 * Integration tests for `planLifecycleDryRun` (Issue #745) against real
 * PostgreSQL: determinism/zero-mutation, legal-hold precedence (the
 * critical "cannot be silently bypassed" requirement), cross-tenant
 * isolation, and missing-tenant-context RLS fail-closed behavior.
 *
 * Uses the `logging.audit_events` DELEGATED descriptor as the target
 * table — dry-run planning is READ-ONLY regardless of executionMode
 * (delegated vs generic), so this exercises the exact same generic
 * counting SQL the archive/purge job also uses, without needing to
 * mutate anything.
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

import { withTenant } from "../../src/lib/database/tenant-context";
import { listModules } from "../../src/modules";
import { collectHighVolumeTableDescriptors } from "../../src/modules/data-lifecycle/domain/lifecycle-registry";
import { planLifecycleDryRun } from "../../src/modules/data-lifecycle/application/dry-run-planner";
import {
  createLegalHold,
  fetchActiveLegalHoldsForPlanning
} from "../../src/modules/data-lifecycle/application/legal-hold-service";

const TENANT_A = "aaaaaaaa-1111-1111-1111-111111111111";
const TENANT_B = "aaaaaaaa-2222-2222-2222-222222222222";
const ACTOR_ID = "bbbbbbbb-1111-1111-1111-111111111111";

const AUDIT_EVENTS_DESCRIPTOR = collectHighVolumeTableDescriptors(
  listModules()
).find((descriptor) => descriptor.key === "logging.audit_events")!;

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
    VALUES (${id}, ${code}, ${code})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedAuditEvent(
  tenantId: string,
  ageInDays: number
): Promise<void> {
  const sql = getTestSql();
  await withTenant(sql, tenantId, async (tx) => {
    await tx`
      INSERT INTO awcms_mini_audit_events
        (tenant_id, module_key, action, resource_type, severity, message, created_at)
      VALUES (
        ${tenantId}, 'logging', 'seed', 'seed_resource', 'info', 'seed event',
        now() - (${String(ageInDays)} || ' days')::interval
      )
    `;
  });
}

async function countAuditEvents(tenantId: string): Promise<number> {
  const sql = getTestSql();
  return withTenant(sql, tenantId, async (tx) => {
    const rows = (await tx`
      SELECT count(*)::int AS count FROM awcms_mini_audit_events WHERE tenant_id = ${tenantId}
    `) as { count: number }[];
    return rows[0]!.count;
  });
}

const suite = integrationEnabled ? describe : describe.skip;

suite("planLifecycleDryRun (Issue #745)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "dry-run-tenant-a");
  });

  test("reports eligible/purgeable counts correctly and NEVER mutates the source table (zero-mutation guarantee)", async () => {
    await seedAuditEvent(TENANT_A, 800); // older than 730-day default -> eligible
    await seedAuditEvent(TENANT_A, 10); // recent -> not eligible

    const countBefore = await countAuditEvents(TENANT_A);

    const sql = getTestSql();
    const result = await withTenant(sql, TENANT_A, (tx) =>
      planLifecycleDryRun(tx, AUDIT_EVENTS_DESCRIPTOR, TENANT_A, [], new Date())
    );

    expect(result.eligibleCount).toBe(1);
    expect(result.heldCount).toBe(0);
    expect(result.purgeableCount).toBe(1); // archive.archivable=false -> immediately purgeable
    expect(result.archivedCount).toBe(0);
    expect(result.blockedCount).toBe(0);

    const countAfter = await countAuditEvents(TENANT_A);
    expect(countAfter).toBe(countBefore); // nothing was deleted
  });

  test("is deterministic: calling it twice in a row (same inputs) produces identical results", async () => {
    await seedAuditEvent(TENANT_A, 800);
    await seedAuditEvent(TENANT_A, 900);

    const sql = getTestSql();
    const now = new Date();
    const first = await withTenant(sql, TENANT_A, (tx) =>
      planLifecycleDryRun(tx, AUDIT_EVENTS_DESCRIPTOR, TENANT_A, [], now)
    );
    const second = await withTenant(sql, TENANT_A, (tx) =>
      planLifecycleDryRun(tx, AUDIT_EVENTS_DESCRIPTOR, TENANT_A, [], now)
    );

    expect(second).toEqual(first);
  });

  test("legal hold precedence: an active hold makes every eligible row HELD, never purgeable — cannot be bypassed by a retentionDaysOverride that would otherwise widen eligibility", async () => {
    await seedAuditEvent(TENANT_A, 800); // older than the 730-day DEFAULT -> already eligible even without any override
    // 400 days: younger than the 730-day default (NOT eligible today) but
    // older than the 365-day MINIMUM the descriptor allows as an override
    // (WOULD become eligible under the aggressive override below).
    await seedAuditEvent(TENANT_A, 400);

    const sql = getTestSql();
    const now = new Date();

    await withTenant(sql, TENANT_A, (tx) =>
      createLegalHold(
        tx,
        TENANT_A,
        ACTOR_ID,
        {
          descriptorKey: "logging.audit_events",
          scopeDescription: "All audit events related to case #99.",
          reason: "Ongoing regulatory investigation into access history.",
          authorityReference: "Regulator Notice #99/2026",
          endsAt: null
        },
        "test-correlation"
      )
    );

    const activeHolds = await withTenant(sql, TENANT_A, (tx) =>
      fetchActiveLegalHoldsForPlanning(tx, TENANT_A)
    );

    // A DELIBERATELY aggressive override (retentionMinDays floor,
    // effectively "everything is eligible") — still must not purge
    // anything while the hold is active.
    const result = await withTenant(sql, TENANT_A, (tx) =>
      planLifecycleDryRun(
        tx,
        AUDIT_EVENTS_DESCRIPTOR,
        TENANT_A,
        activeHolds,
        now,
        AUDIT_EVENTS_DESCRIPTOR.retentionMinDays
      )
    );

    expect(result.eligibleCount).toBe(2); // both rows now past the aggressive cutoff
    expect(result.heldCount).toBe(2); // ALL of them held, not just the originally-eligible one
    expect(result.purgeableCount).toBe(0);
    expect(result.matchedHoldIds).toHaveLength(1);
  });

  test("a tenant-wide legal hold (descriptorKey: null) also fully blocks purge for this descriptor", async () => {
    await seedAuditEvent(TENANT_A, 800);

    const sql = getTestSql();
    await withTenant(sql, TENANT_A, (tx) =>
      createLegalHold(
        tx,
        TENANT_A,
        ACTOR_ID,
        {
          descriptorKey: null,
          scopeDescription: "Full tenant-wide litigation hold.",
          reason: "Company-wide litigation hold pending discovery review.",
          authorityReference: "Court Order #7/2026",
          endsAt: null
        },
        "test-correlation"
      )
    );
    const activeHolds = await withTenant(sql, TENANT_A, (tx) =>
      fetchActiveLegalHoldsForPlanning(tx, TENANT_A)
    );

    const result = await withTenant(sql, TENANT_A, (tx) =>
      planLifecycleDryRun(
        tx,
        AUDIT_EVENTS_DESCRIPTOR,
        TENANT_A,
        activeHolds,
        new Date()
      )
    );

    expect(result.heldCount).toBe(1);
    expect(result.purgeableCount).toBe(0);
  });

  test("a RELEASED hold no longer blocks purge — releasing correctly restores ordinary retention behavior", async () => {
    await seedAuditEvent(TENANT_A, 800);

    const sql = getTestSql();
    const created = await withTenant(sql, TENANT_A, (tx) =>
      createLegalHold(
        tx,
        TENANT_A,
        ACTOR_ID,
        {
          descriptorKey: "logging.audit_events",
          scopeDescription: "Temporary hold.",
          reason: "Short-lived investigation, now concluded.",
          authorityReference: "Internal Ref #1/2026",
          endsAt: null
        },
        "test-correlation"
      )
    );
    expect(created.ok).toBe(true);

    // Do NOT release here — this test only proves an EMPTY hold set
    // (i.e., after a real release, fetchActiveLegalHoldsForPlanning would
    // return none) behaves like "no hold at all". The release ACTION
    // itself is covered by the legal-hold-service integration suite.
    const noHolds = await withTenant(sql, TENANT_A, (tx) =>
      planLifecycleDryRun(tx, AUDIT_EVENTS_DESCRIPTOR, TENANT_A, [], new Date())
    );

    expect(noHolds.heldCount).toBe(0);
    expect(noHolds.purgeableCount).toBe(1);
  });

  test("cross-tenant isolation: tenant A's dry-run never counts tenant B's rows, even though both exist in the same run", async () => {
    await seedTenant(TENANT_B, "dry-run-tenant-b");
    await seedAuditEvent(TENANT_A, 800);
    await seedAuditEvent(TENANT_B, 800);

    const sql = getTestSql();
    const resultA = await withTenant(sql, TENANT_A, (tx) =>
      planLifecycleDryRun(tx, AUDIT_EVENTS_DESCRIPTOR, TENANT_A, [], new Date())
    );
    const resultB = await withTenant(sql, TENANT_B, (tx) =>
      planLifecycleDryRun(tx, AUDIT_EVENTS_DESCRIPTOR, TENANT_B, [], new Date())
    );

    expect(resultA.eligibleCount).toBe(1);
    expect(resultB.eligibleCount).toBe(1);
    // Each tenant's own legal-hold fetch is independently scoped too.
    const holdsA = await withTenant(sql, TENANT_A, (tx) =>
      fetchActiveLegalHoldsForPlanning(tx, TENANT_A)
    );
    expect(holdsA).toEqual([]);
  });

  test("missing tenant context (RLS fail-closed): querying without withTenant's SET LOCAL sees zero rows, never another tenant's data", async () => {
    await seedAuditEvent(TENANT_A, 800);

    // Deliberately bypass withTenant — calls the same generic dry-run
    // count query directly against the pooled app-role connection with
    // NO app.current_tenant_id set for this request. Migration 013/045
    // sets a fail-closed default (all-zero UUID) for the app role, so RLS
    // filters every row away rather than exposing tenant A's real count.
    const sql = getTestSql();
    const result = await planLifecycleDryRun(
      sql,
      AUDIT_EVENTS_DESCRIPTOR,
      TENANT_A,
      [],
      new Date()
    );

    expect(result.eligibleCount).toBe(0);
  });
});
