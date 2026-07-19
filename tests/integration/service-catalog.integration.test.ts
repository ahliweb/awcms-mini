/**
 * Integration tests for `service_catalog` against real PostgreSQL (Issue
 * #870, epic #868, ADR-0022). Covers the full lifecycle, DB-level immutability
 * triggers, least-privilege grants (no DELETE on the projection / plans),
 * duplicate-key/version conflicts, the tenant-readable projection excluding
 * internal prices, and the runtime default-disabled resolution
 * (`resolveModuleEnabled`).
 *
 * MUTATION-GUARD (AC): "editing a published version ... must make tests fail"
 * — the immutability tests (`publishVersion` then a rejected edit, and the raw
 * DB-trigger UPDATE) are that guard.
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
import { resolveModuleEnabled } from "../../src/modules/identity-access/application/auth-context";
import { syncModuleDescriptors } from "../../src/modules/module-management/application/descriptor-sync";
import { resolveServiceCatalogKeyRegistry } from "../../src/modules/service-catalog/domain/key-registry";
import {
  createPlan,
  createDraftVersion,
  fetchPlanDetail,
  publishVersion,
  retireVersion,
  updatePlanDraft
} from "../../src/modules/service-catalog/application/plan-directory";
import { listPublishedOffers } from "../../src/modules/service-catalog/application/service-catalog-read-query";
import type { VersionContentInput } from "../../src/modules/service-catalog/domain/plan";

const registry = resolveServiceCatalogKeyRegistry(listModules());
const actor = "00000000-0000-0000-0000-0000000000aa";

function content(
  overrides: Partial<VersionContentInput> = {}
): VersionContentInput {
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
      },
      {
        componentKey: "internal_cost",
        amountMinor: 4000000,
        currency: "IDR",
        interval: "monthly",
        visibility: "internal",
        metadata: {}
      }
    ],
    ...overrides
  };
}

async function seedTenant(): Promise<string> {
  const admin = getAdminSql();
  const rows = (await admin`
    INSERT INTO awcms_mini_tenants (tenant_code, tenant_name, status)
    VALUES (${"sc" + Math.random().toString(36).slice(2, 8)}, 'Service Catalog Test', 'active')
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

const suite = integrationEnabled ? describe : describe.skip;

suite(
  "service_catalog — lifecycle, immutability, grants, default-disabled",
  () => {
    beforeAll(async () => {
      await applyMigrations();
      await provisionAppRole();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    test("full lifecycle: create -> publish -> projection (public prices only) -> retire", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();

      await withTenant(sql, tenantId, async (tx) => {
        const created = await createPlan(
          tx,
          tenantId,
          actor,
          {
            planKey: "starter",
            name: "Starter",
            description: null,
            planType: "subscription",
            content: content()
          },
          registry
        );
        expect(created.ok).toBe(true);

        const published = await publishVersion(
          tx,
          tenantId,
          actor,
          "starter",
          1,
          registry
        );
        expect(published.ok).toBe(true);
        if (published.ok) {
          expect(published.offerHash).toHaveLength(64);
          expect(published.alreadyPublished).toBe(false);
        }

        const offers = await listPublishedOffers(tx, { planKey: "starter" });
        expect(offers).toHaveLength(1);
        // Medium-1: internal-visibility price is NOT projected to the tenant surface.
        expect(offers[0]!.prices.map((p) => p.componentKey)).toEqual(["base"]);
        expect(offers[0]!.features).toHaveLength(1);
        expect(offers[0]!.quotas).toHaveLength(1);

        const retired = await retireVersion(tx, tenantId, actor, "starter", 1);
        expect(retired.ok).toBe(true);

        const detail = await fetchPlanDetail(tx, "starter");
        expect(detail?.versions[0]!.status).toBe("retired");
        // Operator detail still shows ALL prices (incl. internal); the projection did not.
        expect(detail?.versions[0]!.prices).toHaveLength(2);
      });

      // The retired offer row stays readable (retired_at set, row present).
      await withTenant(sql, tenantId, async (tx) => {
        const all = await listPublishedOffers(tx, { planKey: "starter" });
        expect(all).toHaveLength(1);
        expect(all[0]!.retiredAt).not.toBeNull();
        const activeOnly = await listPublishedOffers(tx, {
          planKey: "starter",
          activeOnly: true
        });
        expect(activeOnly).toHaveLength(0);
      });
    });

    test("MUTATION-GUARD: a published version cannot be edited in place (application layer)", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await withTenant(sql, tenantId, async (tx) => {
        await createPlan(
          tx,
          tenantId,
          actor,
          {
            planKey: "immut",
            name: "Immut",
            description: null,
            planType: "subscription",
            content: content()
          },
          registry
        );
        await publishVersion(tx, tenantId, actor, "immut", 1, registry);
        const edit = await updatePlanDraft(
          tx,
          tenantId,
          actor,
          "immut",
          { name: "Changed" },
          registry
        );
        expect(edit.ok).toBe(false);
        if (!edit.ok) expect(edit.reason).toBe("no_draft_version");
      });
    });

    test("MUTATION-GUARD: the DB trigger rejects a raw UPDATE of published content", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      let versionId = "";
      await withTenant(sql, tenantId, async (tx) => {
        await createPlan(
          tx,
          tenantId,
          actor,
          {
            planKey: "trig",
            name: "Trig",
            description: null,
            planType: "subscription",
            content: content()
          },
          registry
        );
        await publishVersion(tx, tenantId, actor, "trig", 1, registry);
        const rows =
          (await tx`SELECT v.id FROM awcms_mini_service_catalog_plan_versions v JOIN awcms_mini_service_catalog_plans p ON p.id=v.plan_id WHERE p.plan_key='trig'`) as {
            id: string;
          }[];
        versionId = rows[0]!.id;
      });

      // Separate transaction (the trigger raise aborts its own tx).
      let blocked = false;
      try {
        await withTenant(sql, tenantId, async (tx) => {
          await tx`UPDATE awcms_mini_service_catalog_plan_versions SET currency='USD' WHERE id=${versionId}`;
        });
      } catch {
        blocked = true;
      }
      expect(blocked).toBe(true);

      // And the child-row trigger rejects mutating a published version's prices.
      let childBlocked = false;
      try {
        await withTenant(sql, tenantId, async (tx) => {
          await tx`INSERT INTO awcms_mini_service_catalog_version_prices (version_id, component_key, amount_minor, currency, interval, visibility, metadata) VALUES (${versionId}, 'extra', 1, 'IDR', 'monthly', 'public', '{}'::jsonb)`;
        });
      } catch {
        childBlocked = true;
      }
      expect(childBlocked).toBe(true);
    });

    test("least-privilege: app role has NO DELETE on the projection or plans", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await withTenant(sql, tenantId, async (tx) => {
        await createPlan(
          tx,
          tenantId,
          actor,
          {
            planKey: "grant",
            name: "Grant",
            description: null,
            planType: "subscription",
            content: content()
          },
          registry
        );
        await publishVersion(tx, tenantId, actor, "grant", 1, registry);
      });

      let offerDeleteBlocked = false;
      try {
        await withTenant(sql, tenantId, async (tx) => {
          await tx`DELETE FROM awcms_mini_service_catalog_published_offers WHERE plan_key='grant'`;
        });
      } catch {
        offerDeleteBlocked = true;
      }
      expect(offerDeleteBlocked).toBe(true);

      let planDeleteBlocked = false;
      try {
        await withTenant(sql, tenantId, async (tx) => {
          await tx`DELETE FROM awcms_mini_service_catalog_plans WHERE plan_key='grant'`;
        });
      } catch {
        planDeleteBlocked = true;
      }
      expect(planDeleteBlocked).toBe(true);
    });

    test("corrections create a new version; existing published versions stay readable (409 on duplicate key)", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await withTenant(sql, tenantId, async (tx) => {
        await createPlan(
          tx,
          tenantId,
          actor,
          {
            planKey: "multi",
            name: "Multi",
            description: null,
            planType: "subscription",
            content: content()
          },
          registry
        );
        await publishVersion(tx, tenantId, actor, "multi", 1, registry);

        // Duplicate plan key -> deterministic conflict.
        const dup = await createPlan(
          tx,
          tenantId,
          actor,
          {
            planKey: "multi",
            name: "Dup",
            description: null,
            planType: "subscription",
            content: content()
          },
          registry
        );
        expect(dup.ok).toBe(false);
        if (!dup.ok) expect(dup.reason).toBe("duplicate_key");

        // A correction: new draft version (v2), edit, publish.
        const v2 = await createDraftVersion(
          tx,
          tenantId,
          actor,
          "multi",
          registry
        );
        expect(v2.ok).toBe(true);
        await updatePlanDraft(
          tx,
          tenantId,
          actor,
          "multi",
          {
            content: {
              currency: "USD",
              prices: [
                {
                  componentKey: "base",
                  amountMinor: 500,
                  currency: "USD",
                  interval: "monthly",
                  visibility: "public",
                  metadata: {}
                }
              ]
            }
          },
          registry
        );
        const pub2 = await publishVersion(
          tx,
          tenantId,
          actor,
          "multi",
          2,
          registry
        );
        expect(pub2.ok).toBe(true);

        const offers = await listPublishedOffers(tx, { planKey: "multi" });
        // BOTH v1 and v2 are readable.
        expect(offers.map((o) => o.version).sort()).toEqual([1, 2]);
        const v1 = offers.find((o) => o.version === 1)!;
        expect(v1.currency).toBe("IDR"); // v1 unchanged after v2 published
      });
    });

    test("publish is idempotent (re-publish returns alreadyPublished)", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await withTenant(sql, tenantId, async (tx) => {
        await createPlan(
          tx,
          tenantId,
          actor,
          {
            planKey: "idem",
            name: "Idem",
            description: null,
            planType: "subscription",
            content: content()
          },
          registry
        );
        const first = await publishVersion(
          tx,
          tenantId,
          actor,
          "idem",
          1,
          registry
        );
        const second = await publishVersion(
          tx,
          tenantId,
          actor,
          "idem",
          1,
          registry
        );
        expect(first.ok && !first.alreadyPublished).toBe(true);
        expect(second.ok && second.alreadyPublished).toBe(true);
      });
    });

    test("runtime default-disabled: service_catalog resolves DISABLED without a tenant_modules row, ENABLED after opt-in", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await withTenant(sql, tenantId, async (tx) => {
        // No row -> control-plane module is disabled; an ordinary module is enabled.
        expect(
          await resolveModuleEnabled(tx, tenantId, "service_catalog")
        ).toBe(false);
        expect(await resolveModuleEnabled(tx, tenantId, "blog_content")).toBe(
          true
        );

        // Opt the platform tenant in (sync registry for the FK, then enable).
        await syncModuleDescriptors(tx);
        await tx`
        INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key, enabled, enabled_at, enabled_by)
        VALUES (${tenantId}, 'service_catalog', true, now(), ${actor})
      `;
        expect(
          await resolveModuleEnabled(tx, tenantId, "service_catalog")
        ).toBe(true);
      });
    });
  }
);
