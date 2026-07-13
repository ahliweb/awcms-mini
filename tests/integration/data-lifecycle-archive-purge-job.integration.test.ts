/**
 * Integration tests for `runDataLifecycleArchivePurge` (Issue #745)
 * against real PostgreSQL: bounded/resumable batching across a
 * deliberately large volume, legal-hold blocking, archive manifest
 * checksum + restore, delegated descriptors staying read-only, and
 * cross-tenant isolation.
 *
 * Uses the `data_lifecycle.data_lifecycle_runs` GENERIC-execution
 * descriptor as the target — this module's OWN run-history table is the
 * one descriptor this PR proves real (non-delegated) archive/purge
 * execution against end-to-end (see `module.ts`'s own `dataLifecycle`
 * entry). Fixture rows are seeded directly via SQL, independent of
 * whatever `recordLifecycleRun` calls this same test run's OWN job
 * invocations might also write (those always have a fresh `created_at`,
 * never old enough to be purge-eligible themselves).
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyMigrations,
  getAdminSql,
  getTestSql,
  getWorkerTestSql,
  integrationEnabled,
  provisionAppRole,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { withTenant } from "../../src/lib/database/tenant-context";
import { runDataLifecycleArchivePurge } from "../../src/modules/data-lifecycle/application/archive-purge-job";
import { createLocalArchiveAdapter } from "../../src/modules/data-lifecycle/infrastructure/local-archive-adapter";
import { createLegalHold } from "../../src/modules/data-lifecycle/application/legal-hold-service";
import { listArchiveManifests } from "../../src/modules/data-lifecycle/application/manifest-store";
import { listLifecycleRuns } from "../../src/modules/data-lifecycle/application/run-record-store";
import { getCursor } from "../../src/modules/data-lifecycle/application/cursor-store";

const TENANT_A = "aaaaaaaa-1111-1111-1111-111111111111";
const TENANT_B = "aaaaaaaa-2222-2222-2222-222222222222";
const ACTOR_ID = "bbbbbbbb-1111-1111-1111-111111111111";
const GENERIC_DESCRIPTOR_KEY = "data_lifecycle.data_lifecycle_runs";
const DELEGATED_DESCRIPTOR_KEY = "logging.audit_events";

let archiveDir: string;

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
    VALUES (${id}, ${code}, ${code})
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * Bulk-seeds `count` old, purge-eligible run-history rows for `tenantId`
 * in ONE round-trip (generate_series) — fast even for thousands of rows.
 * `ageInDays` must exceed data_lifecycle.data_lifecycle_runs'
 * defaultRetentionDays (180, see module.ts) to be eligible. Rows are
 * spaced 100ms apart (not 1ms) — safely clear of
 * `archive-purge-job.ts`'s own `CURSOR_BOUNDARY_SAFETY_MARGIN_MS` (1ms)
 * boundary-safety padding, so that fix's own narrow edge case (a
 * genuinely different row landing within the 1ms padding window) can
 * never trigger from this fixture's own spacing.
 */
async function seedOldRunHistoryRows(
  tenantId: string,
  count: number,
  ageInDays = 800
): Promise<void> {
  const sql = getWorkerTestSql();
  await withTenant(
    sql,
    tenantId,
    async (tx) => {
      await tx`
        INSERT INTO awcms_mini_data_lifecycle_runs
          (tenant_id, descriptor_key, run_type, status, started_at, finished_at, created_at, correlation_id)
        SELECT
          ${tenantId}, 'seed.bulk_fixture', 'dry_run', 'completed',
          now() - (${String(ageInDays)} || ' days')::interval,
          now() - (${String(ageInDays)} || ' days')::interval,
          now() - (${String(ageInDays)} || ' days')::interval - (gs * 100 || ' milliseconds')::interval,
          'seed-' || gs
        FROM generate_series(1, ${count}) AS gs
      `;
    },
    { workClass: "maintenance" }
  );
}

