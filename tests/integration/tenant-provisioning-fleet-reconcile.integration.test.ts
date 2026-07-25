/**
 * Integration tests for the fleet-wide provisioning reconciliation pass
 * (Issue #930, epic #868) against real PostgreSQL.
 *
 * ## What only a real database can prove here
 *
 * The scheduling policy is unit-tested without a database
 * (`tests/unit/tenant-provisioning-fleet-reconciliation.test.ts`). What is
 * left is the part that cannot be faked: whether the least-privilege
 * `awcms_mini_worker` role can actually run a reconciliation, and — just as
 * important — whether migration 105 stopped there.
 *
 * Every write below runs as the REAL worker role, not the admin connection, so
 * a missing grant fails this suite instead of production. A superuser
 * `DATABASE_URL` would bypass both the grants and RLS FORCE and turn all of
 * this green regardless, which is exactly the failure mode the harness's
 * `provisionWorkerRole()` exists to prevent.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

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
import {
  applyTenantConfiguration,
  createHeadOffice,
  createTenantOwner,
  createTenantRecordIfAbsent,
  initializeTenantSettings,
  setTenantStatus
} from "../../src/modules/tenant-admin/application/tenant-onboarding";
import {
  reconcileProvisioning,
  requestProvisioning,
  runProvisioning,
  type ProvisioningEngineDeps,
  type ProvisioningOnboardingDeps
} from "../../src/modules/tenant-provisioning/application/provisioning-orchestrator";
import {
  classifyTenantForReconcile,
  selectDueTenants,
  staleBefore
} from "../../src/modules/tenant-provisioning/application/fleet-reconciliation";
import {
  findRequestByTenant,
  loadTimeline
} from "../../src/modules/tenant-provisioning/application/provisioning-directory";
import { resetContributedProvisioningPlans } from "../../src/modules/tenant-provisioning/domain/provisioning-plan";
import { resetContributedProvisioningSteps } from "../../src/modules/tenant-provisioning/infrastructure/step-handler-registry";
import type { ProvisioningRequestInput } from "../../src/modules/tenant-provisioning/domain/request-validation";

const OPERATOR = "00000000-0000-0000-0000-0000000000aa";

async function verifyOwnerControls(
  tx: Bun.SQL,
  tenantId: string
): Promise<{ ready: boolean; missing: string[] }> {
  const rows = (await tx`
    SELECT count(*)::int AS c
    FROM awcms_mini_tenant_users tu
    WHERE tu.tenant_id = ${tenantId}
  `) as { c: number }[];
  return Number(rows[0]!.c) > 0
    ? { ready: true, missing: [] }
    : { ready: false, missing: ["owner"] };
}

const onboarding: ProvisioningOnboardingDeps = {
  createTenantIfAbsent: (tx, input) =>
    createTenantRecordIfAbsent(tx, {
      tenantCode: input.tenantCode,
      tenantName: input.tenantName,
      legalName: input.legalName ?? undefined,
      status: "inactive",
      createdBy: input.createdBy
    }),
  initTenantSettings: (tx, tenantId) => initializeTenantSettings(tx, tenantId),
  createHeadOffice: (tx, tenantId, input) =>
    createHeadOffice(tx, tenantId, {
      officeCode: input.officeCode,
      officeName: input.officeName,
      createdBy: input.createdBy
    }),
  createOwner: (tx, tenantId, input) =>
    createTenantOwner(tx, tenantId, {
      ownerDisplayName: input.ownerDisplayName,
      ownerLoginIdentifier: input.ownerLoginIdentifier,
      ownerPassword: input.ownerPassword,
      createdBy: input.createdBy
    })
};

const engineDeps: ProvisioningEngineDeps = {
  onboarding,
  steps: {
    applyConfiguration: (tx, tenantId, config) =>
      applyTenantConfiguration(tx, tenantId, {
        defaultLocale: config.locale ?? undefined,
        defaultTheme: config.theme ?? undefined,
        timezone: config.timezone ?? undefined
      }),
    setTenantActive: (tx, tenantId, actor) =>
      setTenantStatus(tx, tenantId, "active", actor),
    verifyMandatoryControls: verifyOwnerControls
  }
};

let codeSeq = 0;
function makeInput(): ProvisioningRequestInput {
  codeSeq += 1;
  return {
    planKey: "standard_tenant",
    planVersion: 1,
    tenantCode: `fr${Date.now().toString(36)}${codeSeq}`.toLowerCase(),
    tenantName: "Fleet Recon",
    legalName: null,
    owner: {
      displayName: "Owner",
      loginIdentifier: `fleetowner${codeSeq}@acme.test`,
      password: "fixture_owner_password_not_a_real_secret"
    },
    officeCode: "ho",
    officeName: "Head Office",
    options: {
      defaultLocale: "id",
      defaultTheme: null,
      timezone: null,
      subdomain: null,
      presetKey: null,
      offerPlanKey: null,
      offerVersion: null
    }
  };
}

/** Provision a tenant all the way to `provisioned` + active, as the app role. */
async function provisionTenant(key: string): Promise<string> {
  const sql = getTestSql();
  const requested = await sql.begin((tx: Bun.SQL) =>
    requestProvisioning(
      tx,
      { actorTenantUserId: OPERATOR, idempotencyKey: key },
      makeInput(),
      onboarding
    )
  );
  if (!requested.ok) {
    throw new Error(`request failed: ${JSON.stringify(requested)}`);
  }

  const { tenantId, id: requestId } = requested.request;
  const run = await runProvisioning(
    sql,
    tenantId,
    requestId,
    { actorTenantUserId: OPERATOR, leaseOwner: "w" },
    engineDeps
  );
  if (!run.ok) throw new Error(`run failed: ${JSON.stringify(run)}`);
  return tenantId;
}

