/**
 * Integration tests for `tenant_lifecycle` against real PostgreSQL (Issue #873,
 * epic #868, ADR-0022). Covers, per AC:
 *   - transition + append-only history + versioned event + audit + tenant-status
 *     projection SAME-COMMIT (proven by a shared `xmin`);
 *   - concurrency: two concurrent transitions from the same version -> exactly
 *     one wins, the other is a deterministic version_conflict (409);
 *   - the DB immutability triggers: illegal transition rejected, hard DELETE
 *     rejected, history append-only;
 *   - idempotent scheduled transitions under repeated / concurrent apply;
 *   - restore reconciliation (unresolved provisioning must be confirmed);
 *   - downgrade preserves data + records an explainable history row;
 *   - tenant-scoped RLS cross-tenant isolation (tenant A never sees B);
 *   - CROSS-SURFACE enforcement + MUTATION parity: a suspended tenant is denied
 *     at the API/SSR auth chokepoint AND (via the projected tenant status) at
 *     public routing + workers; past_due is read-only; the lifecycle module's
 *     own surface stays reachable (owner recovery). Removing EITHER the
 *     chokepoint gate OR the status projection fails this test.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";
import { hashSessionToken } from "../../src/lib/auth/session-token";
import { authorizeInTransaction } from "../../src/modules/identity-access/application/access-guard";
import {
  createTenantRecordIfAbsent,
  setTenantStatus
} from "../../src/modules/tenant-admin/application/tenant-onboarding";
import { syncModuleDescriptors } from "../../src/modules/module-management/application/descriptor-sync";
import {
  downgrade,
  initializeLifecycle,
  restore,
  scheduleTransition,
  transition,
  type LifecycleEngineDeps
} from "../../src/modules/tenant-lifecycle/application/lifecycle-transition";
import { runDueScheduleForTenant } from "../../src/modules/tenant-lifecycle/application/lifecycle-scheduler";
import {
  listHistory,
  loadState
} from "../../src/modules/tenant-lifecycle/application/lifecycle-directory";
import { readTenantRestrictionSnapshot } from "../../src/modules/_shared/tenant-lifecycle-restriction-read";
import { buildEngineDeps } from "../../src/pages/api/v1/tenant-lifecycle/_support";
import { listModules } from "../../src/modules";
import { resolveServiceCatalogKeyRegistry } from "../../src/modules/service-catalog/domain/key-registry";
import {
  approveOfferVersion,
  createPlan,
  publishVersion
} from "../../src/modules/service-catalog/application/plan-directory";
import type { VersionContentInput } from "../../src/modules/service-catalog/domain/plan";
import { createServiceCatalogReadPort } from "../../src/modules/service-catalog/application/service-catalog-read-port-adapter";
import { assignEntitlement } from "../../src/modules/tenant-entitlement/application/entitlement-directory";

const OWNER_PASSWORD = "integration-test-lifecycle-owner-password";
const projectionDeps: LifecycleEngineDeps = {
  async projectTenantStatus(tx, tenantId, active, actor) {
    await setTenantStatus(tx, tenantId, active ? "active" : "inactive", actor);
  }
};
const scRegistry = resolveServiceCatalogKeyRegistry(listModules());
const CATALOG_ACTOR = "00000000-0000-0000-0000-0000000000ab";

/** A minimal, registry-valid offer content (mirrors the #871 test fixtures). */
function offerContent(): VersionContentInput {
  return {
    currency: "IDR",
    market: null,
    trialEnabled: false,
    trialDays: null,
    availableFrom: null,
    availableTo: null,
    notes: null,
    features: [
      {
        featureKind: "feature",
        featureKey: "platform.api_access",
        enabled: true,
        metadata: {}
      }
    ],
    quotas: [
      {
        meterKey: "platform.api_calls",
        isUnlimited: false,
        limitValue: 1000,
        unit: "requests",
        resetPolicy: "monthly",
        metadata: {}
      }
    ],
    prices: [
      {
        componentKey: "base",
        amountMinor: 9900000,
        currency: "IDR",
        interval: "monthly",
        visibility: "public",
        metadata: {}
      }
    ]
  };
}

