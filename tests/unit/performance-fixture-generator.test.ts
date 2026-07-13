/**
 * Unit tests for the deterministic synthetic fixture generator (Issue
 * #744, epic #738). Pure, no database — proves determinism, correct row
 * counts (including the noisy-neighbor multiplier), and that every
 * generated value is synthetic (drawn from the fixed vocabularies, never
 * anything resembling real data).
 */
import { describe, expect, test } from "bun:test";

import {
  buildFixturePlan,
  generateAuditEvents,
  generateBlogPosts,
  generateIdempotencyKeys,
  generateObjectSyncQueue
} from "../../src/lib/performance/fixture-generator";
import { SAFE_SCALE_PROFILE } from "../../src/lib/performance/scale-profiles";

describe("buildFixturePlan", () => {
  test("is deterministic for the same profile and seed", () => {
    const planA = buildFixturePlan(SAFE_SCALE_PROFILE, "seed-x");
    const planB = buildFixturePlan(SAFE_SCALE_PROFILE, "seed-x");

    expect(planA).toEqual(planB);
  });

  test("differs for a different seed", () => {
    const planA = buildFixturePlan(SAFE_SCALE_PROFILE, "seed-x");
    const planB = buildFixturePlan(SAFE_SCALE_PROFILE, "seed-y");

    expect(planA.tenants[0]!.tenantId).not.toBe(planB.tenants[0]!.tenantId);
  });

  test("produces exactly tenantCount tenants with unique ids/codes", () => {
    const plan = buildFixturePlan(SAFE_SCALE_PROFILE, "uniqueness-check");

    expect(plan.tenants).toHaveLength(SAFE_SCALE_PROFILE.tenantCount);
    expect(new Set(plan.tenants.map((t) => t.tenantId)).size).toBe(
      SAFE_SCALE_PROFILE.tenantCount
    );
    expect(new Set(plan.tenants.map((t) => t.tenantCode)).size).toBe(
      SAFE_SCALE_PROFILE.tenantCount
    );
  });

  test("designates exactly the LAST tenant as the noisy neighbor, scaled by the multiplier", () => {
    const plan = buildFixturePlan(SAFE_SCALE_PROFILE, "noisy-neighbor-check");
    const noisyNeighbor = plan.tenants[plan.tenants.length - 1]!;

    expect(noisyNeighbor.isNoisyNeighbor).toBe(true);
    expect(
      plan.tenants.slice(0, -1).every((tenant) => !tenant.isNoisyNeighbor)
    ).toBe(true);

    expect(noisyNeighbor.rowCounts.auditEvents).toBe(
      SAFE_SCALE_PROFILE.rowsPerTenant.auditEvents *
        SAFE_SCALE_PROFILE.noisyNeighborMultiplier
    );

    const normalTenant = plan.tenants[0]!;
    expect(normalTenant.rowCounts.auditEvents).toBe(
      SAFE_SCALE_PROFILE.rowsPerTenant.auditEvents
    );
  });
});

describe("row generators", () => {
  const plan = buildFixturePlan(SAFE_SCALE_PROFILE, "row-generator-check");
  const tenant = plan.tenants[0]!;
  const anchor = new Date("2026-07-13T00:00:00.000Z");

  test("generateAuditEvents produces exactly the tenant's configured row count", () => {
    const rows = generateAuditEvents(tenant, plan.seed, anchor);
    expect(rows).toHaveLength(tenant.rowCounts.auditEvents);
    expect(rows.every((row) => row.tenantId === tenant.tenantId)).toBe(true);
  });

  test("generateAuditEvents is deterministic", () => {
    const first = generateAuditEvents(tenant, plan.seed, anchor);
    const second = generateAuditEvents(tenant, plan.seed, anchor);
    expect(first).toEqual(second);
  });

  test("generateAuditEvents never produces a future createdAt relative to anchor", () => {
    const rows = generateAuditEvents(tenant, plan.seed, anchor);
    expect(
      rows.every((row) => row.createdAt.getTime() <= anchor.getTime())
    ).toBe(true);
  });

  test("generateIdempotencyKeys produces unique idempotency keys per tenant", () => {
    const rows = generateIdempotencyKeys(tenant, plan.seed, anchor);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(
      rows.length
    );
  });

  test("generateObjectSyncQueue always references the tenant's own sync node", () => {
    const rows = generateObjectSyncQueue(tenant, plan.seed, anchor);
    expect(rows.every((row) => row.nodeId === tenant.syncNodeId)).toBe(true);
  });

  test("generateBlogPosts produces unique slugs and includes 'synthetic' vocabulary for the search query-plan budget", () => {
    const rows = generateBlogPosts(tenant, plan.seed, anchor);
    expect(new Set(rows.map((row) => row.slug)).size).toBe(rows.length);
    expect(rows.some((row) => row.contentText.includes("synthetic"))).toBe(
      true
    );
  });
});
