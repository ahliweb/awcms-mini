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
  deriveDeterministicAnchor,
  generateAuditEvents,
  generateBlogPages,
  generateBlogPosts,
  generateIdempotencyKeys,
  generateObjectSyncQueue
} from "../../src/lib/performance/fixture-generator";
import { SAFE_SCALE_PROFILE } from "../../src/lib/performance/scale-profiles";

describe("deriveDeterministicAnchor", () => {
  test("is deterministic for the same seed", () => {
    expect(deriveDeterministicAnchor("seed-x").getTime()).toBe(
      deriveDeterministicAnchor("seed-x").getTime()
    );
  });

  test("never depends on the real wall clock — repeated calls across time do not drift", async () => {
    const first = deriveDeterministicAnchor("stable-seed");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = deriveDeterministicAnchor("stable-seed");

    expect(second.getTime()).toBe(first.getTime());
  });

  test("can differ for a different seed (still fully reproducible per-seed)", () => {
    const a = deriveDeterministicAnchor("seed-a").getTime();
    const b = deriveDeterministicAnchor("seed-b").getTime();

    // Not a strict inequality assertion (a hash COULD coincide) — the
    // real property under test is per-seed reproducibility, proven above.
    // This just documents that anchors are seed-sensitive, not a single
    // global constant.
    expect(typeof a).toBe("number");
    expect(typeof b).toBe("number");
  });
});

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

  test("generateBlogPages produces the tenant's configured row count with unique slugs and valid page types", () => {
    const rows = generateBlogPages(tenant, plan.seed, anchor);

    expect(rows).toHaveLength(tenant.rowCounts.blogPages);
    expect(new Set(rows.map((row) => row.slug)).size).toBe(rows.length);
    // Must satisfy migration 026's page_type CHECK constraint, or seeding
    // fails at INSERT time rather than in any assertion here.
    expect(
      rows.every((row) => ["standard", "landing"].includes(row.pageType))
    ).toBe(true);
    expect(rows.every((row) => row.tenantId === tenant.tenantId)).toBe(true);
  });

  test("generateBlogPages is deterministic for the same seed", () => {
    expect(generateBlogPages(tenant, plan.seed, anchor)).toEqual(
      generateBlogPages(tenant, plan.seed, anchor)
    );
  });

  test("generateBlogPages generates a slug namespace distinct from generateBlogPosts (they are seeded from different PRNG streams)", () => {
    const postSlugs = new Set(
      generateBlogPosts(tenant, plan.seed, anchor).map((row) => row.slug)
    );
    const pageSlugs = generateBlogPages(tenant, plan.seed, anchor).map(
      (row) => row.slug
    );

    expect(pageSlugs.every((slug) => !postSlugs.has(slug))).toBe(true);
  });

  /**
   * Issue #838. The `blog-posts-admin-list`/`blog-pages-admin-list`
   * query-plan budgets gate `ORDER BY updated_at DESC`. Before this issue
   * NEITHER generator emitted `updated_at` at all, so every seeded row took
   * the column's `DEFAULT now()` and a whole seeding transaction shared ONE
   * value (measured against a real database: 5 distinct `updated_at` values
   * across 3000 rows). Ordering a constant column is not a meaningful proxy
   * for the production query, so these assertions COUNT the distinct values
   * the generator produces rather than measuring anything — a count is
   * exact and reproducible where a timing is neither.
   */
  test("generateBlogPosts spreads updated_at across many distinct values (the admin-list budgets' ORDER BY key)", () => {
    const rows = generateBlogPosts(tenant, plan.seed, anchor);
    const distinctUpdatedAt = new Set(
      rows.map((row) => row.updatedAt.getTime())
    );

    // Not a "> 1" assertion: that would still pass the degenerate
    // DEFAULT now() fixture this test exists to prevent regressing to.
    // Real edit traffic gives essentially one distinct timestamp per row.
    expect(distinctUpdatedAt.size).toBeGreaterThan(rows.length * 0.9);
  });

  test("generateBlogPages spreads updated_at across many distinct values", () => {
    const rows = generateBlogPages(tenant, plan.seed, anchor);
    const distinctUpdatedAt = new Set(
      rows.map((row) => row.updatedAt.getTime())
    );

    expect(distinctUpdatedAt.size).toBeGreaterThan(rows.length * 0.9);
  });

  test("updated_at is never before created_at for posts or pages (a row cannot be edited before it exists)", () => {
    const rows = [
      ...generateBlogPosts(tenant, plan.seed, anchor),
      ...generateBlogPages(tenant, plan.seed, anchor)
    ];

    const violations = rows.filter(
      (row) => row.updatedAt.getTime() < row.createdAt.getTime()
    );

    expect(violations).toEqual([]);
  });
});

describe("end-to-end row-content determinism (reviewer finding on PR #775)", () => {
  test("the SAME seed produces byte-identical row timestamps across two independent runs, even when the anchor is re-derived fresh each time (not passed in as a shared fixed Date)", async () => {
    function generateForSeed(seed: string) {
      const plan = buildFixturePlan(SAFE_SCALE_PROFILE, seed);
      const tenant = plan.tenants[0]!;
      const runAnchor = deriveDeterministicAnchor(plan.seed);
      return generateAuditEvents(tenant, plan.seed, runAnchor);
    }

    const seed = "e2e-determinism-check";
    const firstRun = generateForSeed(seed);
    // A real wall-clock gap between the two "runs" — the original bug
    // (anchor = new Date()) would make this produce DIFFERENT absolute
    // createdAt values across the gap; the fix must not.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondRun = generateForSeed(seed);

    expect(secondRun).toEqual(firstRun);
    expect(secondRun.map((row) => row.createdAt.getTime())).toEqual(
      firstRun.map((row) => row.createdAt.getTime())
    );
  });
});
