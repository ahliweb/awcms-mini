/**
 * Integration tests for `tenant_provisioning` against real PostgreSQL (Issue
 * #872, epic #868, ADR-0022). Covers: request creates the tenant (inactive) +
 * owner + steps + event + audit same-commit; start/resume runs the plan to
 * provisioned + tenant active; idempotent replay + duplicate-request
 * concurrency (no duplicate tenants); failure injection at a step boundary ->
 * classified compensation + blocked (tenant left inactive, data preserved);
 * resume-from-checkpoint after a failure; lease conflict + worker-restart
 * (expired lease reclaimable); non-destructive reconciliation; tenant-scoped
 * RLS cross-tenant isolation; a derived-step fixture; and secret redaction (the
 * owner password is never stored).
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
  integrationEnabled,
  provisionAppRole,
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
  cancelProvisioning,
  reconcileProvisioning,
  requestProvisioning,
  runProvisioning,
  type ProvisioningEngineDeps,
  type ProvisioningOnboardingDeps
} from "../../src/modules/tenant-provisioning/application/provisioning-orchestrator";
import type {
  CapabilitySubdomainResult,
  CoreStepDeps
} from "../../src/modules/tenant-provisioning/application/core-step-handlers";
import {
  findRequestByTenant,
  listSteps,
  listAttempts,
  listCompensations,
  loadTimeline
} from "../../src/modules/tenant-provisioning/application/provisioning-directory";
import {
  registerProvisioningPlan,
  resetContributedProvisioningPlans
} from "../../src/modules/tenant-provisioning/domain/provisioning-plan";
import {
  registerProvisioningStep,
  resetContributedProvisioningSteps
} from "../../src/modules/tenant-provisioning/infrastructure/step-handler-registry";
import type { ProvisioningRequestInput } from "../../src/modules/tenant-provisioning/domain/request-validation";
import type { ProvisioningStepHandler } from "../../src/modules/_shared/ports/provisioning-step-port";

const OPERATOR = "00000000-0000-0000-0000-0000000000aa";

async function verifyOwnerControls(
  tx: Bun.SQL,
  tenantId: string
): Promise<{ ready: boolean; missing: string[] }> {
  const rows = (await tx`
    SELECT count(*)::int AS c
    FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i ON i.id = tu.identity_id AND i.tenant_id = tu.tenant_id
    WHERE tu.tenant_id = ${tenantId} AND i.password_hash IS NOT NULL
  `) as { c: number }[];
  const ok = Number(rows[0]?.c ?? 0) > 0;
  return { ready: ok, missing: ok ? [] : ["owner_identity_with_credentials"] };
}

const onboarding: ProvisioningOnboardingDeps = {
  createTenantIfAbsent: (tx, input) =>
    createTenantRecordIfAbsent(tx, {
      tenantCode: input.tenantCode,
      tenantName: input.tenantName,
      legalName: input.legalName,
      defaultLocale: input.defaultLocale ?? undefined,
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

function makeSteps(over: Partial<CoreStepDeps> = {}): CoreStepDeps {
  return {
    applyConfiguration: (tx, tenantId, config) =>
      applyTenantConfiguration(tx, tenantId, {
        defaultLocale: config.locale ?? undefined,
        defaultTheme: config.theme ?? undefined,
        timezone: config.timezone ?? undefined
      }),
    setTenantActive: (tx, tenantId, actor) =>
      setTenantStatus(tx, tenantId, "active", actor),
    verifyMandatoryControls: verifyOwnerControls,
    ...over
  };
}

function engineDeps(over: Partial<CoreStepDeps> = {}): ProvisioningEngineDeps {
  return { onboarding, steps: makeSteps(over) };
}

let codeSeq = 0;
function makeInput(
  over: Partial<ProvisioningRequestInput> = {}
): ProvisioningRequestInput {
  codeSeq += 1;
  return {
    planKey: "standard_tenant",
    planVersion: 1,
    tenantCode: `t${Date.now().toString(36)}${codeSeq}`.toLowerCase(),
    tenantName: "Acme",
    legalName: null,
    owner: {
      displayName: "Owner",
      loginIdentifier: `owner${codeSeq}@acme.test`,
      password: "supersecret-pw"
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
    },
    ...over
  };
}

async function request(
  input: ProvisioningRequestInput,
  key: string
): Promise<{ tenantId: string; requestId: string; replayed: boolean }> {
  const sql = getTestSql();
  const result = await sql.begin((tx: Bun.SQL) =>
    requestProvisioning(
      tx,
      { actorTenantUserId: OPERATOR, idempotencyKey: key },
      input,
      onboarding
    )
  );
  if (!result.ok) throw new Error(`request failed: ${JSON.stringify(result)}`);
  return {
    tenantId: result.request.tenantId,
    requestId: result.request.id,
    replayed: result.replayed
  };
}

async function tenantStatus(tenantId: string): Promise<string> {
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT status FROM awcms_mini_tenants WHERE id = ${tenantId}
  `) as { status: string }[];
  return rows[0]!.status;
}

async function eventCount(
  tenantId: string,
  eventType: string
): Promise<number> {
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT count(*)::int AS c FROM awcms_mini_domain_events
    WHERE tenant_id = ${tenantId} AND event_type = ${eventType}
  `) as { c: number }[];
  return Number(rows[0]!.c);
}

const suite = integrationEnabled ? describe : describe.skip;

suite("tenant_provisioning — orchestration engine", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
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

  test("request creates the tenant (inactive) + owner + steps + event + audit (same-commit)", async () => {
    const { tenantId, requestId } = await request(makeInput(), "k1");

    expect(await tenantStatus(tenantId)).toBe("inactive");
    expect(
      await eventCount(tenantId, "awcms-mini.tenant-provisioning.requested")
    ).toBe(1);

    const sql = getTestSql();
    await withTenant(sql, tenantId, async (tx) => {
      const req = await findRequestByTenant(tx, tenantId);
      expect(req!.status).toBe("requested");
      expect(req!.totalSteps).toBe(7);
      expect(req!.completedSteps).toBe(2); // bootstrap + owner pre-completed
      const steps = await listSteps(tx, requestId);
      const bootstrap = steps.find((s) => s.stepKey === "tenant_bootstrap")!;
      const owner = steps.find((s) => s.stepKey === "owner_identity")!;
      expect(bootstrap.status).toBe("completed");
      expect(owner.status).toBe("completed");
    });

    const admin = getAdminSql();
    const audit = (await admin`
      SELECT count(*)::int AS c FROM awcms_mini_audit_events
      WHERE tenant_id = ${tenantId} AND module_key = 'tenant_provisioning'
        AND resource_type = 'tenant_provisioning_request'
    `) as { c: number }[];
    expect(Number(audit[0]!.c)).toBeGreaterThanOrEqual(1);
  });

  test("start runs the plan to provisioned + tenant active + completed event", async () => {
    const { tenantId, requestId } = await request(makeInput(), "k2");
    const sql = getTestSql();

    const run = await runProvisioning(
      sql,
      tenantId,
      requestId,
      {
        actorTenantUserId: OPERATOR,
        leaseOwner: "worker-1"
      },
      engineDeps()
    );
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.request.status).toBe("provisioned");
      expect(run.request.readiness).toBe("ready");
    }
    expect(await tenantStatus(tenantId)).toBe("active");
    expect(
      await eventCount(tenantId, "awcms-mini.tenant-provisioning.completed")
    ).toBe(1);

    await withTenant(sql, tenantId, async (tx) => {
      const steps = await listSteps(tx, requestId);
      // optional entitlement/module/subdomain skip (no inputs) — all done.
      for (const s of steps) {
        expect(["completed", "skipped"]).toContain(s.status);
      }
    });
  });

  test("idempotent replay (same key+input) + conflict (taken code, different request)", async () => {
    const input = makeInput();
    const first = await request(input, "kidem");
    const replay = await request(input, "kidem");
    expect(replay.replayed).toBe(true);
    expect(replay.requestId).toBe(first.requestId);

    // Same tenant code, DIFFERENT request (new key) => deterministic conflict.
    const sql = getTestSql();
    const conflict = await sql.begin((tx: Bun.SQL) =>
      requestProvisioning(
        tx,
        { actorTenantUserId: OPERATOR, idempotencyKey: "different" },
        { ...input, tenantName: "Other" },
        onboarding
      )
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toBe("conflict");
  });

  test("concurrent duplicate requests cannot create duplicate tenants", async () => {
    const input = makeInput();
    const sql = getTestSql();
    const run = () =>
      sql.begin((tx: Bun.SQL) =>
        requestProvisioning(
          tx,
          { actorTenantUserId: OPERATOR, idempotencyKey: "kconc" },
          input,
          onboarding
        )
      );
    // Two concurrent requests for the same tenant_code, separate transactions.
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.ok && b.ok).toBe(true);

    const admin = getAdminSql();
    const tenants = (await admin`
      SELECT count(*)::int AS c FROM awcms_mini_tenants WHERE tenant_code = ${input.tenantCode}
    `) as { c: number }[];
    expect(Number(tenants[0]!.c)).toBe(1); // exactly one tenant
    if (a.ok && b.ok) {
      const reqs = (await admin`
        SELECT count(*)::int AS c FROM awcms_mini_tenant_provisioning_requests
        WHERE tenant_id = ${a.request.tenantId}
      `) as { c: number }[];
      expect(Number(reqs[0]!.c)).toBe(1); // exactly one run
    }
  });

  test("failure injection at a step boundary -> classified compensation + blocked (tenant stays inactive)", async () => {
    // A subdomain step that always fails (non-retryable validation).
    const failingSubdomain = {
      request: async (): Promise<CapabilitySubdomainResult> => ({
        ok: false as const,
        reason: "validation" as const
      }),
      deactivate: async () => {}
    };
    const { tenantId, requestId } = await request(
      makeInput({
        options: {
          defaultLocale: "id",
          defaultTheme: null,
          timezone: null,
          subdomain: "acme",
          presetKey: null,
          offerPlanKey: null,
          offerVersion: null
        }
      }),
      "kfail"
    );
    const sql = getTestSql();
    const run = await runProvisioning(
      sql,
      tenantId,
      requestId,
      {
        actorTenantUserId: OPERATOR,
        leaseOwner: "w"
      },
      engineDeps({ subdomain: failingSubdomain })
    );

    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(["failed", "blocked"]).toContain(run.request.status);
      expect(run.request.readiness).toBe("blocked");
    }
    // Tenant is NEVER left active on a failed run.
    expect(await tenantStatus(tenantId)).toBe("inactive");
    expect(
      await eventCount(tenantId, "awcms-mini.tenant-provisioning.failed")
    ).toBe(1);

    await withTenant(sql, tenantId, async (tx) => {
      const comps = await listCompensations(tx, requestId);
      // bootstrap = forbidden (never delete tenant), owner = manual, config = reversible.
      const byStep = new Map(comps.map((c) => [c.stepKey, c]));
      expect(byStep.get("tenant_bootstrap")?.status).toBe("skipped_forbidden");
      expect(byStep.get("owner_identity")?.status).toBe("manual_required");
      expect(byStep.get("default_configuration")?.status).toBe("completed");
      // The failing step itself is not "completed" (never compensated).
      const steps = await listSteps(tx, requestId);
      const sub = steps.find((s) => s.stepKey === "subdomain_request")!;
      expect(sub.status).toBe("failed");
    });
  });

  test("bounded retry then resume-from-checkpoint after fixing the failure", async () => {
    const { tenantId, requestId } = await request(
      makeInput({
        options: {
          defaultLocale: "id",
          defaultTheme: null,
          timezone: null,
          subdomain: "acme",
          presetKey: null,
          offerPlanKey: null,
          offerVersion: null
        }
      }),
      "kresume"
    );
    const sql = getTestSql();

    // First run: subdomain throws (transient) -> retried up to budget -> blocked/failed.
    let calls = 0;
    const flakySubdomain = {
      request: async (): Promise<CapabilitySubdomainResult> => {
        calls += 1;
        throw new Error("provider down");
      },
      deactivate: async () => {}
    };
    const run1 = await runProvisioning(
      sql,
      tenantId,
      requestId,
      {
        actorTenantUserId: OPERATOR,
        leaseOwner: "w1"
      },
      engineDeps({ subdomain: flakySubdomain })
    );
    expect(run1.ok).toBe(true);
    // Bounded by the subdomain step's maxAttempts (5): a transient error retries
    // within budget, then stops — never an unbounded loop.
    expect(calls).toBe(5);
    if (run1.ok) expect(["failed", "blocked"]).toContain(run1.request.status);

    // config completed exactly once before the failure (checkpoint durable).
    await withTenant(sql, tenantId, async (tx) => {
      const attempts = await listAttempts(tx, requestId);
      const configAttempts = attempts.filter(
        (a) => a.stepKey === "default_configuration"
      );
      expect(configAttempts.length).toBe(1);
      expect(configAttempts[0]!.outcome).toBe("succeeded");
    });

    // Second run: subdomain now works -> resumes from checkpoint -> provisioned.
    const workingSubdomain = {
      request: async (): Promise<CapabilitySubdomainResult> => ({
        ok: true as const,
        domainId: "11111111-1111-1111-1111-111111111111"
      }),
      deactivate: async () => {}
    };
    const run2 = await runProvisioning(
      sql,
      tenantId,
      requestId,
      {
        actorTenantUserId: OPERATOR,
        leaseOwner: "w2"
      },
      engineDeps({ subdomain: workingSubdomain })
    );
    expect(run2.ok).toBe(true);
    if (run2.ok) expect(run2.request.status).toBe("provisioned");
    expect(await tenantStatus(tenantId)).toBe("active");

    // config was NOT re-run on resume (still exactly one attempt).
    await withTenant(sql, tenantId, async (tx) => {
      const attempts = await listAttempts(tx, requestId);
      const configAttempts = attempts.filter(
        (a) => a.stepKey === "default_configuration"
      );
      expect(configAttempts.length).toBe(1);
    });
  });

  test("lease conflict (live lease) + worker-restart (expired lease reclaimable)", async () => {
    const { tenantId, requestId } = await request(makeInput(), "klease");
    const admin = getAdminSql();
    const sql = getTestSql();

    // A live lease held by another worker -> a start is refused with lease_conflict.
    await admin`
      UPDATE awcms_mini_tenant_provisioning_requests
      SET status = 'in_progress', lease_owner = 'other', lease_expires_at = now() + interval '5 minutes',
          started_at = now()
      WHERE id = ${requestId}
    `;
    const conflict = await runProvisioning(
      sql,
      tenantId,
      requestId,
      {
        actorTenantUserId: OPERATOR,
        leaseOwner: "me"
      },
      engineDeps()
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toBe("lease_conflict");

    // Expire the lease (worker crashed) -> reclaimable -> run completes.
    await admin`
      UPDATE awcms_mini_tenant_provisioning_requests
      SET lease_expires_at = now() - interval '1 minute'
      WHERE id = ${requestId}
    `;
    const reclaimed = await runProvisioning(
      sql,
      tenantId,
      requestId,
      {
        actorTenantUserId: OPERATOR,
        leaseOwner: "me"
      },
      engineDeps()
    );
    expect(reclaimed.ok).toBe(true);
    if (reclaimed.ok) expect(reclaimed.request.status).toBe("provisioned");
  });

  test("reconcile is non-destructive (consistent; tenant stays active; refuses non-provisioned)", async () => {
    const { tenantId, requestId } = await request(makeInput(), "krecon");
    const sql = getTestSql();

    // Refuses a non-provisioned run.
    const early = await reconcileProvisioning(sql, tenantId, requestId, {
      actorTenantUserId: OPERATOR
    });
    expect(early.ok).toBe(false);

    await runProvisioning(
      sql,
      tenantId,
      requestId,
      {
        actorTenantUserId: OPERATOR,
        leaseOwner: "w"
      },
      engineDeps()
    );

    const recon = await reconcileProvisioning(sql, tenantId, requestId, {
      actorTenantUserId: OPERATOR
    });
    expect(recon.ok).toBe(true);
    if (recon.ok) {
      expect(recon.status).toBe("consistent");
      expect(recon.request.status).toBe("provisioned"); // back to provisioned
    }
    // Non-destructive: tenant still active, a reconciliation row recorded, event emitted.
    expect(await tenantStatus(tenantId)).toBe("active");
    expect(
      await eventCount(tenantId, "awcms-mini.tenant-provisioning.reconciled")
    ).toBe(1);
    await withTenant(sql, tenantId, async (tx) => {
      const timeline = await loadTimeline(tx, tenantId);
      expect(timeline!.reconciliations.length).toBe(1);
    });
  });

  test("tenant-scoped RLS blocks cross-tenant reads of a provisioning run", async () => {
    const a = await request(makeInput(), "krls-a");
    const b = await request(makeInput(), "krls-b");
    const sql = getTestSql();
    // Under tenant B's context, tenant A's run is invisible.
    await withTenant(sql, b.tenantId, async (tx) => {
      const seen = await findRequestByTenant(tx, a.tenantId);
      expect(seen).toBeNull();
      const steps = await listSteps(tx, a.requestId);
      expect(steps.length).toBe(0);
    });
  });

  test("derived-application step contributes without editing base orchestration", async () => {
    let ran = false;
    const derivedHandler: ProvisioningStepHandler = {
      stepKey: "derived_welcome",
      async execute() {
        ran = true;
        return {
          outcome: "completed",
          resultKind: "derived_done",
          output: { ok: true }
        };
      }
    };
    registerProvisioningStep(derivedHandler);
    registerProvisioningPlan({
      planKey: "derived_plan",
      version: 1,
      description: "derived",
      steps: [
        {
          stepKey: "tenant_bootstrap",
          kind: "core",
          compensationClass: "forbidden",
          optional: false,
          maxAttempts: 1,
          description: "bootstrap"
        },
        {
          stepKey: "owner_identity",
          kind: "core",
          compensationClass: "manual",
          optional: false,
          description: "owner"
        },
        {
          stepKey: "derived_welcome",
          kind: "derived",
          compensationClass: "reversible",
          optional: false,
          description: "derived"
        },
        {
          stepKey: "readiness_check",
          kind: "core",
          compensationClass: "forbidden",
          optional: false,
          description: "readiness"
        }
      ]
    });

    const { tenantId, requestId } = await request(
      makeInput({ planKey: "derived_plan", planVersion: 1 }),
      "kderived"
    );
    const sql = getTestSql();
    const run = await runProvisioning(
      sql,
      tenantId,
      requestId,
      {
        actorTenantUserId: OPERATOR,
        leaseOwner: "w"
      },
      engineDeps()
    );
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.request.status).toBe("provisioned");
    expect(ran).toBe(true);
  });

  test("an unregistered step handler FAILS CLOSED (blocks the run)", async () => {
    registerProvisioningPlan({
      planKey: "gap_plan",
      version: 1,
      description: "has an unhandled step",
      steps: [
        {
          stepKey: "tenant_bootstrap",
          kind: "core",
          compensationClass: "forbidden",
          optional: false,
          maxAttempts: 1,
          description: "b"
        },
        {
          stepKey: "owner_identity",
          kind: "core",
          compensationClass: "manual",
          optional: false,
          description: "o"
        },
        {
          stepKey: "unhandled_step",
          kind: "derived",
          compensationClass: "reversible",
          optional: false,
          description: "x"
        }
      ]
    });
    const { tenantId, requestId } = await request(
      makeInput({ planKey: "gap_plan", planVersion: 1 }),
      "kgap"
    );
    const sql = getTestSql();
    const run = await runProvisioning(
      sql,
      tenantId,
      requestId,
      {
        actorTenantUserId: OPERATOR,
        leaseOwner: "w"
      },
      engineDeps()
    );
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.request.status).toBe("blocked");
    expect(await tenantStatus(tenantId)).toBe("inactive");
  });

  test("cancel runs classified compensation and preserves tenant data (never active)", async () => {
    const { tenantId, requestId } = await request(makeInput(), "kcancel");
    const sql = getTestSql();
    const result = await cancelProvisioning(
      sql,
      tenantId,
      requestId,
      "operator abort",
      {
        actorTenantUserId: OPERATOR,
        leaseOwner: "w"
      },
      engineDeps()
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.status).toBe("canceled");
    // Tenant + owner still exist (never deleted), tenant not active.
    expect(await tenantStatus(tenantId)).toBe("inactive");
    const admin = getAdminSql();
    const owner = (await admin`
      SELECT count(*)::int AS c FROM awcms_mini_tenant_users WHERE tenant_id = ${tenantId}
    `) as { c: number }[];
    expect(Number(owner[0]!.c)).toBe(1);
  });

  test("the owner password is NEVER stored in any provisioning record (secret redaction)", async () => {
    const input = makeInput({
      owner: {
        displayName: "Owner",
        loginIdentifier: "secretowner@acme.test",
        password: "UNIQUE-SECRET-PW-9271"
      }
    });
    const { tenantId, requestId } = await request(input, "ksecret");
    const sql = getTestSql();
    await runProvisioning(
      sql,
      tenantId,
      requestId,
      {
        actorTenantUserId: OPERATOR,
        leaseOwner: "w"
      },
      engineDeps()
    );

    const admin = getAdminSql();
    const rows = (await admin`
      SELECT
        (SELECT count(*)::int FROM awcms_mini_tenant_provisioning_requests
           WHERE tenant_id = ${tenantId} AND (inputs::text LIKE '%UNIQUE-SECRET-PW-9271%' OR inputs_hash LIKE '%UNIQUE-SECRET-PW-9271%')) AS req,
        (SELECT count(*)::int FROM awcms_mini_tenant_provisioning_steps
           WHERE tenant_id = ${tenantId} AND checkpoint::text LIKE '%UNIQUE-SECRET-PW-9271%') AS steps,
        (SELECT count(*)::int FROM awcms_mini_tenant_provisioning_results
           WHERE tenant_id = ${tenantId} AND output::text LIKE '%UNIQUE-SECRET-PW-9271%') AS results,
        (SELECT count(*)::int FROM awcms_mini_domain_events
           WHERE tenant_id = ${tenantId} AND payload::text LIKE '%UNIQUE-SECRET-PW-9271%') AS events,
        (SELECT count(*)::int FROM awcms_mini_audit_events
           WHERE tenant_id = ${tenantId} AND (message LIKE '%UNIQUE-SECRET-PW-9271%' OR attributes::text LIKE '%UNIQUE-SECRET-PW-9271%')) AS audits
    `) as {
      req: number;
      steps: number;
      results: number;
      events: number;
      audits: number;
    }[];
    const r = rows[0]!;
    expect(Number(r.req)).toBe(0);
    expect(Number(r.steps)).toBe(0);
    expect(Number(r.results)).toBe(0);
    expect(Number(r.events)).toBe(0);
    expect(Number(r.audits)).toBe(0);
  });
});