/**
 * The composition-root loop from `scripts/tenant-provisioning-fleet-reconcile.ts`,
 * reproduced over an explicit tenant list so the test exercises the same
 * two-phase shape (probe → select stalest → reconcile) without depending on
 * whatever else is in `awcms_mini_tenants`.
 */
async function fleetPass(
  tenantIds: readonly string[],
  ctx: { now: Date; maxTenants: number }
): Promise<{ reconciled: string[]; deferred: string[]; skipped: string[] }> {
  const sql = getWorkerTestSql();
  const cutoff = staleBefore(ctx.now);
  const due: {
    tenantId: string;
    requestId: string;
    lastReconciledAt: string | null;
  }[] = [];
  const skipped: string[] = [];

  for (const tenantId of tenantIds) {
    const request = await withTenant(
      sql,
      tenantId,
      (tx) => findRequestByTenant(tx, tenantId),
      { workClass: "maintenance" }
    );
    const verdict = classifyTenantForReconcile(request, {
      staleBefore: cutoff
    });
    if (verdict.action === "skip") {
      skipped.push(tenantId);
      continue;
    }
    due.push({
      tenantId,
      requestId: verdict.request.id,
      lastReconciledAt: verdict.request.lastReconciledAt
    });
  }

  const { selected, deferred } = selectDueTenants(due, ctx.maxTenants);
  const reconciled: string[] = [];

  for (const candidate of selected) {
    const outcome = await reconcileProvisioning(
      sql,
      candidate.tenantId,
      candidate.requestId,
      { actorTenantUserId: null, correlationId: "fleet-test" }
    );
    if (!outcome.ok)
      throw new Error(`reconcile failed for ${candidate.tenantId}`);
    reconciled.push(candidate.tenantId);
  }

  return {
    reconciled,
    deferred: deferred.map((c) => c.tenantId),
    skipped
  };
}