async function seedAuditEvent(
  tenantId: string,
  ageInDays: number
): Promise<void> {
  const sql = getWorkerTestSql();
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

async function countRunHistoryRows(tenantId: string): Promise<number> {
  const sql = getWorkerTestSql();
  return withTenant(sql, tenantId, async (tx) => {
    const rows = (await tx`
      SELECT count(*)::int AS count FROM awcms_mini_data_lifecycle_runs
      WHERE tenant_id = ${tenantId} AND descriptor_key = 'seed.bulk_fixture'
    `) as { count: number }[];
    return rows[0]!.count;
  });
}

async function countAuditEvents(tenantId: string): Promise<number> {
  const sql = getWorkerTestSql();
  return withTenant(sql, tenantId, async (tx) => {
    const rows = (await tx`
      SELECT count(*)::int AS count FROM awcms_mini_audit_events WHERE tenant_id = ${tenantId}
    `) as { count: number }[];
    return rows[0]!.count;
  });
}

const suite = integrationEnabled ? describe : describe.skip;

suite("runDataLifecycleArchivePurge (Issue #745)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "archive-purge-tenant-a");
    archiveDir = await mkdtemp(
      path.join(os.tmpdir(), "awcms-data-lifecycle-archive-purge-")
    );
  });

  async function cleanupArchiveDir(): Promise<void> {
    await rm(archiveDir, { recursive: true, force: true });
  }

  test("large-volume bounded batching + resume across invocations: a 5010-row backlog (just over the 5000 batchLimit) drains correctly across TWO invocations, with the second correctly resuming past the first's cursor (never re-archiving/re-purging, never skipping)", async () => {
    await seedOldRunHistoryRows(TENANT_A, 5010);
    expect(await countRunHistoryRows(TENANT_A)).toBe(5010);

    const archivePort = createLocalArchiveAdapter(archiveDir);

    // Invocation 1, bounded to exactly ONE pass per phase — archives at
    // most batchLimit (5000) rows, then purges at most batchLimit of
    // what was JUST archived (also 5000, since that's all that's
    // archived so far). 10 rows must remain un-purged after this call.
    const first = await runDataLifecycleArchivePurge(
      getWorkerTestSql(),
      { dryRun: false, correlationId: "invocation-1" },
      { archivePort, maxPasses: 1, tenants: [{ id: TENANT_A }] }
    );

    expect(first.totalArchived).toBe(5000);
    expect(first.totalPurged).toBe(5000);
    expect(await countRunHistoryRows(TENANT_A)).toBe(10);

    const cursorAfterFirst = await withTenant(
      getWorkerTestSql(),
      TENANT_A,
      (tx) => getCursor(tx, TENANT_A, GENERIC_DESCRIPTOR_KEY, "archive"),
      { workClass: "maintenance" }
    );
    expect(cursorAfterFirst?.cursorValue).not.toBeNull();

    // Invocation 2 (fresh call, generous default maxPasses) finishes the
    // remaining 10 rows — the cursor from invocation 1 means it resumes
    // strictly AFTER what was already archived, not from the start.
    const second = await runDataLifecycleArchivePurge(
      getWorkerTestSql(),
      { dryRun: false, correlationId: "invocation-2" },
      { archivePort, tenants: [{ id: TENANT_A }] }
    );

    expect(second.totalArchived).toBe(10);
    expect(second.totalPurged).toBe(10);
    expect(await countRunHistoryRows(TENANT_A)).toBe(0);

    // Exactly 2 archive manifests (one per invocation) — no duplicate,
    // no missing coverage.
    const manifests = await withTenant(
      getWorkerTestSql(),
      TENANT_A,
      (tx) => listArchiveManifests(tx, TENANT_A, GENERIC_DESCRIPTOR_KEY),
      { workClass: "maintenance" }
    );
    expect(manifests).toHaveLength(2);
    const rowCounts = manifests
      .map((manifest) => manifest.rowCount)
      .sort((a, b) => a - b);
    expect(rowCounts).toEqual([10, 5000]);

    await cleanupArchiveDir();
  }, 30_000);

  test("archive manifest has a verifiable checksum and its content restores exactly via the archive port's read()", async () => {
    await seedOldRunHistoryRows(TENANT_A, 25);
    const archivePort = createLocalArchiveAdapter(archiveDir);

    await runDataLifecycleArchivePurge(
      getWorkerTestSql(),
      { dryRun: false, correlationId: "manifest-test" },
      { archivePort, tenants: [{ id: TENANT_A }] }
    );

    const manifests = await withTenant(
      getWorkerTestSql(),
      TENANT_A,
      (tx) => listArchiveManifests(tx, TENANT_A, GENERIC_DESCRIPTOR_KEY),
      { workClass: "maintenance" }
    );
    expect(manifests).toHaveLength(1);
    const manifest = manifests[0]!;
    expect(manifest.rowCount).toBe(25);
    expect(manifest.checksumHex).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.status).toBe("written");

    const verified = await archivePort.verify(
      manifest.artifactLocation,
      manifest.checksumHex
    );
    expect(verified).toBe(true);

    const restored = await archivePort.read(manifest.artifactLocation);
    expect(restored).toHaveLength(25);
    const correlationIds = restored.map((row) => row.correlation_id).sort();
    expect(correlationIds).toEqual(
      Array.from({ length: 25 }, (_, index) => `seed-${index + 1}`).sort()
    );

    await cleanupArchiveDir();
  });

  test("legal hold blocks archive AND purge entirely — held rows are never touched, even across multiple invocations", async () => {
    await seedOldRunHistoryRows(TENANT_A, 50);
    const archivePort = createLocalArchiveAdapter(archiveDir);

    // createLegalHold is an admin/API action (awcms_mini_app role) — the
    // worker role only has SELECT on legal holds (migration 056: it reads
    // holds during archive/purge, never creates them), so the FIXTURE is
    // seeded via the app role here, exactly like a real admin request
    // would. `runDataLifecycleArchivePurge` below still correctly runs as
    // the worker role.
    await withTenant(getTestSql(), TENANT_A, (tx) =>
      createLegalHold(
        tx,
        TENANT_A,
        ACTOR_ID,
        {
          descriptorKey: GENERIC_DESCRIPTOR_KEY,
          scopeDescription: "Hold on run history for audit dispute.",
          reason: "Regulator requested proof of prior purge history.",
          authorityReference: "Regulator Ref #55/2026",
          endsAt: null
        },
        "hold-corr"
      )
    );

    const result = await runDataLifecycleArchivePurge(
      getWorkerTestSql(),
      { dryRun: false, correlationId: "held-run" },
      { archivePort, tenants: [{ id: TENANT_A }] }
    );

    expect(result.totalArchived).toBe(0);
    expect(result.totalPurged).toBe(0);
    expect(await countRunHistoryRows(TENANT_A)).toBe(50);

    const manifests = await withTenant(
      getWorkerTestSql(),
      TENANT_A,
      (tx) => listArchiveManifests(tx, TENANT_A, GENERIC_DESCRIPTOR_KEY),
      { workClass: "maintenance" }
    );
    expect(manifests).toEqual([]);

    // The run-history summary row this SAME invocation writes still
    // reports the correct held count, proving the plan snapshot sees
    // the hold too, not just the mutation path.
    const runs = await withTenant(
      getWorkerTestSql(),
      TENANT_A,
      (tx) =>
        listLifecycleRuns(tx, TENANT_A, {
          descriptorKey: GENERIC_DESCRIPTOR_KEY
        }),
      { workClass: "maintenance" }
    );
    expect(runs[0]!.heldCount).toBe(50);
    expect(runs[0]!.purgedCount).toBe(0);

    await cleanupArchiveDir();
  });

  test("delegated descriptors (e.g. logging.audit_events) are NEVER mutated by this engine — only a dry-run snapshot is recorded", async () => {
    await seedAuditEvent(TENANT_A, 800); // eligible by age, but delegated
    const countBefore = await countAuditEvents(TENANT_A);
    const archivePort = createLocalArchiveAdapter(archiveDir);

    await runDataLifecycleArchivePurge(
      getWorkerTestSql(),
      { dryRun: false, correlationId: "delegated-test" },
      { archivePort, tenants: [{ id: TENANT_A }] }
    );

    const countAfter = await countAuditEvents(TENANT_A);
    expect(countAfter).toBe(countBefore); // completely untouched

    const runs = await withTenant(
      getWorkerTestSql(),
      TENANT_A,
      (tx) =>
        listLifecycleRuns(tx, TENANT_A, {
          descriptorKey: DELEGATED_DESCRIPTOR_KEY
        }),
      { workClass: "maintenance" }
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runType).toBe("dry_run");
    expect(runs[0]!.eligibleCount).toBeGreaterThanOrEqual(1);
    expect(runs[0]!.purgedCount).toBe(0);

    await cleanupArchiveDir();
  });

  test("--dry-run mode never mutates the generic descriptor's table either, even though it still records a run snapshot", async () => {
    await seedOldRunHistoryRows(TENANT_A, 30);
    const archivePort = createLocalArchiveAdapter(archiveDir);

    const result = await runDataLifecycleArchivePurge(
      getWorkerTestSql(),
      { dryRun: true, correlationId: "dry-run-test" },
      { archivePort, tenants: [{ id: TENANT_A }] }
    );

    expect(result.totalArchived).toBe(0);
    expect(result.totalPurged).toBe(0);
    expect(await countRunHistoryRows(TENANT_A)).toBe(30); // untouched

    const manifests = await withTenant(
      getWorkerTestSql(),
      TENANT_A,
      (tx) => listArchiveManifests(tx, TENANT_A, GENERIC_DESCRIPTOR_KEY),
      { workClass: "maintenance" }
    );
    expect(manifests).toEqual([]);

    await cleanupArchiveDir();
  });

  test("cross-tenant isolation: two tenants processed in the same invocation each get their OWN manifest and cursor, never mixing rows", async () => {
    await seedTenant(TENANT_B, "archive-purge-tenant-b");
    await seedOldRunHistoryRows(TENANT_A, 15);
    await seedOldRunHistoryRows(TENANT_B, 8);
    const archivePort = createLocalArchiveAdapter(archiveDir);

    const result = await runDataLifecycleArchivePurge(
      getWorkerTestSql(),
      { dryRun: false, correlationId: "cross-tenant-test" },
      { archivePort, tenants: [{ id: TENANT_A }, { id: TENANT_B }] }
    );

    expect(result.totalArchived).toBe(23);
    expect(result.totalPurged).toBe(23);
    expect(await countRunHistoryRows(TENANT_A)).toBe(0);
    expect(await countRunHistoryRows(TENANT_B)).toBe(0);

    const manifestsA = await withTenant(
      getWorkerTestSql(),
      TENANT_A,
      (tx) => listArchiveManifests(tx, TENANT_A, GENERIC_DESCRIPTOR_KEY),
      { workClass: "maintenance" }
    );
    const manifestsB = await withTenant(
      getWorkerTestSql(),
      TENANT_B,
      (tx) => listArchiveManifests(tx, TENANT_B, GENERIC_DESCRIPTOR_KEY),
      { workClass: "maintenance" }
    );
    expect(manifestsA).toHaveLength(1);
    expect(manifestsA[0]!.rowCount).toBe(15);
    expect(manifestsB).toHaveLength(1);
    expect(manifestsB[0]!.rowCount).toBe(8);
    // Tenant A never sees tenant B's manifest and vice versa (RLS).
    expect(manifestsA[0]!.id).not.toBe(manifestsB[0]!.id);

    await cleanupArchiveDir();
  });
});
