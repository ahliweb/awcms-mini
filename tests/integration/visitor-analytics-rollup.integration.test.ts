/**
 * Integration tests for `rollupVisitorAnalyticsForDate` (Issue #624, epic:
 * visitor analytics #617-#624) against a real PostgreSQL — proves the
 * scheduled `bun run analytics:rollup` job's core aggregation is idempotent
 * (rerunning the same date never double-counts) and computes the expected
 * per-area counts/top-N arrays from real `awcms_mini_visit_events` rows.
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
import { rollupVisitorAnalyticsForDate } from "../../src/modules/visitor-analytics/application/rollup";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ROLLUP_DATE = "2026-06-15";

async function seedTenant(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${TENANT_A}, 'tenant-a', 'Tenant A', 'Tenant A Legal', 'active', 'en', 'light')
  `;
}

/** A real identity row so `identity_id`'s FK is satisfiable for "authenticated" fixtures. */
async function seedIdentity(loginIdentifier: string): Promise<string> {
  const admin = getAdminSql();
  const passwordHash = await Bun.password.hash("rollup-test-password");

  const profile = (await admin`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${TENANT_A}, 'person', 'Rollup Test User') RETURNING id
  `) as { id: string }[];

  const identity = (await admin`
    INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${TENANT_A}, ${profile[0]!.id}, ${loginIdentifier}, ${passwordHash})
    RETURNING id
  `) as { id: string }[];

  return identity[0]!.id;
}

async function seedSession(
  overrides: Partial<{
    visitorKeyHash: string;
    area: string;
    lastSeenAt: Date;
  }> = {}
): Promise<string> {
  const admin = getAdminSql();
  const rows = (await admin`
    INSERT INTO awcms_mini_visitor_sessions
      (tenant_id, visitor_key_hash, area, last_seen_at, ip_hash, user_agent_hash)
    VALUES (
      ${TENANT_A},
      ${overrides.visitorKeyHash ?? `sha256:${crypto.randomUUID()}`},
      ${overrides.area ?? "public"},
      ${overrides.lastSeenAt ?? new Date(`${ROLLUP_DATE}T10:00:00.000Z`)},
      'sha256:iphash',
      'sha256:uahash'
    )
    RETURNING id
  `) as { id: string }[];

  return rows[0]!.id;
}

async function seedEvent(
  sessionId: string,
  overrides: Partial<{
    occurredAt: Date;
    area: string;
    humanStatus: string;
    pathSanitized: string;
    identityId: string | null;
    userAgentParsed: Record<string, unknown>;
    geo: Record<string, unknown>;
  }> = {}
): Promise<void> {
  const admin = getAdminSql();

  // Bind plain objects as jsonb params directly (never `JSON.stringify`
  // first) — see [[bun-sql-jsonb-stringify-trap]].
  await admin`
    INSERT INTO awcms_mini_visit_events
      (tenant_id, visitor_session_id, identity_id, method, area, path_sanitized,
       human_status, occurred_at, user_agent_parsed, geo)
    VALUES (
      ${TENANT_A}, ${sessionId}, ${overrides.identityId ?? null}, 'GET',
      ${overrides.area ?? "public"},
      ${overrides.pathSanitized ?? "/news/hello"},
      ${overrides.humanStatus ?? "human"},
      ${overrides.occurredAt ?? new Date(`${ROLLUP_DATE}T10:00:00.000Z`)},
      ${overrides.userAgentParsed ?? { browserName: "Chrome", deviceType: "desktop" }}::jsonb,
      ${overrides.geo ?? { countryCode: "ID" }}::jsonb
    )
  `;
}

async function fetchRollupRows(): Promise<Record<string, unknown>[]> {
  const admin = getAdminSql();
  return (await admin`
    SELECT * FROM awcms_mini_visitor_daily_rollups
    WHERE tenant_id = ${TENANT_A} AND date = ${ROLLUP_DATE}
    ORDER BY area
  `) as Record<string, unknown>[];
}

const suite = integrationEnabled ? describe : describe.skip;

