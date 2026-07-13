/**
 * Integration tests for the legal hold service (Issue #745) against real
 * PostgreSQL: create/list/release, default-deny release (not_found /
 * already_released outcomes, reason-required), audit trail, and
 * cross-tenant isolation.
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
import {
  createLegalHold,
  listLegalHolds,
  releaseLegalHold
} from "../../src/modules/data-lifecycle/application/legal-hold-service";

const TENANT_A = "aaaaaaaa-1111-1111-1111-111111111111";
const TENANT_B = "aaaaaaaa-2222-2222-2222-222222222222";
const ACTOR_ID = "bbbbbbbb-1111-1111-1111-111111111111";

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
    VALUES (${id}, ${code}, ${code})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function fetchAuditActions(tenantId: string): Promise<string[]> {
  const sql = getTestSql();
  return withTenant(sql, tenantId, async (tx) => {
    const rows = (await tx`
      SELECT action FROM awcms_mini_audit_events
      WHERE tenant_id = ${tenantId} AND module_key = 'data_lifecycle'
      ORDER BY created_at
    `) as { action: string }[];
    return rows.map((row) => row.action);
  });
}

const VALID_HOLD_INPUT = {
  descriptorKey: "logging.audit_events",
  scopeDescription: "All audit events for case #42.",
  reason: "Ongoing internal investigation, evidence preservation required.",
  authorityReference: "Internal Legal Ref #42/2026",
  endsAt: null
};

const suite = integrationEnabled ? describe : describe.skip;

suite("legal-hold-service (Issue #745)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "legal-hold-tenant-a");
  });

  test("create: succeeds, returns an active hold, and writes a critical audit event", async () => {
    const sql = getTestSql();
    const result = await withTenant(sql, TENANT_A, (tx) =>
      createLegalHold(tx, TENANT_A, ACTOR_ID, VALID_HOLD_INPUT, "corr-1")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hold.status).toBe("active");
    expect(result.hold.requestedBy).toBe(ACTOR_ID);
    expect(result.hold.descriptorKey).toBe("logging.audit_events");

    const actions = await fetchAuditActions(TENANT_A);
    expect(actions).toContain("create");
  });

  test("create: rejects an invalid input (short reason) with NO row inserted and no audit event", async () => {
    const sql = getTestSql();
    const result = await withTenant(sql, TENANT_A, (tx) =>
      createLegalHold(
        tx,
        TENANT_A,
        ACTOR_ID,
        { ...VALID_HOLD_INPUT, reason: "short" },
        "corr-2"
      )
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.field === "reason")).toBe(true);

    const holds = await withTenant(sql, TENANT_A, (tx) =>
      listLegalHolds(tx, TENANT_A)
    );
    expect(holds).toEqual([]);
    const actions = await fetchAuditActions(TENANT_A);
    expect(actions).toEqual([]);
  });

  test("release: succeeds for an active hold, sets released_by/releasedAt/releaseReason, writes a critical audit event", async () => {
    const sql = getTestSql();
    const created = await withTenant(sql, TENANT_A, (tx) =>
      createLegalHold(tx, TENANT_A, ACTOR_ID, VALID_HOLD_INPUT, "corr-3")
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const released = await withTenant(sql, TENANT_A, (tx) =>
      releaseLegalHold(
        tx,
        TENANT_A,
        ACTOR_ID,
        created.hold.id,
        { releaseReason: "Investigation concluded, hold no longer required." },
        "corr-4"
      )
    );

    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.hold.status).toBe("released");
    expect(released.hold.releasedBy).toBe(ACTOR_ID);
    expect(released.hold.releasedAt).not.toBeNull();
    expect(released.hold.releaseReason).toBe(
      "Investigation concluded, hold no longer required."
    );

    const actions = await fetchAuditActions(TENANT_A);
    expect(actions).toContain("release");
  });

  test("release: default-deny — releasing a NON-EXISTENT hold returns not_found, never a silent success", async () => {
    const sql = getTestSql();
    const result = await withTenant(sql, TENANT_A, (tx) =>
      releaseLegalHold(
        tx,
        TENANT_A,
        ACTOR_ID,
        "00000000-0000-0000-0000-000000000000",
        {
          releaseReason: "Attempting to release something that doesn't exist."
        },
        "corr-5"
      )
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  test("release: releasing an ALREADY-RELEASED hold returns already_released, never double-releases", async () => {
    const sql = getTestSql();
    const created = await withTenant(sql, TENANT_A, (tx) =>
      createLegalHold(tx, TENANT_A, ACTOR_ID, VALID_HOLD_INPUT, "corr-6")
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const firstRelease = await withTenant(sql, TENANT_A, (tx) =>
      releaseLegalHold(
        tx,
        TENANT_A,
        ACTOR_ID,
        created.hold.id,
        { releaseReason: "First release, legitimate." },
        "corr-7"
      )
    );
    expect(firstRelease.ok).toBe(true);

    const secondRelease = await withTenant(sql, TENANT_A, (tx) =>
      releaseLegalHold(
        tx,
        TENANT_A,
        ACTOR_ID,
        created.hold.id,
        { releaseReason: "Attempting to release it again." },
        "corr-8"
      )
    );

    expect(secondRelease.ok).toBe(false);
    if (secondRelease.ok) return;
    expect(secondRelease.reason).toBe("already_released");
  });

  test("release: rejects an invalid input (missing releaseReason) — reason-required applies to release too", async () => {
    const sql = getTestSql();
    const created = await withTenant(sql, TENANT_A, (tx) =>
      createLegalHold(tx, TENANT_A, ACTOR_ID, VALID_HOLD_INPUT, "corr-9")
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await withTenant(sql, TENANT_A, (tx) =>
      releaseLegalHold(
        tx,
        TENANT_A,
        ACTOR_ID,
        created.hold.id,
        { releaseReason: "" },
        "corr-10"
      )
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("validation");
  });

  test("cross-tenant isolation: tenant A cannot see or release tenant B's legal hold", async () => {
    await seedTenant(TENANT_B, "legal-hold-tenant-b");
    const sql = getTestSql();

    const createdForB = await withTenant(sql, TENANT_B, (tx) =>
      createLegalHold(tx, TENANT_B, ACTOR_ID, VALID_HOLD_INPUT, "corr-11")
    );
    expect(createdForB.ok).toBe(true);
    if (!createdForB.ok) return;

    // Tenant A's list never includes tenant B's hold.
    const holdsForA = await withTenant(sql, TENANT_A, (tx) =>
      listLegalHolds(tx, TENANT_A)
    );
    expect(holdsForA).toEqual([]);

    // Tenant A cannot release tenant B's hold by id (RLS scopes the SELECT
    // inside releaseLegalHold to tenant A's own rows, so it reports
    // not_found rather than leaking existence or succeeding).
    const releaseAttempt = await withTenant(sql, TENANT_A, (tx) =>
      releaseLegalHold(
        tx,
        TENANT_A,
        ACTOR_ID,
        createdForB.hold.id,
        { releaseReason: "Attempting cross-tenant release." },
        "corr-12"
      )
    );
    expect(releaseAttempt.ok).toBe(false);
    if (releaseAttempt.ok) return;
    expect(releaseAttempt.reason).toBe("not_found");

    // Tenant B's hold is untouched.
    const holdsForB = await withTenant(sql, TENANT_B, (tx) =>
      listLegalHolds(tx, TENANT_B)
    );
    expect(holdsForB).toHaveLength(1);
    expect(holdsForB[0]!.status).toBe("active");
  });

  test("list: supports filtering by status and descriptorKey, and always includes tenant-wide holds", async () => {
    const sql = getTestSql();
    await withTenant(sql, TENANT_A, (tx) =>
      createLegalHold(tx, TENANT_A, ACTOR_ID, VALID_HOLD_INPUT, "corr-13")
    );
    await withTenant(sql, TENANT_A, (tx) =>
      createLegalHold(
        tx,
        TENANT_A,
        ACTOR_ID,
        {
          ...VALID_HOLD_INPUT,
          descriptorKey: null,
          scopeDescription: "Tenant-wide hold."
        },
        "corr-14"
      )
    );

    const scoped = await withTenant(sql, TENANT_A, (tx) =>
      listLegalHolds(tx, TENANT_A, { descriptorKey: "logging.audit_events" })
    );
    // Both the descriptor-specific hold AND the tenant-wide hold match.
    expect(scoped).toHaveLength(2);

    const unrelated = await withTenant(sql, TENANT_A, (tx) =>
      listLegalHolds(tx, TENANT_A, { descriptorKey: "form_drafts.form_drafts" })
    );
    // Only the tenant-wide hold matches an unrelated descriptor key.
    expect(unrelated).toHaveLength(1);
    expect(unrelated[0]!.descriptorKey).toBeNull();

    const activeOnly = await withTenant(sql, TENANT_A, (tx) =>
      listLegalHolds(tx, TENANT_A, { status: "active" })
    );
    expect(activeOnly).toHaveLength(2);
  });
});
