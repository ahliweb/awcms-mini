/**
 * Integration tests for the visitor analytics schema/RLS (Issue #618,
 * epic: visitor analytics #617-#624) against a real PostgreSQL.
 * Schema-only issue — no middleware collector (#620), UA parser (#619),
 * or API (#621) exist yet — this exercises migration 039's constraints
 * and RLS enforcement directly via `withTenant`/raw admin SQL, the same
 * pattern `tenant-domain-schema.integration.test.ts` (#557) used.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

async function seedTenants(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${TENANT_A}, 'tenant-a', 'Tenant A', 'Tenant A Legal', 'active', 'en', 'light'),
      (${TENANT_B}, 'tenant-b', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
  `;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("visitor analytics schema — RLS isolation and constraints", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenants();
  });

  test("db:migrate is idempotent when run twice", async () => {
    await expect(applyMigrations()).resolves.toBeUndefined();

    const admin = getAdminSql();
    const tables = (await admin`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'awcms_mini_visitor_sessions',
          'awcms_mini_visit_events',
          'awcms_mini_visitor_daily_rollups'
        )
      ORDER BY table_name
    `) as { table_name: string }[];

    expect(tables.map((row) => row.table_name)).toEqual([
      "awcms_mini_visit_events",
      "awcms_mini_visitor_daily_rollups",
      "awcms_mini_visitor_sessions"
    ]);
  });

  test("rejects an unknown area on visitor_sessions", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_visitor_sessions
          (tenant_id, visitor_key_hash, area)
        VALUES (${TENANT_A}, 'hash-1', 'bogus')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("rejects an unknown device_type on visitor_sessions", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_visitor_sessions
          (tenant_id, visitor_key_hash, area, device_type)
        VALUES (${TENANT_A}, 'hash-1', 'public', 'smart-fridge')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("accepts a minimal visitor_sessions row with only required columns", async () => {
    const admin = getAdminSql();
    const rows = await admin`
      INSERT INTO awcms_mini_visitor_sessions
        (tenant_id, visitor_key_hash, area)
      VALUES (${TENANT_A}, 'hash-1', 'public')
      RETURNING id, is_human, is_authenticated, ip_address, login_identifier_snapshot
    `;

    expect(rows).toHaveLength(1);
    const row = (rows as Record<string, unknown>[])[0]!;
    expect(row.is_human).toBe(true);
    expect(row.is_authenticated).toBe(false);
    expect(row.ip_address).toBeNull();
    expect(row.login_identifier_snapshot).toBeNull();
  });

  test("rejects an unknown human_status on visit_events", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_visit_events
          (tenant_id, method, area, path_sanitized, human_status)
        VALUES (${TENANT_A}, 'GET', 'public', '/news', 'robot')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("rejects a status_code outside the valid HTTP range", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_visit_events
          (tenant_id, method, status_code, area, path_sanitized, human_status)
        VALUES (${TENANT_A}, 'GET', 999, 'public', '/news', 'human')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("accepts a minimal visit_events row and defaults jsonb columns to empty", async () => {
    const admin = getAdminSql();
    const rows = await admin`
      INSERT INTO awcms_mini_visit_events
        (tenant_id, method, area, path_sanitized, human_status)
      VALUES (${TENANT_A}, 'GET', 'public', '/news', 'human')
      RETURNING user_agent_parsed, geo, status_code
    `;

    expect(rows).toHaveLength(1);
    const row = (rows as Record<string, unknown>[])[0]!;
    expect(row.user_agent_parsed).toEqual({});
    expect(row.geo).toEqual({});
    expect(row.status_code).toBeNull();
  });

  test("visitor_daily_rollups upserts on its (tenant_id, date, area) primary key", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_visitor_daily_rollups
        (tenant_id, date, area, human_pageviews)
      VALUES (${TENANT_A}, '2026-07-10', 'public', 5)
    `;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_visitor_daily_rollups
          (tenant_id, date, area, human_pageviews)
        VALUES (${TENANT_A}, '2026-07-10', 'public', 9)
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);

    await admin`
      UPDATE awcms_mini_visitor_daily_rollups
      SET human_pageviews = 9
      WHERE tenant_id = ${TENANT_A} AND date = '2026-07-10' AND area = 'public'
    `;

    const rows = await admin`
      SELECT human_pageviews FROM awcms_mini_visitor_daily_rollups
      WHERE tenant_id = ${TENANT_A} AND date = '2026-07-10' AND area = 'public'
    `;
    expect((rows as { human_pageviews: number }[])[0]?.human_pageviews).toBe(9);
  });

  for (const table of [
    "awcms_mini_visitor_sessions",
    "awcms_mini_visit_events",
    "awcms_mini_visitor_daily_rollups"
  ] as const) {
    test(`${table}: tenant A cannot see tenant B's rows (RLS isolation)`, async () => {
      const admin = getAdminSql();

      if (table === "awcms_mini_visitor_daily_rollups") {
        await admin`
          INSERT INTO awcms_mini_visitor_daily_rollups (tenant_id, date, area)
          VALUES (${TENANT_A}, '2026-07-10', 'public'), (${TENANT_B}, '2026-07-10', 'public')
        `;
      } else if (table === "awcms_mini_visitor_sessions") {
        await admin`
          INSERT INTO awcms_mini_visitor_sessions (tenant_id, visitor_key_hash, area)
          VALUES (${TENANT_A}, 'hash-a', 'public'), (${TENANT_B}, 'hash-b', 'public')
        `;
      } else {
        await admin`
          INSERT INTO awcms_mini_visit_events
            (tenant_id, method, area, path_sanitized, human_status)
          VALUES
            (${TENANT_A}, 'GET', 'public', '/news', 'human'),
            (${TENANT_B}, 'GET', 'public', '/news', 'human')
        `;
      }

      const sql = getDatabaseClient();
      const rows = await withTenant(sql, TENANT_A, (tx) =>
        tx.unsafe(`SELECT tenant_id FROM "${table}"`)
      );

      expect(rows).toHaveLength(1);
      expect((rows as { tenant_id: string }[])[0]?.tenant_id).toBe(TENANT_A);
    });

    test(`${table}: querying without a tenant GUC set returns no rows (fail-closed)`, async () => {
      const admin = getAdminSql();

      if (table === "awcms_mini_visitor_daily_rollups") {
        await admin`
          INSERT INTO awcms_mini_visitor_daily_rollups (tenant_id, date, area)
          VALUES (${TENANT_A}, '2026-07-10', 'public')
        `;
      } else if (table === "awcms_mini_visitor_sessions") {
        await admin`
          INSERT INTO awcms_mini_visitor_sessions (tenant_id, visitor_key_hash, area)
          VALUES (${TENANT_A}, 'hash-a', 'public')
        `;
      } else {
        await admin`
          INSERT INTO awcms_mini_visit_events
            (tenant_id, method, area, path_sanitized, human_status)
          VALUES (${TENANT_A}, 'GET', 'public', '/news', 'human')
        `;
      }

      const sql = getDatabaseClient();
      const rows = await sql.unsafe(`SELECT tenant_id FROM "${table}"`);

      expect(rows).toHaveLength(0);
    });
  }

  test("no raw secret-shaped column exists on any of the three tables", async () => {
    const admin = getAdminSql();
    const columns = (await admin`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'awcms_mini_visitor_sessions',
          'awcms_mini_visit_events',
          'awcms_mini_visitor_daily_rollups'
        )
    `) as { table_name: string; column_name: string }[];

    const columnNames = columns.map((row) => row.column_name.toLowerCase());

    for (const forbidden of [
      "password",
      "token",
      "secret",
      "authorization",
      "cookie",
      "request_body"
    ]) {
      expect(columnNames.some((name) => name.includes(forbidden))).toBe(false);
    }
  });
});