suite("rollupVisitorAnalyticsForDate (Issue #624)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
  });

  test("computes per-area aggregates and top-N arrays from raw events", async () => {
    const sql = getTestSql();
    const publicSession1 = await seedSession({ area: "public" });
    const publicSession2 = await seedSession({ area: "public" });
    const adminIdentityId = await seedIdentity("owner@rollup-test.example");
    const adminSession = await seedSession({ area: "admin" });

    // Two human pageviews from two distinct public sessions, same path.
    await seedEvent(publicSession1, {
      area: "public",
      pathSanitized: "/news/a",
      userAgentParsed: { browserName: "Chrome", deviceType: "desktop" }
    });
    await seedEvent(publicSession2, {
      area: "public",
      pathSanitized: "/news/a",
      userAgentParsed: { browserName: "Firefox", deviceType: "mobile" }
    });
    // One bot pageview, same area.
    await seedEvent(publicSession1, {
      area: "public",
      humanStatus: "bot",
      pathSanitized: "/news/b"
    });
    // One authenticated admin pageview.
    await seedEvent(adminSession, {
      area: "admin",
      identityId: adminIdentityId,
      pathSanitized: "/admin/dashboard"
    });

    const result = await withTenant(sql, TENANT_A, (tx) =>
      rollupVisitorAnalyticsForDate(tx, TENANT_A, ROLLUP_DATE)
    );

    expect(result.areasProcessed).toBe(2);
    expect(result.areas.sort()).toEqual(["admin", "public"]);

    const rows = await fetchRollupRows();
    expect(rows).toHaveLength(2);

    const publicRow = rows.find((row) => row.area === "public")!;
    expect(publicRow.human_unique_visitors).toBe(2);
    expect(publicRow.human_pageviews).toBe(2);
    expect(publicRow.bot_pageviews).toBe(1);
    expect(publicRow.public_unique_visitors).toBe(2);
    expect(publicRow.admin_unique_users).toBe(0);
    expect(publicRow.top_paths).toEqual([{ name: "/news/a", count: 2 }]);

    const adminRow = rows.find((row) => row.area === "admin")!;
    expect(adminRow.human_unique_visitors).toBe(1);
    expect(adminRow.human_pageviews).toBe(1);
    expect(adminRow.admin_unique_users).toBe(1);
    expect(adminRow.authenticated_unique_users).toBe(1);
    expect(adminRow.public_unique_visitors).toBe(0);
  });

  test("is idempotent: rerunning the same date never double-counts", async () => {
    const sql = getTestSql();
    const session = await seedSession({ area: "public" });

    await seedEvent(session, { pathSanitized: "/news/repeat" });
    await seedEvent(session, { pathSanitized: "/news/repeat" });

    const firstRun = await withTenant(sql, TENANT_A, (tx) =>
      rollupVisitorAnalyticsForDate(tx, TENANT_A, ROLLUP_DATE)
    );
    expect(firstRun.areasProcessed).toBe(1);

    const firstRows = await fetchRollupRows();
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]!.human_pageviews).toBe(2);
    expect(firstRows[0]!.human_unique_visitors).toBe(1);

    // Rerun the exact same date with no new events in between.
    const secondRun = await withTenant(sql, TENANT_A, (tx) =>
      rollupVisitorAnalyticsForDate(tx, TENANT_A, ROLLUP_DATE)
    );
    expect(secondRun.areasProcessed).toBe(1);

    const secondRows = await fetchRollupRows();
    expect(secondRows).toHaveLength(1);
    // Still exactly 2 — a naive "increment" implementation would show 4.
    expect(secondRows[0]!.human_pageviews).toBe(2);
    expect(secondRows[0]!.human_unique_visitors).toBe(1);
    expect(secondRows[0]!.top_paths).toEqual(firstRows[0]!.top_paths);

    // A THIRD rerun after a new event lands should reflect the new total,
    // proving this is a full recompute-and-overwrite, not a frozen cache.
    await seedEvent(session, { pathSanitized: "/news/repeat" });
    const thirdRun = await withTenant(sql, TENANT_A, (tx) =>
      rollupVisitorAnalyticsForDate(tx, TENANT_A, ROLLUP_DATE)
    );
    expect(thirdRun.areasProcessed).toBe(1);

    const thirdRows = await fetchRollupRows();
    expect(thirdRows[0]!.human_pageviews).toBe(3);
  });

  test("an area with zero events for the date gets no rollup row", async () => {
    const sql = getTestSql();
    const session = await seedSession({ area: "public" });
    await seedEvent(session, {
      occurredAt: new Date(`${ROLLUP_DATE}T10:00:00.000Z`)
    });

    const result = await withTenant(sql, TENANT_A, (tx) =>
      rollupVisitorAnalyticsForDate(tx, TENANT_A, ROLLUP_DATE)
    );

    expect(result.areas).toEqual(["public"]);

    const rows = await fetchRollupRows();
    expect(rows).toHaveLength(1);
    expect(rows.some((row) => row.area === "admin")).toBe(false);
  });

  test("events outside the requested date are excluded from the rollup", async () => {
    const sql = getTestSql();
    const session = await seedSession({ area: "public" });
    await seedEvent(session, {
      occurredAt: new Date(`${ROLLUP_DATE}T23:59:59.000Z`)
    });
    // One day later — must not be counted into ROLLUP_DATE's row.
    await seedEvent(session, {
      occurredAt: new Date("2026-06-16T00:00:01.000Z")
    });

    await withTenant(sql, TENANT_A, (tx) =>
      rollupVisitorAnalyticsForDate(tx, TENANT_A, ROLLUP_DATE)
    );

    const rows = await fetchRollupRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.human_pageviews).toBe(1);
  });
});