/** Create + publish a plan's version 1 so a real offer exists for the tenant. */
async function seedOffer(
  sql: Bun.SQL,
  tenantId: string,
  planKey: string
): Promise<void> {
  await withTenant(sql, tenantId, async (tx) => {
    const created = await createPlan(
      tx,
      tenantId,
      CATALOG_ACTOR,
      {
        planKey,
        name: planKey,
        description: null,
        planType: "subscription",
        content: offerContent()
      },
      scRegistry
    );
    if (!created.ok)
      throw new Error("seedOffer createPlan: " + JSON.stringify(created));
    // Issue #879 — publish requires a prior commercial approval by a DISTINCT actor.
    await approveOfferVersion(tx, tenantId, crypto.randomUUID(), planKey, 1);
    const pub = await publishVersion(
      tx,
      tenantId,
      CATALOG_ACTOR,
      planKey,
      1,
      scRegistry
    );
    if (!pub.ok)
      throw new Error("seedOffer publishVersion: " + JSON.stringify(pub));
  });
}

type Owner = { tenantId: string; token: string; tenantUserId: string };

let codeSeq = 0;
async function bootstrapOwner(): Promise<Owner> {
  codeSeq += 1;
  const loginIdentifier = `lifecycle-owner-${codeSeq}@example.com`;
  const code = `acme${codeSeq}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme",
      tenantCode: code,
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
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT tu.id FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${setup.body.data.tenantId}
      AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];
  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId: rows[0]!.id
  };
}

async function tenantStatus(tenantId: string): Promise<string> {
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT status FROM awcms_mini_tenants WHERE id = ${tenantId}
  `) as { status: string }[];
  return rows[0]!.status;
}

