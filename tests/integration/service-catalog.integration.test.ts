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
import { buildOfferSnapshot } from "../../src/modules/service-catalog/domain/offer-snapshot";
import type { VersionContentInput } from "../../src/modules/service-catalog/domain/plan";
import { ok } from "../../src/modules/_shared/api-response";
import {
  getResponseSchema,
  loadOpenApiDocument,
  validateAgainstSchema
} from "../../scripts/lib/openapi-response-validator";

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

    async function seedPlan(tenantId: string, planKey: string): Promise<void> {
      const sql = getTestSql();
      await withTenant(sql, tenantId, (tx) =>
        createPlan(
          tx,
          tenantId,
          actor,
          {
            planKey,
            name: planKey,
            description: null,
            planType: "subscription",
            content: content()
          },
          registry
        )
      );
    }

    test("re-publishing a published version is rejected (not_draft) — no idempotent re-publish at the service layer", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await seedPlan(tenantId, "reidem");
      await withTenant(sql, tenantId, (tx) =>
        publishVersion(tx, tenantId, actor, "reidem", 1, registry)
      );
      const second = await withTenant(sql, tenantId, (tx) =>
        publishVersion(tx, tenantId, actor, "reidem", 1, registry)
      );
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe("not_draft");
    });

    test("Fix 2: concurrent publish -> exactly one succeeds, the loser gets a clean not_draft, one offer + one event + one audit", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await seedPlan(tenantId, "race");

      const [r1, r2] = await Promise.all([
        withTenant(sql, tenantId, (tx) =>
          publishVersion(tx, tenantId, actor, "race", 1, registry)
        ),
        withTenant(sql, tenantId, (tx) =>
          publishVersion(tx, tenantId, actor, "race", 1, registry)
        )
      ]);

      const oks = [r1, r2].filter((r) => r.ok);
      const losers = [r1, r2].filter((r) => !r.ok);
      expect(oks).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.ok === false && losers[0]!.reason).toBe("not_draft");

      await withTenant(sql, tenantId, async (tx) => {
        const offers = await listPublishedOffers(tx, { planKey: "race" });
        expect(offers).toHaveLength(1);

        const events = (await tx`
          SELECT count(*)::int AS c FROM awcms_mini_domain_events
          WHERE tenant_id = ${tenantId}
            AND event_type = 'awcms-mini.service-catalog.offer.published'
        `) as { c: number }[];
        expect(events[0]!.c).toBe(1);

        const audits = (await tx`
          SELECT count(*)::int AS c FROM awcms_mini_audit_events
          WHERE tenant_id = ${tenantId} AND module_key = 'service_catalog'
            AND action = 'publish' AND resource_type = 'service_catalog_offer'
        `) as { c: number }[];
        expect(audits[0]!.c).toBe(1);
      });
    });

    test("Fix 2: concurrent retire -> one succeeds, one clean not_published, exactly one retired event + one audit", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await seedPlan(tenantId, "retrace");
      await withTenant(sql, tenantId, (tx) =>
        publishVersion(tx, tenantId, actor, "retrace", 1, registry)
      );

      const [r1, r2] = await Promise.all([
        withTenant(sql, tenantId, (tx) =>
          retireVersion(tx, tenantId, actor, "retrace", 1)
        ),
        withTenant(sql, tenantId, (tx) =>
          retireVersion(tx, tenantId, actor, "retrace", 1)
        )
      ]);
      expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
      const losers = [r1, r2].filter((r) => !r.ok);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.ok === false && losers[0]!.reason).toBe(
        "not_published"
      );

      await withTenant(sql, tenantId, async (tx) => {
        const events = (await tx`
          SELECT count(*)::int AS c FROM awcms_mini_domain_events
          WHERE tenant_id = ${tenantId}
            AND event_type = 'awcms-mini.service-catalog.offer.retired'
        `) as { c: number }[];
        expect(events[0]!.c).toBe(1);
        const audits = (await tx`
          SELECT count(*)::int AS c FROM awcms_mini_audit_events
          WHERE tenant_id = ${tenantId} AND module_key = 'service_catalog'
            AND action = 'retire'
        `) as { c: number }[];
        expect(audits[0]!.c).toBe(1);
      });
    });

    test("Fix 3: publish + retire write a discriminative audit row AND append the matching domain event", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await seedPlan(tenantId, "trail");
      await withTenant(sql, tenantId, (tx) =>
        publishVersion(tx, tenantId, actor, "trail", 1, registry)
      );
      await withTenant(sql, tenantId, (tx) =>
        retireVersion(tx, tenantId, actor, "trail", 1)
      );

      await withTenant(sql, tenantId, async (tx) => {
        // Discriminative: filter by action + resource_type + event_type (never a 0-vs-0 count).
        const publishAudit = (await tx`
          SELECT count(*)::int AS c FROM awcms_mini_audit_events
          WHERE tenant_id = ${tenantId} AND action = 'publish'
            AND resource_type = 'service_catalog_offer'
        `) as { c: number }[];
        const retireAudit = (await tx`
          SELECT count(*)::int AS c FROM awcms_mini_audit_events
          WHERE tenant_id = ${tenantId} AND action = 'retire'
            AND resource_type = 'service_catalog_offer'
        `) as { c: number }[];
        expect(publishAudit[0]!.c).toBe(1);
        expect(retireAudit[0]!.c).toBe(1);

        const events = (await tx`
          SELECT event_type FROM awcms_mini_domain_events
          WHERE tenant_id = ${tenantId}
            AND event_type LIKE 'awcms-mini.service-catalog.offer.%'
          ORDER BY event_type
        `) as { event_type: string }[];
        expect(events.map((e) => e.event_type)).toEqual([
          "awcms-mini.service-catalog.offer.published",
          "awcms-mini.service-catalog.offer.retired"
        ]);
      });
    });

    test("Fix 1: the DB trigger rejects a raw status regression (published -> draft), closing the child-edit bypass", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await seedPlan(tenantId, "statusguard");
      let versionId = "";
      await withTenant(sql, tenantId, async (tx) => {
        await publishVersion(tx, tenantId, actor, "statusguard", 1, registry);
        const rows = (await tx`
          SELECT v.id FROM awcms_mini_service_catalog_plan_versions v
          JOIN awcms_mini_service_catalog_plans p ON p.id = v.plan_id
          WHERE p.plan_key = 'statusguard'
        `) as { id: string }[];
        versionId = rows[0]!.id;
      });

      let regressionBlocked = false;
      try {
        await withTenant(sql, tenantId, async (tx) => {
          await tx`UPDATE awcms_mini_service_catalog_plan_versions SET status = 'draft' WHERE id = ${versionId}`;
        });
      } catch {
        regressionBlocked = true;
      }
      expect(regressionBlocked).toBe(true);

      // And the children are still frozen (status stayed 'published').
      let childStillFrozen = false;
      try {
        await withTenant(sql, tenantId, async (tx) => {
          await tx`INSERT INTO awcms_mini_service_catalog_version_features (version_id, feature_kind, feature_key, enabled, metadata) VALUES (${versionId}, 'feature', 'platform.api_access', true, '{}'::jsonb)`;
        });
      } catch {
        childStillFrozen = true;
      }
      expect(childStillFrozen).toBe(true);
    });

    test("Codex-C: concurrent draft PATCH + publish -> published projection is consistent with the version's final stored content (no stale offerHash)", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await seedPlan(tenantId, "cpatch");

      await Promise.all([
        withTenant(sql, tenantId, (tx) =>
          updatePlanDraft(
            tx,
            tenantId,
            actor,
            "cpatch",
            {
              content: {
                prices: [
                  {
                    componentKey: "base",
                    amountMinor: 12345,
                    currency: "IDR",
                    interval: "monthly",
                    visibility: "public",
                    metadata: {}
                  }
                ]
              }
            },
            registry
          )
        ),
        withTenant(sql, tenantId, (tx) =>
          publishVersion(tx, tenantId, actor, "cpatch", 1, registry)
        )
      ]).catch(() => undefined); // either ordering is acceptable; assert the invariant below

      await withTenant(sql, tenantId, async (tx) => {
        const detail = await fetchPlanDetail(tx, "cpatch");
        const v1 = detail!.versions.find((v) => v.version === 1)!;
        if (v1.status === "published") {
          const offers = await listPublishedOffers(tx, { planKey: "cpatch" });
          expect(offers).toHaveLength(1);
          // The offer hash the projection carries must equal a hash re-derived
          // from the version's ACTUAL stored content — proving publish snapshotted
          // the FINAL locked state, not a stale pre-lock read.
          const derived = buildOfferSnapshot("cpatch", 1, {
            currency: v1.currency,
            market: v1.market,
            trialEnabled: v1.trialEnabled,
            trialDays: v1.trialDays,
            availableFrom: v1.availableFrom,
            availableTo: v1.availableTo,
            notes: v1.notes,
            features: v1.features,
            quotas: v1.quotas,
            prices: v1.prices
          });
          expect(offers[0]!.offerHash).toBe(derived.offerHash);
          expect(v1.offerHash).toBe(derived.offerHash);
        }
      });
    });

    test("Fix 4: the DB CHECK rejects an amount above Number.MAX_SAFE_INTEGER", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await seedPlan(tenantId, "bignum");
      let rejected = false;
      try {
        await withTenant(sql, tenantId, async (tx) => {
          const rows = (await tx`
            SELECT v.id FROM awcms_mini_service_catalog_plan_versions v
            JOIN awcms_mini_service_catalog_plans p ON p.id = v.plan_id
            WHERE p.plan_key = 'bignum'
          `) as { id: string }[];
          await tx`INSERT INTO awcms_mini_service_catalog_version_prices (version_id, component_key, amount_minor, currency, interval, visibility, metadata) VALUES (${rows[0]!.id}, 'huge', 9007199254740992, 'IDR', 'monthly', 'public', '{}'::jsonb)`;
        });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });

    test("N1: fetchPlanDetail output validates against the published OpenAPI schema (real mapper vs schema)", async () => {
      const tenantId = await seedTenant();
      const sql = getTestSql();
      await seedPlan(tenantId, "contract");
      await withTenant(sql, tenantId, (tx) =>
        publishVersion(tx, tenantId, actor, "contract", 1, registry)
      );

      const doc = loadOpenApiDocument(
        "openapi/awcms-mini-public-api.openapi.yaml"
      );
      const schema = getResponseSchema(doc, {
        path: "/api/v1/service-catalog/plans/{planKey}",
        method: "GET",
        status: "200"
      });

      await withTenant(sql, tenantId, async (tx) => {
        const plan = await fetchPlanDetail(tx, "contract");
        const body = await ok({ plan }).json();
        const problems = validateAgainstSchema(body, schema, doc);
        expect(problems).toEqual([]);
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
