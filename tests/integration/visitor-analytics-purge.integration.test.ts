/**
 * Integration tests for `purgeVisitorAnalyticsForAllTenants` (Issue #624,
 * epic: visitor analytics #617-#624 — `bun run analytics:purge`'s
 * multi-tenant iteration + audit-summary wrapper around
 * `purgeVisitorAnalyticsData`) against a real PostgreSQL.
 *
 * Deliberately does NOT re-test the four retention cutoffs themselves
 * (event delete / raw-detail clear / session delete / rollup delete) —
 * those are already covered end-to-end, including the FK-straddle edge
 * case, by `tests/integration/visitor-analytics-api.integration.test.ts`'s
 * `POST /api/v1/analytics/retention/purge` tests, which call the exact
 * same `purgeVisitorAnalyticsData` function this script calls. This file
 * only covers what the SCRIPT adds on top: iterating every active tenant,
 * summing totals across tenants, and writing a `retention_purged` audit
 * event only for tenants where something was actually purged.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

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
import { purgeVisitorAnalyticsForAllTenants } from "../../scripts/visitor-analytics-purge";
import { VISITOR_ANALYTICS_DEFAULTS } from "../../src/modules/visitor-analytics/domain/visitor-analytics-config";

const TENANT_STALE = "88888888-8888-8888-8888-888888888888";
const TENANT_FRESH = "99999999-9999-9999-9999-999999999999";

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_mini_tenants (id, tenant_code, tenant_name)
    VALUES (${id}, ${code}, ${code})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedSession(
  tenantId: string,
  lastSeenAt: Date
): Promise<string> {
  const admin = getAdminSql();
  const rows = (await admin`
    INSERT INTO awcms_mini_visitor_sessions
      (tenant_id, visitor_key_hash, area, last_seen_at, ip_hash, user_agent_hash)
    VALUES (
      ${tenantId}, ${`sha256:${crypto.randomUUID()}`}, 'public', ${lastSeenAt},
      'sha256:iphash', 'sha256:uahash'
    )
    RETURNING id
  `) as { id: string }[];

  return rows[0]!.id;
}

async function seedSessionWithIp(
  tenantId: string,
  lastSeenAt: Date
): Promise<string> {
  const admin = getAdminSql();
  const rows = (await admin`
    INSERT INTO awcms_mini_visitor_sessions
      (tenant_id, visitor_key_hash, area, last_seen_at, ip_address, ip_hash, user_agent_hash)
    VALUES (
      ${tenantId}, ${`sha256:${crypto.randomUUID()}`}, 'public', ${lastSeenAt},
      '203.0.113.9', 'sha256:iphash', 'sha256:uahash'
    )
    RETURNING id
  `) as { id: string }[];

  return rows[0]!.id;
}

async function seedEvent(
  tenantId: string,
  sessionId: string,
  occurredAt: Date
): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_mini_visit_events
      (tenant_id, visitor_session_id, method, area, path_sanitized, human_status, occurred_at)
    VALUES (${tenantId}, ${sessionId}, 'GET', 'public', '/news/old', 'human', ${occurredAt})
  `;
}

async function fetchAuditRows(
  tenantId: string
): Promise<{ action: string; severity: string }[]> {
  return withTenant(getTestSql(), tenantId, async (tx) => {
    return (await tx`
      SELECT action, severity FROM awcms_mini_audit_events
      WHERE tenant_id = ${tenantId} AND action = 'retention_purged'
    `) as { action: string; severity: string }[];
  });
}

const suite = integrationEnabled ? describe : describe.skip;

suite("purgeVisitorAnalyticsForAllTenants (Issue #624)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_STALE, "purge-script-stale");
    await seedTenant(TENANT_FRESH, "purge-script-fresh");
  });

  test("purges only the tenant with expired data, sums totals, and audits only that tenant", async () => {
    const now = new Date();
    const eventRetentionDays = VISITOR_ANALYTICS_DEFAULTS.eventRetentionDays;
    const staleAt = new Date(
      now.getTime() - (eventRetentionDays + 5) * 24 * 60 * 60 * 1000
    );
    const freshAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

    const staleSession = await seedSession(TENANT_STALE, staleAt);
    await seedEvent(TENANT_STALE, staleSession, staleAt);

    const freshSession = await seedSession(TENANT_FRESH, freshAt);
    await seedEvent(TENANT_FRESH, freshSession, freshAt);

    const result = await purgeVisitorAnalyticsForAllTenants(getTestSql(), {
      now
    });

    // At least our two seeded tenants — other suites' `beforeAll` running
    // in the same DB session do not leak rows across `resetDatabase()`.
    expect(result.tenantsChecked).toBeGreaterThanOrEqual(2);
    expect(result.tenantsPurged).toBe(1);
    expect(result.totals.eventsDeleted).toBe(1);

    const staleAudit = await fetchAuditRows(TENANT_STALE);
    expect(staleAudit).toHaveLength(1);
    expect(staleAudit[0]!.severity).toBe("critical");

    const freshAudit = await fetchAuditRows(TENANT_FRESH);
    expect(freshAudit).toHaveLength(0);
  });

  test("no tenant has expired data: zero purged, zero audit events, no error", async () => {
    const now = new Date();
    const freshAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    const session = await seedSession(TENANT_FRESH, freshAt);
    await seedEvent(TENANT_FRESH, session, freshAt);

    const result = await purgeVisitorAnalyticsForAllTenants(getTestSql(), {
      now
    });

    expect(result.tenantsPurged).toBe(0);
    expect(result.totals.eventsDeleted).toBe(0);

    const freshAudit = await fetchAuditRows(TENANT_FRESH);
    expect(freshAudit).toHaveLength(0);
  });

  test("a custom config (e.g. a shorter override) is honored across every tenant", async () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const session = await seedSession(TENANT_STALE, twoDaysAgo);
    await seedEvent(TENANT_STALE, session, twoDaysAgo);

    const result = await purgeVisitorAnalyticsForAllTenants(getTestSql(), {
      now,
      config: { ...VISITOR_ANALYTICS_DEFAULTS, eventRetentionDays: 1 }
    });

    expect(result.tenantsPurged).toBe(1);
    expect(result.totals.eventsDeleted).toBe(1);
  });

  test("runs successfully under the real awcms_mini_worker role, including the raw-detail UPDATE step (Issue #683, epic #679)", async () => {
    const now = new Date();
    // Older than rawDetailRetentionDays (30) but younger than
    // eventRetentionDays (90): only the UPDATE (raw-detail clear) step
    // fires, not the session/event DELETE — isolates the exact statement a
    // missing awcms_mini_worker UPDATE grant would break (PR #703 review
    // caught this live: without UPDATE on awcms_mini_visitor_sessions, this
    // whole transaction rolled back with "permission denied").
    const staleAt = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
    const session = await seedSessionWithIp(TENANT_STALE, staleAt);
    await seedEvent(TENANT_STALE, session, staleAt);

    const result = await purgeVisitorAnalyticsForAllTenants(
      getWorkerTestSql(),
      { now }
    );

    expect(result.tenantsPurged).toBe(1);
    expect(result.totals.sessionsRawDetailCleared).toBe(1);
  });
});