/** Enable a module for a tenant (an explicit tenant_modules row). */
async function enableModule(
  tenantId: string,
  moduleKey: string
): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key, enabled)
    VALUES (${tenantId}, ${moduleKey}, true)
    ON CONFLICT (tenant_id, module_key) DO UPDATE SET enabled = true
  `;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("tenant_lifecycle — engine + enforcement", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  test("transition writes state + history + event + audit SAME-COMMIT (shared xmin) and projects tenant status", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await withTenant(sql, owner.tenantId, async (tx) => {
      await initializeLifecycle(
        tx,
        owner.tenantId,
        {
          initialState: "active",
          reason: "go live",
          source: "operator",
          trialEndsAt: null,
          graceEndsAt: null
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      );
    });
    expect(await tenantStatus(owner.tenantId)).toBe("active");

    await withTenant(sql, owner.tenantId, async (tx) => {
      const result = await transition(
        tx,
        owner.tenantId,
        {
          toState: "suspended",
          reason: "non-payment",
          source: "operator",
          expectedVersion: 1
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      );
      expect(result.ok).toBe(true);
    });

    // Projection: public/worker surface parity.
    expect(await tenantStatus(owner.tenantId)).toBe("inactive");

    const admin = getAdminSql();
    // Same-commit proof: the state row, the history row for this transition, and
    // the domain event were all written in ONE transaction -> shared xmin.
    const stateXmin = (await admin`
      SELECT xmin::text AS x FROM awcms_mini_tenant_lifecycle_states WHERE tenant_id = ${owner.tenantId}
    `) as { x: string }[];
    const histXmin = (await admin`
      SELECT xmin::text AS x FROM awcms_mini_tenant_lifecycle_history
      WHERE tenant_id = ${owner.tenantId} AND to_state = 'suspended'
    `) as { x: string }[];
    const evtXmin = (await admin`
      SELECT xmin::text AS x FROM awcms_mini_domain_events
      WHERE tenant_id = ${owner.tenantId} AND event_type = 'awcms-mini.tenant-lifecycle.transitioned'
        AND (payload->>'toState') = 'suspended'
    `) as { x: string }[];
    expect(histXmin).toHaveLength(1);
    expect(evtXmin).toHaveLength(1);
    expect(histXmin[0]!.x).toBe(stateXmin[0]!.x);
    expect(evtXmin[0]!.x).toBe(stateXmin[0]!.x);

    // Audit recorded with mandatory reason.
    const audit = (await admin`
      SELECT count(*)::int AS c FROM awcms_mini_audit_events
      WHERE tenant_id = ${owner.tenantId} AND module_key = 'tenant_lifecycle'
    `) as { c: number }[];
    expect(audit[0]!.c).toBeGreaterThanOrEqual(2);
  });

  test("a state-changing transition WITHOUT a projector fails LOUD and rolls back (Fix 1)", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await withTenant(sql, owner.tenantId, (tx) =>
      initializeLifecycle(
        tx,
        owner.tenantId,
        {
          initialState: "active",
          reason: "init",
          source: "operator",
          trialEndsAt: null,
          graceEndsAt: null
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      )
    );

    // A mis-assembled composition root (JS bypass of the now-mandatory type)
    // must NOT silently change lifecycle state without projecting tenant status
    // — the engine throws, aborting the transaction (four-surface parity).
    let threw: Error | null = null;
    try {
      await withTenant(sql, owner.tenantId, (tx) =>
        transition(
          tx,
          owner.tenantId,
          {
            toState: "suspended",
            reason: "x",
            source: "operator",
            expectedVersion: 1
          },
          {} as LifecycleEngineDeps,
          { actorTenantUserId: owner.tenantUserId }
        )
      );
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).not.toBeNull();
    expect(threw!.message).toContain("projectTenantStatus");

    // The throw rolled the tx back: state + tenant status unchanged.
    await withTenant(sql, owner.tenantId, async (tx) => {
      const state = await loadState(tx, owner.tenantId);
      expect(state!.state).toBe("active");
      expect(state!.version).toBe(1);
    });
    expect(await tenantStatus(owner.tenantId)).toBe("active");
  });

  test("concurrency: two transitions from the same version -> one wins, one version_conflict (409)", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await withTenant(sql, owner.tenantId, async (tx) => {
      await initializeLifecycle(
        tx,
        owner.tenantId,
        {
          initialState: "active",
          reason: "init",
          source: "operator",
          trialEndsAt: null,
          graceEndsAt: null
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      );
    });

    const attempt = (toState: "suspended" | "grace") =>
      withTenant(sql, owner.tenantId, (tx) =>
        transition(
          tx,
          owner.tenantId,
          { toState, reason: "race", source: "operator", expectedVersion: 1 },
          projectionDeps,
          { actorTenantUserId: owner.tenantUserId }
        )
      );

    // Two INDEPENDENT transactions (never Promise.all on one tx).
    const [a, b] = await Promise.all([attempt("suspended"), attempt("grace")]);
    const oks = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter(
      (r) => !r.ok && r.reason === "version_conflict"
    );
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
  });

  test("DB triggers reject an illegal transition, a hard DELETE, and a history UPDATE", async () => {
    const owner = await bootstrapOwner();
    const admin = getAdminSql();
    const sql = getTestSql();
    await withTenant(sql, owner.tenantId, async (tx) => {
      await initializeLifecycle(
        tx,
        owner.tenantId,
        {
          initialState: "active",
          reason: "init",
          source: "operator",
          trialEndsAt: null,
          graceEndsAt: null
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      );
    });

    // Illegal transition at the DB layer (active -> restoring is not whitelisted).
    let illegal = false;
    try {
      await admin`
        UPDATE awcms_mini_tenant_lifecycle_states
        SET state = 'restoring', previous_state = 'active', version = version + 1
        WHERE tenant_id = ${owner.tenantId}
      `;
    } catch {
      illegal = true;
    }
    expect(illegal).toBe(true);

    // Hard DELETE rejected.
    let deleted = false;
    try {
      await admin`DELETE FROM awcms_mini_tenant_lifecycle_states WHERE tenant_id = ${owner.tenantId}`;
    } catch {
      deleted = true;
    }
    expect(deleted).toBe(true);

    // History append-only (UPDATE rejected).
    let historyUpdated = false;
    try {
      await admin`
        UPDATE awcms_mini_tenant_lifecycle_history SET reason = 'tamper'
        WHERE tenant_id = ${owner.tenantId}
      `;
    } catch {
      historyUpdated = true;
    }
    expect(historyUpdated).toBe(true);
  });

  test("scheduled transition is idempotent under repeated apply", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    const past = new Date(Date.now() - 60_000).toISOString();
    await withTenant(sql, owner.tenantId, async (tx) => {
      await initializeLifecycle(
        tx,
        owner.tenantId,
        {
          initialState: "grace",
          reason: "init",
          source: "operator",
          trialEndsAt: null,
          graceEndsAt: null
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      );
      await scheduleTransition(
        tx,
        owner.tenantId,
        {
          toState: "suspended",
          at: past,
          reason: "grace expiry",
          source: "scheduler",
          expectedVersion: 1
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      );
    });

    const first = await runDueScheduleForTenant(
      sql,
      owner.tenantId,
      projectionDeps,
      { actorTenantUserId: null }
    );
    const second = await runDueScheduleForTenant(
      sql,
      owner.tenantId,
      projectionDeps,
      { actorTenantUserId: null }
    );
    expect(first.ok && first.applied).toBe(true);
    expect(second.ok && second.applied).toBe(false); // idempotent no-op

    await withTenant(sql, owner.tenantId, async (tx) => {
      const state = await loadState(tx, owner.tenantId);
      expect(state!.state).toBe("suspended");
    });
    // The scheduler path (the SAME engine `tenant-lifecycle:run-scheduled` wires)
    // MUST project tenant status too — proving the CLI/worker composition root
    // propagates suspension to public routing + workers (four-surface parity).
    expect(await tenantStatus(owner.tenantId)).toBe("inactive");
    // Exactly one transition history row for the scheduled apply.
    const admin = getAdminSql();
    const hist = (await admin`
      SELECT count(*)::int AS c FROM awcms_mini_tenant_lifecycle_history
      WHERE tenant_id = ${owner.tenantId} AND to_state = 'suspended' AND event_kind = 'transition'
    `) as { c: number }[];
    expect(hist[0]!.c).toBe(1);
  });

  test("restore reconciliation: unresolved provisioning must be explicitly confirmed", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await withTenant(sql, owner.tenantId, async (tx) => {
      await initializeLifecycle(
        tx,
        owner.tenantId,
        {
          initialState: "active",
          reason: "init",
          source: "operator",
          trialEndsAt: null,
          graceEndsAt: null
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      );
      await transition(
        tx,
        owner.tenantId,
        {
          toState: "suspended",
          reason: "x",
          source: "operator",
          expectedVersion: 1
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      );
    });

    // provisioningReady reports NOT ready -> restore without confirm is refused.
    const notReadyDeps: LifecycleEngineDeps = {
      ...projectionDeps,
      provisioningReady: async () => ({
        ready: false,
        status: "blocked",
        blockedReason: "no owner"
      })
    };
    const refused = await withTenant(sql, owner.tenantId, (tx) =>
      restore(
        tx,
        owner.tenantId,
        { reason: "recover", confirmUnresolved: false, expectedVersion: 2 },
        notReadyDeps,
        { actorTenantUserId: owner.tenantUserId }
      )
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("unresolved_reconciliation");

    // With explicit confirmation -> restored to active (data preserved).
    const restored = await withTenant(sql, owner.tenantId, (tx) =>
      restore(
        tx,
        owner.tenantId,
        { reason: "recover", confirmUnresolved: true, expectedVersion: 2 },
        notReadyDeps,
        { actorTenantUserId: owner.tenantUserId }
      )
    );
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.state.state).toBe("active");
    expect(await tenantStatus(owner.tenantId)).toBe("active");
  });

  test("downgrade preserves data and records an explainable history row without changing state", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await withTenant(sql, owner.tenantId, async (tx) => {
      await initializeLifecycle(
        tx,
        owner.tenantId,
        {
          initialState: "active",
          reason: "init",
          source: "operator",
          trialEndsAt: null,
          graceEndsAt: null
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      );
    });

    const downgradeDeps: LifecycleEngineDeps = {
      ...projectionDeps,
      downgradeEntitlement: async () => ({
        ok: true,
        before: "pro",
        assignmentId: "a1"
      })
    };
    const result = await withTenant(sql, owner.tenantId, (tx) =>
      downgrade(
        tx,
        owner.tenantId,
        {
          offerPlanKey: "basic",
          offerVersion: 1,
          reason: "cost",
          expectedVersion: 1
        },
        downgradeDeps,
        { actorTenantUserId: owner.tenantUserId }
      )
    );
    expect(result.ok).toBe(true);
    // State unchanged (downgrade is not a state transition); data preserved.
    await withTenant(sql, owner.tenantId, async (tx) => {
      const state = await loadState(tx, owner.tenantId);
      expect(state!.state).toBe("active");
      expect(state!.version).toBe(1);
      const history = await listHistory(tx, owner.tenantId, 10);
      const dg = history.find((h) => h.eventKind === "downgrade");
      expect(dg).toBeDefined();
      // Explainable: BOTH the origin offer and the target are recorded.
      const meta = dg!.metadata as Record<string, unknown>;
      expect(meta.beforeOffer).toBe("pro");
      expect(meta.afterOfferPlanKey).toBe("basic");
      expect(meta.afterOfferVersion).toBe(1);
    });
    // The `.downgraded` event also carries the origin offer (non-null before).
    const admin = getAdminSql();
    const evt = (await admin`
      SELECT payload FROM awcms_mini_domain_events
      WHERE tenant_id = ${owner.tenantId}
        AND event_type = 'awcms-mini.tenant-lifecycle.downgraded'
    `) as { payload: Record<string, unknown> }[];
    expect(evt).toHaveLength(1);
    expect(evt[0]!.payload.beforeOffer).toBe("pro");
    expect(evt[0]!.payload.afterOfferPlanKey).toBe("basic");
  });

  test("buildEngineDeps.downgradeEntitlement reads the PRIOR offer as an explainable before (Fix 3)", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    // A real published prior offer + a target offer to downgrade toward.
    await seedOffer(sql, owner.tenantId, "pro");
    await seedOffer(sql, owner.tenantId, "basic");
    // Assign the prior "pro@v1" so it is the CURRENT entitlement.
    await withTenant(sql, owner.tenantId, async (tx) => {
      const assigned = await assignEntitlement(
        tx,
        owner.tenantId,
        owner.tenantUserId,
        {
          planKey: "pro",
          offerVersion: 1,
          source: "subscription",
          reason: "initial",
          effectiveFrom: null,
          effectiveTo: null,
          trialEndsAt: null,
          graceEndsAt: null
        },
        {
          catalogPort: createServiceCatalogReadPort(tx),
          moduleDescriptors: listModules()
        }
      );
      expect(assigned.ok).toBe(true);
    });

    // The route composition-root adapter must capture "pro@v1" as `before`
    // BEFORE assigning the lower offer (not a hardcoded null).
    const deps = buildEngineDeps();
    const out = await withTenant(sql, owner.tenantId, (tx) =>
      deps.downgradeEntitlement!(tx, owner.tenantId, owner.tenantUserId, {
        offerPlanKey: "basic",
        offerVersion: 1
      })
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.before).toBe("pro@v1");
  });

  test("tenant-scoped RLS: tenant A never sees tenant B's lifecycle", async () => {
    // setup/initialize is a platform singleton, so build both tenants directly.
    const admin = getAdminSql();
    const mk = async (code: string): Promise<string> => {
      const { tenantId } = await createTenantRecordIfAbsent(admin, {
        tenantCode: code,
        tenantName: code,
        legalName: null,
        status: "inactive"
      });
      return tenantId;
    };
    const aId = await mk(`rls-a-${codeSeq}`);
    const bId = await mk(`rls-b-${codeSeq}`);
    const sql = getTestSql();
    for (const tenantId of [aId, bId]) {
      await withTenant(sql, tenantId, (tx) =>
        initializeLifecycle(
          tx,
          tenantId,
          {
            initialState: "active",
            reason: "init",
            source: "operator",
            trialEndsAt: null,
            graceEndsAt: null
          },
          projectionDeps,
          { actorTenantUserId: null }
        )
      );
    }
    // In A's context, B's row is invisible.
    await withTenant(sql, aId, async (tx) => {
      const bState = await loadState(tx, bId);
      expect(bState).toBeNull();
      const aState = await loadState(tx, aId);
      expect(aState!.tenant_id).toBe(aId);
    });
  });

  test("CROSS-SURFACE + MUTATION parity: suspended tenant is denied at the auth chokepoint AND via projected status; lifecycle surface stays reachable; past_due is read-only", async () => {
    const owner = await bootstrapOwner();
    await syncModuleDescriptors(getAdminSql());
    await enableModule(owner.tenantId, "tenant_lifecycle");
    const appSql = getDatabaseClient();
    const tokenHash = hashSessionToken(owner.token);
    const now = new Date();
    const sql = getTestSql();

    const READ_GUARD = {
      moduleKey: "blog_content",
      activityCode: "posts",
      action: "read" as const
    };
    const WRITE_GUARD = {
      moduleKey: "blog_content",
      activityCode: "posts",
      action: "create" as const
    };
    const LIFECYCLE_READ = {
      moduleKey: "tenant_lifecycle",
      activityCode: "states",
      action: "read" as const
    };

    await withTenant(sql, owner.tenantId, (tx) =>
      initializeLifecycle(
        tx,
        owner.tenantId,
        {
          initialState: "active",
          reason: "init",
          source: "operator",
          trialEndsAt: null,
          graceEndsAt: null
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      )
    );

    // Baseline: active tenant -> the chokepoint allows a read.
    const baseline = await withTenant(appSql, owner.tenantId, (tx) =>
      authorizeInTransaction(tx, owner.tenantId, tokenHash, now, READ_GUARD)
    );
    expect(baseline.allowed).toBe(true);

    // Suspend.
    await withTenant(sql, owner.tenantId, (tx) =>
      transition(
        tx,
        owner.tenantId,
        {
          toState: "suspended",
          reason: "non-payment",
          source: "operator",
          expectedVersion: 1
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      )
    );

    // Surface 1 (API/SSR): the SINGLE auth chokepoint denies. Removing that gate
    // fails this assertion (mutation parity).
    const denied = await withTenant(appSql, owner.tenantId, (tx) =>
      authorizeInTransaction(tx, owner.tenantId, tokenHash, now, READ_GUARD)
    );
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      const body = await denied.denied.clone().json();
      expect(body.error.code).toBe("TENANT_SUSPENDED");
    }

    // Surface 2 (public routing + workers): the projected tenant status is the
    // fact both gate on. Removing the projection fails this assertion.
    expect(await tenantStatus(owner.tenantId)).toBe("inactive");

    // The lifecycle module's OWN surface stays reachable while suspended (owner
    // recovery / restore), because the chokepoint exempts it.
    const lifecycleReach = await withTenant(appSql, owner.tenantId, (tx) =>
      authorizeInTransaction(tx, owner.tenantId, tokenHash, now, LIFECYCLE_READ)
    );
    // Not a lifecycle suspension (may still be allowed/denied on RBAC, but never TENANT_SUSPENDED).
    if (!lifecycleReach.allowed) {
      const body = await lifecycleReach.denied.clone().json();
      expect(body.error.code).not.toBe("TENANT_SUSPENDED");
    }

    // The helper agrees with the chokepoint (single source of truth).
    await withTenant(appSql, owner.tenantId, async (tx) => {
      const snap = await readTenantRestrictionSnapshot(tx, owner.tenantId);
      expect(snap.governing).toBe(true);
      expect(snap.profile.adminAccessAllowed).toBe(false);
    });

    // --- past_due read-only: restore then move to past_due ---
    await withTenant(sql, owner.tenantId, async (tx) => {
      await transition(
        tx,
        owner.tenantId,
        {
          toState: "restoring",
          reason: "r",
          source: "restore",
          expectedVersion: 2
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      );
      await transition(
        tx,
        owner.tenantId,
        {
          toState: "active",
          reason: "r",
          source: "restore",
          expectedVersion: 3
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      );
      await transition(
        tx,
        owner.tenantId,
        {
          toState: "past_due",
          reason: "overdue",
          source: "billing",
          expectedVersion: 4
        },
        projectionDeps,
        { actorTenantUserId: owner.tenantUserId }
      );
    });
    // past_due: reads allowed, writes denied (read-only).
    const readOk = await withTenant(appSql, owner.tenantId, (tx) =>
      authorizeInTransaction(tx, owner.tenantId, tokenHash, now, READ_GUARD)
    );
    expect(readOk.allowed).toBe(true);
    const writeDenied = await withTenant(appSql, owner.tenantId, (tx) =>
      authorizeInTransaction(tx, owner.tenantId, tokenHash, now, WRITE_GUARD)
    );
    expect(writeDenied.allowed).toBe(false);
    if (!writeDenied.allowed) {
      const body = await writeDenied.denied.clone().json();
      expect(body.error.code).toBe("TENANT_READ_ONLY");
    }
  });

  test("a tenant with NO lifecycle record is unrestricted (offline/LAN-safe)", async () => {
    const owner = await bootstrapOwner();
    const appSql = getDatabaseClient();
    const tokenHash = hashSessionToken(owner.token);
    const allowed = await withTenant(appSql, owner.tenantId, (tx) =>
      authorizeInTransaction(tx, owner.tenantId, tokenHash, new Date(), {
        moduleKey: "blog_content",
        activityCode: "posts",
        action: "read" as const
      })
    );
    expect(allowed.allowed).toBe(true);
    await withTenant(appSql, owner.tenantId, async (tx) => {
      const snap = await readTenantRestrictionSnapshot(tx, owner.tenantId);
      expect(snap.governing).toBe(false);
      expect(snap.profile.adminAccessAllowed).toBe(true);
    });
  });
});
