/**
 * Integration tests for `tenant_entitlement` against real PostgreSQL (Issue
 * #871, epic #868, ADR-0022). Covers tenant-scoped RLS + cross-tenant
 * isolation, DB constraints + immutability/write-once triggers, the uniform
 * concurrency pattern (clean 409s), revocation, event/audit/snapshot
 * same-commit, the fail-closed effective resolution + bounded query count
 * (no per-key N+1 catalog query), the module-disabled fail-closed port, a
 * derived-key contract, and — at the route level — entitlement != permission
 * (a positive entitlement cannot bypass an ABAC deny) + idempotency + the
 * module-enabled gate.
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
import { GET as effectiveRoute } from "../../src/pages/api/v1/tenant-entitlement/effective";
import {
  GET as assignmentsListRoute,
  POST as assignRoute
} from "../../src/pages/api/v1/tenant-entitlement/assignments/index";
import { POST as overridesCreateRoute } from "../../src/pages/api/v1/tenant-entitlement/overrides/index";
import { POST as overrideRevokeRoute } from "../../src/pages/api/v1/tenant-entitlement/overrides/[overrideId]/revoke";

import { withTenant } from "../../src/lib/database/tenant-context";
import { listModules } from "../../src/modules";
import { resolveModuleEnabled } from "../../src/modules/identity-access/application/auth-context";
import { syncModuleDescriptors } from "../../src/modules/module-management/application/descriptor-sync";
import { resolveServiceCatalogKeyRegistry } from "../../src/modules/service-catalog/domain/key-registry";
import {
  approveOfferVersion,
  createPlan,
  publishVersion
} from "../../src/modules/service-catalog/application/plan-directory";
import type { VersionContentInput } from "../../src/modules/service-catalog/domain/plan";
import { createServiceCatalogReadPort } from "../../src/modules/service-catalog/application/service-catalog-read-port-adapter";
import {
  assignEntitlement,
  createOverride,
  listAssignments,
  revokeOverride,
  transitionAssignment
} from "../../src/modules/tenant-entitlement/application/entitlement-directory";
import { resolveTenantEntitlement } from "../../src/modules/tenant-entitlement/application/entitlement-resolution";
import { createEffectiveEntitlementPort } from "../../src/modules/tenant-entitlement/application/effective-entitlement-port-adapter";
import {
  getQuota,
  isFeatureAllowed,
  isModuleEntitled
} from "../../src/modules/tenant-entitlement/domain/resolution";
import { resolveEntitlementKeyRegistry } from "../../src/modules/tenant-entitlement/domain/entitlement-key-registry";
import {
  getResponseSchema,
  loadOpenApiDocument,
  validateAgainstSchema
} from "../../scripts/lib/openapi-response-validator";

const scRegistry = resolveServiceCatalogKeyRegistry(listModules());
const entRegistry = resolveEntitlementKeyRegistry(listModules());
const actor = "00000000-0000-0000-0000-0000000000aa";

function content(over: Partial<VersionContentInput> = {}): VersionContentInput {
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
      },
      {
        featureKind: "module",
        featureKey: "blog_content",
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
    ],
    ...over
  };
}

async function seedTenant(prefix: string): Promise<string> {
  const admin = getAdminSql();
  const rows = (await admin`
    INSERT INTO awcms_mini_tenants (tenant_code, tenant_name, status)
    VALUES (${prefix + Math.random().toString(36).slice(2, 8)}, 'Entitlement Test', 'active')
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

/** Create + publish an offer (version 1) so it exists in the tenant-readable projection. */
async function seedOffer(
  tenantId: string,
  planKey: string,
  over: Partial<VersionContentInput> = {}
): Promise<void> {
  const sql = getTestSql();
  await withTenant(sql, tenantId, async (tx) => {
    const created = await createPlan(
      tx,
      tenantId,
      actor,
      {
        planKey,
        name: planKey,
        description: null,
        planType: "subscription",
        content: content(over)
      },
      scRegistry
    );
    if (!created.ok)
      throw new Error(
        "seedOffer createPlan failed: " + JSON.stringify(created)
      );
    // Issue #879 — publish requires a prior commercial approval by a DISTINCT actor.
    await approveOfferVersion(tx, tenantId, crypto.randomUUID(), planKey, 1);
    const pub = await publishVersion(
      tx,
      tenantId,
      actor,
      planKey,
      1,
      scRegistry
    );
    if (!pub.ok)
      throw new Error(
        "seedOffer publishVersion failed: " + JSON.stringify(pub)
      );
  });
}