async function reconciliationCount(tenantId: string): Promise<number> {
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT count(*)::int AS c
    FROM awcms_mini_tenant_provisioning_reconciliations
    WHERE tenant_id = ${tenantId}
  `) as { c: number }[];
  return Number(rows[0]!.c);
}

const suite = integrationEnabled ? describe : describe.skip;

suite("tenant_provisioning — fleet-wide reconciliation", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });
  beforeEach(async () => {
    await resetDatabase();
    resetContributedProvisioningPlans();
    resetContributedProvisioningSteps();
  });
  afterEach(() => {
    resetContributedProvisioningPlans();
    resetContributedProvisioningSteps();
  });

  test("the worker role can run a reconciliation end to end (migration 105 grants suffice)", async () => {
    const tenantId = await provisionTenant("fleet-k1");

    const outcome = await fleetPass([tenantId], {
      now: new Date(),
      maxTenants: 10
    });

    expect(outcome.reconciled).toEqual([tenantId]);
    expect(await reconciliationCount(tenantId)).toBe(1);

    // The pass recorded itself: the request is back in `provisioned` and
    // carries a `last_reconciled_at`. Without both, an operator cannot tell
    // "reconciled, no drift" from "never reconciled".
    await withTenant(getTestSql(), tenantId, async (tx) => {
      const request = await findRequestByTenant(tx, tenantId);
      expect(request!.status).toBe("provisioned");
      expect(request!.lastReconciledAt).not.toBeNull();
    });
  });

  test("a freshly reconciled tenant is skipped by the next pass, and due again once the interval elapses", async () => {
    const tenantId = await provisionTenant("fleet-k2");
    const now = new Date();

    await fleetPass([tenantId], { now, maxTenants: 10 });
    expect(await reconciliationCount(tenantId)).toBe(1);

    // Immediately again: still fresh, so no second reconciliation row.
    const second = await fleetPass([tenantId], { now, maxTenants: 10 });
    expect(second.reconciled).toEqual([]);
    expect(second.skipped).toEqual([tenantId]);
    expect(await reconciliationCount(tenantId)).toBe(1);

    // A day later it is due again.
    const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const third = await fleetPass([tenantId], { now: later, maxTenants: 10 });
    expect(third.reconciled).toEqual([tenantId]);
    expect(await reconciliationCount(tenantId)).toBe(2);
  });

  test("the per-run budget spends on the stalest tenant and defers the rest — nothing is stranded", async () => {
    const a = await provisionTenant("fleet-k3a");
    const b = await provisionTenant("fleet-k3b");
    const now = new Date();

    // Pass 1, budget 1: both are never-reconciled, so one wins and one is
    // deferred (never dropped).
    const first = await fleetPass([a, b], { now, maxTenants: 1 });
    expect(first.reconciled.length).toBe(1);
    expect(first.deferred.length).toBe(1);
    const firstWinner = first.reconciled[0]!;
    const firstLoser = first.deferred[0]!;

    // Pass 2, same budget, a day later: the tenant that lost is now the
    // stalest (never reconciled at all) and must win. Under the rejected
    // enumeration-order design the same tenant would win twice and the other
    // would never be reconciled.
    const second = await fleetPass([a, b], {
      now: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      maxTenants: 1
    });
    expect(second.reconciled).toEqual([firstLoser]);
    expect(await reconciliationCount(firstWinner)).toBe(1);
    expect(await reconciliationCount(firstLoser)).toBe(1);
  });

  test("a tenant that is not provisioned is skipped rather than reconciled", async () => {
    const sql = getTestSql();
    const requested = await sql.begin((tx: Bun.SQL) =>
      requestProvisioning(
        tx,
        { actorTenantUserId: OPERATOR, idempotencyKey: "fleet-k4" },
        makeInput(),
        onboarding
      )
    );
    if (!requested.ok) throw new Error("request failed");
    const tenantId = requested.request.tenantId;

    const outcome = await fleetPass([tenantId], {
      now: new Date(),
      maxTenants: 10
    });

    expect(outcome.reconciled).toEqual([]);
    expect(outcome.skipped).toEqual([tenantId]);
    expect(await reconciliationCount(tenantId)).toBe(0);
  });

  test("reconciling changes nothing about what was provisioned — it only records an observation", async () => {
    const tenantId = await provisionTenant("fleet-k5");

    const before = await withTenant(getTestSql(), tenantId, (tx) =>
      loadTimeline(tx, tenantId)
    );
    const beforeSteps = before!.steps
      .map((s) => `${s.stepKey}:${s.status}`)
      .sort();

    await fleetPass([tenantId], { now: new Date(), maxTenants: 10 });

    const after = await withTenant(getTestSql(), tenantId, (tx) =>
      loadTimeline(tx, tenantId)
    );
    const afterSteps = after!.steps
      .map((s) => `${s.stepKey}:${s.status}`)
      .sort();

    // The steps, results, and compensations are the state the pass MEASURES.
    // A reconciler that edited them could only hide drift, never detect it.
    expect(afterSteps).toEqual(beforeSteps);
    expect(after!.results.length).toBe(before!.results.length);
    expect(after!.compensations.length).toBe(before!.compensations.length);
    // The one thing that did change: an observation was appended.
    expect(after!.reconciliations.length).toBe(
      before!.reconciliations.length + 1
    );
  });

  test("migration 105 stops at what the pass needs — the worker cannot create or destroy a provisioning run", async () => {
    const tenantId = await provisionTenant("fleet-k6");
    const worker = getWorkerTestSql();

    // INSERT: a scheduled job that could conjure a provisioning request would
    // be able to enrol tenants nobody asked for.
    let insertError: unknown = null;
    try {
      await withTenant(worker, tenantId, async (tx) => {
        await tx`
          INSERT INTO awcms_mini_tenant_provisioning_requests
            (tenant_id, plan_key, plan_version, status, total_steps, completed_steps)
          VALUES (${tenantId}, 'standard_tenant', 1, 'requested', 1, 0)
        `;
      });
    } catch (error) {
      insertError = error;
    }
    expect(insertError).not.toBeNull();
    expect(String(insertError)).toContain("permission denied");

    // DELETE: the request row is the provenance record for what was
    // provisioned and when.
    let deleteError: unknown = null;
    try {
      await withTenant(worker, tenantId, async (tx) => {
        await tx`
          DELETE FROM awcms_mini_tenant_provisioning_requests
          WHERE tenant_id = ${tenantId}
        `;
      });
    } catch (error) {
      deleteError = error;
    }
    expect(deleteError).not.toBeNull();
    expect(String(deleteError)).toContain("permission denied");
  });

  test("the worker cannot edit the state it measures — steps and results are read-only to it", async () => {
    const tenantId = await provisionTenant("fleet-k7");
    const worker = getWorkerTestSql();

    let stepError: unknown = null;
    try {
      await withTenant(worker, tenantId, async (tx) => {
        await tx`
          UPDATE awcms_mini_tenant_provisioning_steps
          SET status = 'completed'
          WHERE tenant_id = ${tenantId}
        `;
      });
    } catch (error) {
      stepError = error;
    }
    expect(stepError).not.toBeNull();
    expect(String(stepError)).toContain("permission denied");

    let resultError: unknown = null;
    try {
      await withTenant(worker, tenantId, async (tx) => {
        await tx`
          DELETE FROM awcms_mini_tenant_provisioning_results
          WHERE tenant_id = ${tenantId}
        `;
      });
    } catch (error) {
      resultError = error;
    }
    expect(resultError).not.toBeNull();
    expect(String(resultError)).toContain("permission denied");
  });

  test("a reconciliation observation cannot be revised or erased once written", async () => {
    const tenantId = await provisionTenant("fleet-k8");
    await fleetPass([tenantId], { now: new Date(), maxTenants: 10 });
    const worker = getWorkerTestSql();

    let updateError: unknown = null;
    try {
      await withTenant(worker, tenantId, async (tx) => {
        await tx`
          UPDATE awcms_mini_tenant_provisioning_reconciliations
          SET status = 'consistent', drift_count = 0
          WHERE tenant_id = ${tenantId}
        `;
      });
    } catch (error) {
      updateError = error;
    }
    expect(updateError).not.toBeNull();
    expect(String(updateError)).toContain("permission denied");

    let deleteError: unknown = null;
    try {
      await withTenant(worker, tenantId, async (tx) => {
        await tx`
          DELETE FROM awcms_mini_tenant_provisioning_reconciliations
          WHERE tenant_id = ${tenantId}
        `;
      });
    } catch (error) {
      deleteError = error;
    }
    expect(deleteError).not.toBeNull();
    expect(String(deleteError)).toContain("permission denied");
  });

  test("RLS still applies to the worker — one tenant's pass cannot see another's run", async () => {
    const a = await provisionTenant("fleet-k9a");
    const b = await provisionTenant("fleet-k9b");
    const worker = getWorkerTestSql();

    await withTenant(worker, b, async (tx) => {
      const seen = await findRequestByTenant(tx, a);
      expect(seen).toBeNull();
    });
  });
});