function buildDeps(tx: Bun.SQL) {
  return {
    catalogPort: createServiceCatalogReadPort(tx),
    moduleDescriptors: listModules()
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("tenant_entitlement — service layer", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  test("assign resolves offer grants + writes snapshot + emits event + audit (same-commit)", async () => {
    const tenantId = await seedTenant("as");
    await seedOffer(tenantId, "growth");
    const sql = getTestSql();

    await withTenant(sql, tenantId, (tx) =>
      assignEntitlement(
        tx,
        tenantId,
        actor,
        {
          planKey: "growth",
          offerVersion: 1,
          source: "manual",
          reason: null,
          effectiveFrom: null,
          effectiveTo: null,
          trialEndsAt: null,
          graceEndsAt: null
        },
        buildDeps(tx)
      )
    );

    await withTenant(sql, tenantId, async (tx) => {
      const ee = await resolveTenantEntitlement(
        tx,
        tenantId,
        buildDeps(tx),
        new Date()
      );
      expect(isFeatureAllowed(ee, "platform.api_access")).toBe(true);
      expect(isModuleEntitled(ee, "blog_content")).toBe(true);
      expect(getQuota(ee, "platform.api_calls").limit).toBe(1000);
    });

    // Event + audit + snapshot exist, discriminatively.
    await withTenant(sql, tenantId, async (tx) => {
      const events = (await tx`
        SELECT count(*)::int AS c FROM awcms_mini_domain_events
        WHERE tenant_id = ${tenantId} AND event_type = 'awcms-mini.tenant-entitlement.assignment.changed'
      `) as { c: number }[];
      expect(events[0]!.c).toBe(1);
      const audits = (await tx`
        SELECT count(*)::int AS c FROM awcms_mini_audit_events
        WHERE tenant_id = ${tenantId} AND module_key = 'tenant_entitlement'
          AND action = 'assign' AND resource_type = 'tenant_entitlement_assignment'
      `) as { c: number }[];
      expect(audits[0]!.c).toBe(1);
      const snapshots = (await tx`
        SELECT count(*)::int AS c FROM awcms_mini_tenant_entitlement_evaluation_snapshots
        WHERE tenant_id = ${tenantId}
      `) as { c: number }[];
      expect(snapshots[0]!.c).toBe(1);
    });
  });

  test("re-assign the same plan supersedes the current assignment (exactly one current)", async () => {
    const tenantId = await seedTenant("su");
    await seedOffer(tenantId, "growth");
    const sql = getTestSql();
    const assignOnce = () =>
      withTenant(sql, tenantId, (tx) =>
        assignEntitlement(
          tx,
          tenantId,
          actor,
          {
            planKey: "growth",
            offerVersion: 1,
            source: "manual",
            reason: null,
            effectiveFrom: null,
            effectiveTo: null,
            trialEndsAt: null,
            graceEndsAt: null
          },
          buildDeps(tx)
        )
      );
    await assignOnce();
    await assignOnce();

    await withTenant(sql, tenantId, async (tx) => {
      const all = await listAssignments(tx, tenantId);
      expect(all).toHaveLength(2);
      expect(all.filter((a) => a.isCurrent)).toHaveLength(1);
    });
  });

  test("Concurrency: two concurrent assigns to the same plan -> one ok, one clean conflict", async () => {
    const tenantId = await seedTenant("cc");
    await seedOffer(tenantId, "growth");
    const sql = getTestSql();
    const assignOnce = () =>
      withTenant(sql, tenantId, (tx) =>
        assignEntitlement(
          tx,
          tenantId,
          actor,
          {
            planKey: "growth",
            offerVersion: 1,
            source: "manual",
            reason: null,
            effectiveFrom: null,
            effectiveTo: null,
            trialEndsAt: null,
            graceEndsAt: null
          },
          buildDeps(tx)
        )
      );
    const [r1, r2] = await Promise.all([assignOnce(), assignOnce()]);
    const oks = [r1, r2].filter((r) => r.ok);
    const losers = [r1, r2].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.ok === false && losers[0]!.reason).toBe("conflict");
  });

  test("override create + resolve reflects; concurrent create -> one ok, one override_exists", async () => {
    const tenantId = await seedTenant("ov");
    const sql = getTestSql();
    const createOnce = () =>
      withTenant(sql, tenantId, (tx) =>
        createOverride(
          tx,
          tenantId,
          actor,
          {
            targetKind: "feature",
            targetKey: "platform.custom_domain",
            effect: "grant",
            quotaIsUnlimited: false,
            quotaLimitValue: null,
            quotaUnit: null,
            reason: "add-on",
            source: "addon",
            effectiveFrom: null,
            effectiveTo: null
          },
          entRegistry,
          buildDeps(tx)
        )
      );
    const [r1, r2] = await Promise.all([createOnce(), createOnce()]);
    expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
    const loser = [r1, r2].find((r) => !r.ok);
    expect(loser!.ok === false && loser!.reason).toBe("override_exists");

    await withTenant(sql, tenantId, async (tx) => {
      const ee = await resolveTenantEntitlement(
        tx,
        tenantId,
        buildDeps(tx),
        new Date()
      );
      expect(isFeatureAllowed(ee, "platform.custom_domain")).toBe(true);
    });
  });

  test("override revoke is one-way; concurrent revoke -> one ok, one already_revoked", async () => {
    const tenantId = await seedTenant("rv");
    const sql = getTestSql();
    const created = await withTenant(sql, tenantId, (tx) =>
      createOverride(
        tx,
        tenantId,
        actor,
        {
          targetKind: "feature",
          targetKey: "platform.api_access",
          effect: "deny",
          quotaIsUnlimited: false,
          quotaLimitValue: null,
          quotaUnit: null,
          reason: "restriction",
          source: "manual",
          effectiveFrom: null,
          effectiveTo: null
        },
        entRegistry,
        buildDeps(tx)
      )
    );
    const overrideId = created.ok ? created.override.id : "";
    const revokeOnce = () =>
      withTenant(sql, tenantId, (tx) =>
        revokeOverride(
          tx,
          tenantId,
          actor,
          overrideId,
          "no longer needed",
          buildDeps(tx)
        )
      );
    const [r1, r2] = await Promise.all([revokeOnce(), revokeOnce()]);
    expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
    const loser = [r1, r2].find((r) => !r.ok);
    expect(loser!.ok === false && loser!.reason).toBe("already_revoked");
  });

  test("suspend withholds grants; resume restores; cancel is terminal; illegal transition -> invalid", async () => {
    const tenantId = await seedTenant("tr");
    await seedOffer(tenantId, "growth");
    const sql = getTestSql();
    const assigned = await withTenant(sql, tenantId, (tx) =>
      assignEntitlement(
        tx,
        tenantId,
        actor,
        {
          planKey: "growth",
          offerVersion: 1,
          source: "manual",
          reason: null,
          effectiveFrom: null,
          effectiveTo: null,
          trialEndsAt: null,
          graceEndsAt: null
        },
        buildDeps(tx)
      )
    );
    const id = assigned.ok ? assigned.assignment.id : "";

    await withTenant(sql, tenantId, (tx) =>
      transitionAssignment(
        tx,
        tenantId,
        actor,
        id,
        "suspended",
        "billing hold",
        buildDeps(tx)
      )
    );
    await withTenant(sql, tenantId, async (tx) => {
      const ee = await resolveTenantEntitlement(
        tx,
        tenantId,
        buildDeps(tx),
        new Date()
      );
      expect(isFeatureAllowed(ee, "platform.api_access")).toBe(false);
    });

    await withTenant(sql, tenantId, (tx) =>
      transitionAssignment(
        tx,
        tenantId,
        actor,
        id,
        "active",
        null,
        buildDeps(tx)
      )
    );
    await withTenant(sql, tenantId, async (tx) => {
      const ee = await resolveTenantEntitlement(
        tx,
        tenantId,
        buildDeps(tx),
        new Date()
      );
      expect(isFeatureAllowed(ee, "platform.api_access")).toBe(true);
    });

    await withTenant(sql, tenantId, (tx) =>
      transitionAssignment(
        tx,
        tenantId,
        actor,
        id,
        "canceled",
        "closed account",
        buildDeps(tx)
      )
    );
    const illegal = await withTenant(sql, tenantId, (tx) =>
      transitionAssignment(
        tx,
        tenantId,
        actor,
        id,
        "active",
        null,
        buildDeps(tx)
      )
    );
    expect(illegal.ok === false && illegal.reason).toBe("invalid_transition");

    // Entitlement loss did NOT delete data — the row is still there (canceled).
    await withTenant(sql, tenantId, async (tx) => {
      const all = await listAssignments(tx, tenantId);
      expect(all.some((a) => a.id === id && a.status === "canceled")).toBe(
        true
      );
      const ee = await resolveTenantEntitlement(
        tx,
        tenantId,
        buildDeps(tx),
        new Date()
      );
      expect(isFeatureAllowed(ee, "platform.api_access")).toBe(false);
    });
  });

  test("cross-tenant: tenant A's entitlement never affects tenant B (RLS + resolution)", async () => {
    const tenantA = await seedTenant("ta");
    const tenantB = await seedTenant("tb");
    await seedOffer(tenantA, "growth");
    const sql = getTestSql();
    await withTenant(sql, tenantA, (tx) =>
      assignEntitlement(
        tx,
        tenantA,
        actor,
        {
          planKey: "growth",
          offerVersion: 1,
          source: "manual",
          reason: null,
          effectiveFrom: null,
          effectiveTo: null,
          trialEndsAt: null,
          graceEndsAt: null
        },
        buildDeps(tx)
      )
    );

    // B sees no assignment rows (RLS) and resolves to deny everything.
    await withTenant(sql, tenantB, async (tx) => {
      const bRows =
        (await tx`SELECT count(*)::int AS c FROM awcms_mini_tenant_entitlement_assignments`) as {
          c: number;
        }[];
      expect(bRows[0]!.c).toBe(0);
      const ee = await resolveTenantEntitlement(
        tx,
        tenantB,
        buildDeps(tx),
        new Date()
      );
      expect(isFeatureAllowed(ee, "platform.api_access")).toBe(false);
      expect(isModuleEntitled(ee, "blog_content")).toBe(false);
    });
    // A still sees its own.
    await withTenant(sql, tenantA, async (tx) => {
      const ee = await resolveTenantEntitlement(
        tx,
        tenantA,
        buildDeps(tx),
        new Date()
      );
      expect(isFeatureAllowed(ee, "platform.api_access")).toBe(true);
    });
  });

  test("DB immutability + write-once triggers reject raw tampering", async () => {
    const tenantId = await seedTenant("im");
    await seedOffer(tenantId, "growth");
    const sql = getTestSql();
    const assigned = await withTenant(sql, tenantId, (tx) =>
      assignEntitlement(
        tx,
        tenantId,
        actor,
        {
          planKey: "growth",
          offerVersion: 1,
          source: "manual",
          reason: null,
          effectiveFrom: null,
          effectiveTo: null,
          trialEndsAt: null,
          graceEndsAt: null
        },
        buildDeps(tx)
      )
    );
    const assignmentId = assigned.ok ? assigned.assignment.id : "";
    const created = await withTenant(sql, tenantId, (tx) =>
      createOverride(
        tx,
        tenantId,
        actor,
        {
          targetKind: "feature",
          targetKey: "platform.api_access",
          effect: "deny",
          quotaIsUnlimited: false,
          quotaLimitValue: null,
          quotaUnit: null,
          reason: "x",
          source: "manual",
          effectiveFrom: null,
          effectiveTo: null
        },
        entRegistry,
        buildDeps(tx)
      )
    );
    const overrideId = created.ok ? created.override.id : "";

    async function expectThrows(fn: () => Promise<unknown>): Promise<void> {
      let threw = false;
      try {
        await fn();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }

    await withTenant(sql, tenantId, async (tx) => {
      // frozen identity column
      await expectThrows(
        () =>
          tx`UPDATE awcms_mini_tenant_entitlement_assignments SET plan_key = 'other' WHERE id = ${assignmentId}`
      );
      // hard delete forbidden
      await expectThrows(
        () =>
          tx`DELETE FROM awcms_mini_tenant_entitlement_assignments WHERE id = ${assignmentId}`
      );
      // override content frozen
      await expectThrows(
        () =>
          tx`UPDATE awcms_mini_tenant_entitlement_overrides SET effect = 'grant' WHERE id = ${overrideId}`
      );
      // snapshot append-only (no UPDATE)
      await expectThrows(
        () =>
          tx`UPDATE awcms_mini_tenant_entitlement_evaluation_snapshots SET trigger = 'x' WHERE tenant_id = ${tenantId}`
      );
    });

    // Revoke then attempt to un-revoke (write-once).
    await withTenant(sql, tenantId, (tx) =>
      revokeOverride(tx, tenantId, actor, overrideId, "done", buildDeps(tx))
    );
    await withTenant(sql, tenantId, async (tx) => {
      await expectThrows(
        () =>
          tx`UPDATE awcms_mini_tenant_entitlement_overrides SET revoked_at = NULL WHERE id = ${overrideId}`
      );
    });
  });

  test("DB CHECK rejects a quota-shaped override on a feature target", async () => {
    const tenantId = await seedTenant("ck");
    const admin = getAdminSql();
    let threw = false;
    try {
      await admin`
        INSERT INTO awcms_mini_tenant_entitlement_overrides
          (tenant_id, target_kind, target_key, effect, quota_is_unlimited, quota_limit_value, quota_unit, reason)
        VALUES (${tenantId}, 'feature', 'platform.api_access', 'grant', false, 100, 'requests', 'bad')
      `;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("contract: a reviewed derived-style feature + quota key resolves; unknown key fails closed", async () => {
    const tenantId = await seedTenant("co");
    await seedOffer(tenantId, "growth");
    const sql = getTestSql();
    await withTenant(sql, tenantId, (tx) =>
      assignEntitlement(
        tx,
        tenantId,
        actor,
        {
          planKey: "growth",
          offerVersion: 1,
          source: "manual",
          reason: null,
          effectiveFrom: null,
          effectiveTo: null,
          trialEndsAt: null,
          graceEndsAt: null
        },
        buildDeps(tx)
      )
    );
    await withTenant(sql, tenantId, async (tx) => {
      const ee = await resolveTenantEntitlement(
        tx,
        tenantId,
        buildDeps(tx),
        new Date()
      );
      // platform.api_access (feature) + platform.api_calls (meter) are reviewed
      // static-registry contributions proving the derived-key seam end-to-end.
      expect(isFeatureAllowed(ee, "platform.api_access")).toBe(true);
      expect(getQuota(ee, "platform.api_calls").allowed).toBe(true);
      // An unknown override key fails closed (400 validation).
      const bad = await createOverride(
        tx,
        tenantId,
        actor,
        {
          targetKind: "feature",
          targetKey: "bogus.unknown",
          effect: "grant",
          quotaIsUnlimited: false,
          quotaLimitValue: null,
          quotaUnit: null,
          reason: "x",
          source: "manual",
          effectiveFrom: null,
          effectiveTo: null
        },
        entRegistry,
        buildDeps(tx)
      );
      expect(bad.ok === false && bad.reason).toBe("validation");
    });
  });

  test("perf: resolution query count is CONSTANT regardless of the number of feature/quota keys (no per-key N+1)", async () => {
    const smallTenant = await seedTenant("ps");
    await seedOffer(smallTenant, "small");
    // Large offer: many module-kind features (all valid module keys) + all meter keys.
    const moduleFeatures = listModules()
      .slice(0, 20)
      .map((m) => ({
        featureKind: "module" as const,
        featureKey: m.key,
        enabled: true,
        metadata: {}
      }));
    const largeTenant = await seedTenant("pl");
    await seedOffer(largeTenant, "large", {
      features: moduleFeatures,
      quotas: [
        "platform.api_calls",
        "platform.active_users",
        "platform.storage_bytes"
      ].map((meterKey) => ({
        meterKey,
        isUnlimited: false,
        limitValue: 100,
        unit: "units",
        resetPolicy: "monthly" as const,
        metadata: {}
      }))
    });
    const sql = getTestSql();
    await withTenant(sql, smallTenant, (tx) =>
      assignEntitlement(
        tx,
        smallTenant,
        actor,
        {
          planKey: "small",
          offerVersion: 1,
          source: "manual",
          reason: null,
          effectiveFrom: null,
          effectiveTo: null,
          trialEndsAt: null,
          graceEndsAt: null
        },
        buildDeps(tx)
      )
    );
    await withTenant(sql, largeTenant, (tx) =>
      assignEntitlement(
        tx,
        largeTenant,
        actor,
        {
          planKey: "large",
          offerVersion: 1,
          source: "manual",
          reason: null,
          effectiveFrom: null,
          effectiveTo: null,
          trialEndsAt: null,
          graceEndsAt: null
        },
        buildDeps(tx)
      )
    );

    function countingProxy(tx: Bun.SQL): { sql: Bun.SQL; count: () => number } {
      let n = 0;
      const p = new Proxy(tx as unknown as object, {
        apply(target, thisArg, args) {
          n++;
          return Reflect.apply(
            target as (...a: unknown[]) => unknown,
            thisArg,
            args
          );
        },
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        }
      });
      return { sql: p as unknown as Bun.SQL, count: () => n };
    }

    let smallCount = 0;
    let largeCount = 0;
    await withTenant(sql, smallTenant, async (tx) => {
      const c = countingProxy(tx);
      await resolveTenantEntitlement(
        c.sql,
        smallTenant,
        {
          catalogPort: createServiceCatalogReadPort(c.sql),
          moduleDescriptors: listModules()
        },
        new Date()
      );
      smallCount = c.count();
    });
    await withTenant(sql, largeTenant, async (tx) => {
      const c = countingProxy(tx);
      await resolveTenantEntitlement(
        c.sql,
        largeTenant,
        {
          catalogPort: createServiceCatalogReadPort(c.sql),
          moduleDescriptors: listModules()
        },
        new Date()
      );
      largeCount = c.count();
    });

    // Two record reads + one published-offer read per distinct offer (=1 here).
    expect(smallCount).toBe(largeCount);
    expect(smallCount).toBeLessThanOrEqual(4);
  });

  test("fail-closed port: a tenant with tenant_entitlement DISABLED resolves to deny-all, even with stale assignments", async () => {
    const tenantId = await seedTenant("fd");
    await seedOffer(tenantId, "growth");
    const sql = getTestSql();
    await withTenant(sql, tenantId, (tx) =>
      assignEntitlement(
        tx,
        tenantId,
        actor,
        {
          planKey: "growth",
          offerVersion: 1,
          source: "manual",
          reason: null,
          effectiveFrom: null,
          effectiveTo: null,
          trialEndsAt: null,
          graceEndsAt: null
        },
        buildDeps(tx)
      )
    );
    // No awcms_mini_tenant_modules row -> tenant_entitlement default-disabled.
    await withTenant(sql, tenantId, async (tx) => {
      expect(
        await resolveModuleEnabled(tx, tenantId, "tenant_entitlement")
      ).toBe(false);
      const port = createEffectiveEntitlementPort(tx, tenantId, buildDeps(tx));
      const snap = await port.snapshot();
      expect(snap.status).toBe("disabled");
      expect(await port.isFeatureAllowed("platform.api_access")).toBe(false);
      expect((await port.getQuota("platform.api_calls")).allowed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Route-level: auth/ABAC gate, idempotency, module-enabled, entitlement != permission
// ---------------------------------------------------------------------------

const OPERATOR_PASSWORD = "tenant-entitlement-operator-password";

async function bootstrapOperator(
  tenantCode: string,
  enableEntitlement: boolean
): Promise<{ tenantId: string; token: string }> {
  const loginIdentifier = `${tenantCode}-owner@example.com`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: `TE ${tenantCode}`,
      tenantCode,
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: loginIdentifier,
      ownerPassword: OPERATOR_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  const tenantId = setup.body.data.tenantId;

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password: OPERATOR_PASSWORD },
    cookies: createCookieJar()
  });

  const admin = getAdminSql();
  await admin.begin((tx) => syncModuleDescriptors(tx as unknown as Bun.SQL));
  if (enableEntitlement) {
    await admin`
      INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key, enabled, enabled_at)
      VALUES (${tenantId}, 'tenant_entitlement', true, now())
      ON CONFLICT (tenant_id, module_key) DO UPDATE SET enabled = true, enabled_at = now()
    `;
  }
  return { tenantId, token: login.body.data.token };
}

/**
 * Issue #879 (epic #868 Wave 2, ADR-0022 §5): `tenant_entitlement` now
 * declares a `global_within_tenant` SoD rule
 * (`tenant_entitlement.override_vs_audit_review`) enforced at the high-risk
 * `overrides.override` step. The setup-wizard OWNER role grants EVERY
 * permission, so it holds BOTH halves of that conflict
 * (`tenant_entitlement.overrides.override` AND `logging.audit_trail.read`) —
 * the intended AC behavior (a single actor cannot complete the flow without
 * an approved exception), the same effect the shipped
 * `data_lifecycle.legal_hold_maker_checker` rule already has on the owner.
 * Tests below that legitimately need the owner to author an override seed the
 * AC-sanctioned escape hatch: an APPROVED, time-bounded SoD exception. Tests
 * that assert the conflict IS enforced simply omit this call.
 */
async function grantApprovedOverrideSodException(
  tenantId: string
): Promise<void> {
  const admin = getAdminSql();
  const users = (await admin`
    SELECT id FROM awcms_mini_tenant_users WHERE tenant_id = ${tenantId} LIMIT 1
  `) as { id: string }[];
  const ownerUserId = users[0]?.id;
  if (!ownerUserId) {
    throw new Error("no tenant_user found for the freshly set-up tenant");
  }
  await admin`
    INSERT INTO awcms_mini_sod_conflict_exceptions
      (tenant_id, rule_key, subject_tenant_user_id, scope_type, scope_id,
       justification, requested_by_tenant_user_id, approved_by_tenant_user_id,
       status, effective_from, effective_to)
    VALUES (
      ${tenantId}, 'tenant_entitlement.override_vs_audit_review', ${ownerUserId},
      NULL, NULL,
      'Owner super-role holds audit-review + override in this control-plane test; SoD exception approved (Issue #879).',
      ${ownerUserId}, ${ownerUserId}, 'approved',
      now() - interval '1 hour', now() + interval '1 day'
    )
  `;
}

const routeSuite = integrationEnabled ? describe : describe.skip;

routeSuite("tenant_entitlement — routes", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  function headers(
    tenantId: string,
    token: string,
    idempotencyKey?: string
  ): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId,
      authorization: `Bearer ${token}`
    };
    if (idempotencyKey) h["idempotency-key"] = idempotencyKey;
    return h;
  }

  test("module-enabled gate: a fully-permitted operator is 403 MODULE_DISABLED when tenant_entitlement is not enabled", async () => {
    const { tenantId, token } = await bootstrapOperator("temd", false);
    const res = await invoke<{ error: { code: string } }>(effectiveRoute, {
      method: "GET",
      path: "/api/v1/tenant-entitlement/effective",
      headers: headers(tenantId, token)
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("MODULE_DISABLED");
  });

  test("assign via route -> 200; effective reflects it; response matches the OpenAPI schema", async () => {
    const { tenantId, token } = await bootstrapOperator("teok", true);
    await seedOffer(tenantId, "growth");

    const assign = await invoke<{ data: { assignment: unknown } }>(
      assignRoute,
      {
        method: "POST",
        path: "/api/v1/tenant-entitlement/assignments",
        headers: headers(tenantId, token, "assign-key-1"),
        body: { planKey: "growth", offerVersion: 1 }
      }
    );
    expect(assign.status).toBe(200);

    const doc = loadOpenApiDocument(
      "openapi/awcms-mini-public-api.openapi.yaml"
    );
    const assignSchema = getResponseSchema(doc, {
      path: "/api/v1/tenant-entitlement/assignments",
      method: "POST",
      status: "200"
    });
    expect(validateAgainstSchema(assign.body, assignSchema, doc)).toEqual([]);

    const eff = await invoke<{
      data: { entitlement: { features: Record<string, { allowed: boolean }> } };
    }>(effectiveRoute, {
      method: "GET",
      path: "/api/v1/tenant-entitlement/effective",
      headers: headers(tenantId, token)
    });
    expect(eff.status).toBe(200);
    expect(
      eff.body.data.entitlement.features["platform.api_access"]!.allowed
    ).toBe(true);
    const effSchema = getResponseSchema(doc, {
      path: "/api/v1/tenant-entitlement/effective",
      method: "GET",
      status: "200"
    });
    expect(validateAgainstSchema(eff.body, effSchema, doc)).toEqual([]);
  });

  test("idempotency: same Idempotency-Key replays the same response", async () => {
    const { tenantId, token } = await bootstrapOperator("teidem", true);
    await seedOffer(tenantId, "growth");
    const body = { planKey: "growth", offerVersion: 1 };
    const r1 = await invoke(assignRoute, {
      method: "POST",
      path: "/api/v1/tenant-entitlement/assignments",
      headers: headers(tenantId, token, "same-key"),
      body
    });
    const r2 = await invoke(assignRoute, {
      method: "POST",
      path: "/api/v1/tenant-entitlement/assignments",
      headers: headers(tenantId, token, "same-key"),
      body
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Deep equality (the replayed body is jsonb round-tripped, so key ORDER
    // differs but the content must be identical).
    expect(r1.body).toEqual(r2.body);

    // Exactly one assignment persisted (the replay did not re-run the mutation).
    await withTenant(getTestSql(), tenantId, async (tx) => {
      const all = await listAssignments(tx, tenantId);
      expect(all).toHaveLength(1);
    });
  });

  test("entitlement != permission: a fully-ENTITLED tenant is still 403 when the actor lacks the ABAC permission", async () => {
    const { tenantId, token } = await bootstrapOperator("teabac", true);
    await seedOffer(tenantId, "growth");
    // The tenant IS entitled (assign succeeds).
    await invoke(assignRoute, {
      method: "POST",
      path: "/api/v1/tenant-entitlement/assignments",
      headers: headers(tenantId, token, "k1"),
      body: { planKey: "growth", offerVersion: 1 }
    });

    // Revoke the actor's overrides.override permission (ABAC now denies it).
    await getAdminSql()`
      DELETE FROM awcms_mini_role_permissions
      WHERE tenant_id = ${tenantId}
        AND permission_id = (
          SELECT id FROM awcms_mini_permissions
          WHERE module_key = 'tenant_entitlement' AND activity_code = 'overrides' AND action = 'override'
        )
    `;

    const res = await invoke<{ error: { code: string } }>(
      overridesCreateRoute,
      {
        method: "POST",
        path: "/api/v1/tenant-entitlement/overrides",
        headers: headers(tenantId, token, "k2"),
        body: {
          targetKind: "feature",
          targetKey: "platform.custom_domain",
          effect: "grant",
          reason: "should be denied by ABAC"
        }
      }
    );
    // A positive commercial entitlement cannot bypass the ABAC deny.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });

  test("assignments list route is gated + returns the tenant's assignments", async () => {
    const { tenantId, token } = await bootstrapOperator("telist", true);
    await seedOffer(tenantId, "growth");
    await invoke(assignRoute, {
      method: "POST",
      path: "/api/v1/tenant-entitlement/assignments",
      headers: headers(tenantId, token, "k1"),
      body: { planKey: "growth", offerVersion: 1 }
    });
    const res = await invoke<{ data: { assignments: unknown[] } }>(
      assignmentsListRoute,
      {
        method: "GET",
        path: "/api/v1/tenant-entitlement/assignments",
        headers: headers(tenantId, token)
      }
    );
    expect(res.status).toBe(200);
    expect(res.body.data.assignments).toHaveLength(1);
  });

  test("Fix 1: revoking an override without a reason -> 400 (reason required)", async () => {
    const { tenantId, token } = await bootstrapOperator("terev", true);
    // The owner super-role holds both halves of the #879
    // override-vs-audit-review SoD rule; this test authors an override, so it
    // needs the AC-sanctioned approved exception (see helper above).
    await grantApprovedOverrideSodException(tenantId);
    const created = await invoke<{ data: { override: { id: string } } }>(
      overridesCreateRoute,
      {
        method: "POST",
        path: "/api/v1/tenant-entitlement/overrides",
        headers: headers(tenantId, token, "k1"),
        body: {
          targetKind: "feature",
          targetKey: "platform.custom_domain",
          effect: "grant",
          reason: "add-on"
        }
      }
    );
    expect(created.status).toBe(200);
    const overrideId = created.body.data.override.id;

    const noReason = await invoke<{ error: { code: string } }>(
      overrideRevokeRoute,
      {
        method: "POST",
        path: `/api/v1/tenant-entitlement/overrides/${overrideId}/revoke`,
        headers: headers(tenantId, token, "k2"),
        params: { overrideId },
        body: {}
      }
    );
    expect(noReason.status).toBe(400);

    const withReason = await invoke(overrideRevokeRoute, {
      method: "POST",
      path: `/api/v1/tenant-entitlement/overrides/${overrideId}/revoke`,
      headers: headers(tenantId, token, "k3"),
      params: { overrideId },
      body: { reason: "no longer needed" }
    });
    expect(withReason.status).toBe(200);
  });

  test("Issue #879: an operator holding override + audit-review is BLOCKED (403 SOD_CONFLICT) with NO approved exception", async () => {
    // Adversarial + mutation proof for the #879 control-plane SoD rule
    // `tenant_entitlement.override_vs_audit_review`, enforced at the real
    // `authorizeInTransaction` chokepoint (NOT UI hiding). The owner
    // super-role holds BOTH conflicting permissions
    // (`overrides.override` + `logging.audit_trail.read`); WITHOUT the
    // approved SoD exception the high-risk `override` is refused with a safe
    // error that enumerates neither tenant nor resource. Deleting the SoD
    // rule from `tenant_entitlement/module.ts` makes this test fail — the
    // enforcement is wired, not theater.
    const { tenantId, token } = await bootstrapOperator("tesod", true);
    const blocked = await invoke<{ error: { code: string } }>(
      overridesCreateRoute,
      {
        method: "POST",
        path: "/api/v1/tenant-entitlement/overrides",
        headers: headers(tenantId, token, "ksod1"),
        body: {
          targetKind: "feature",
          targetKey: "platform.custom_domain",
          effect: "grant",
          reason: "should be blocked by SoD"
        }
      }
    );
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("SOD_CONFLICT");

    // Same actor, same action, now WITH an approved exception -> allowed.
    await grantApprovedOverrideSodException(tenantId);
    const allowed = await invoke<{ data: { override: { id: string } } }>(
      overridesCreateRoute,
      {
        method: "POST",
        path: "/api/v1/tenant-entitlement/overrides",
        headers: headers(tenantId, token, "ksod2"),
        body: {
          targetKind: "feature",
          targetKey: "platform.custom_domain",
          effect: "grant",
          reason: "approved via SoD exception"
        }
      }
    );
    expect(allowed.status).toBe(200);
  });

  test("Fix 3: GET /effective with a PAST at is rejected (400); now/future is accepted", async () => {
    const { tenantId, token } = await bootstrapOperator("teat", true);
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const pastRes = await invoke<{ error: { code: string } }>(effectiveRoute, {
      method: "GET",
      path: `/api/v1/tenant-entitlement/effective?at=${encodeURIComponent(past)}`,
      headers: headers(tenantId, token)
    });
    expect(pastRes.status).toBe(400);

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const futureRes = await invoke(effectiveRoute, {
      method: "GET",
      path: `/api/v1/tenant-entitlement/effective?at=${encodeURIComponent(future)}`,
      headers: headers(tenantId, token)
    });
    expect(futureRes.status).toBe(200);
  });
});
