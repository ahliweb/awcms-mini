/**
 * Integration tests for the visitor telemetry collector (Issue #620,
 * epic: visitor analytics #617-#624) against a real PostgreSQL — exercises
 * `collectVisitorTelemetry` exactly as `src/middleware.ts` calls it,
 * through the same least-privilege app-role client route handlers use
 * (`getTestSql()`).
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

import { collectVisitorTelemetry } from "../../src/modules/visitor-analytics/application/collector";
import { VISITOR_ANALYTICS_DEFAULTS } from "../../src/modules/visitor-analytics/domain/visitor-analytics-config";
import { generateVisitorKey } from "../../src/modules/visitor-analytics/domain/visitor-key";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const HUMAN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BOT_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

async function seedTenant(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${TENANT_A}, 'tenant-a', 'Tenant A', 'Tenant A Legal', 'active', 'en', 'light')
  `;
}

async function fetchSessions(): Promise<Record<string, unknown>[]> {
  const admin = getAdminSql();
  return (await admin`
    SELECT * FROM awcms_mini_visitor_sessions WHERE tenant_id = ${TENANT_A}
  `) as Record<string, unknown>[];
}

async function fetchEvents(): Promise<Record<string, unknown>[]> {
  const admin = getAdminSql();
  return (await admin`
    SELECT * FROM awcms_mini_visit_events WHERE tenant_id = ${TENANT_A}
  `) as Record<string, unknown>[];
}

const suite = integrationEnabled ? describe : describe.skip;

suite("collectVisitorTelemetry", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
  });

  test("creates a session and an event on the first request", async () => {
    const sql = getTestSql();
    const visitorKey = generateVisitorKey();

    await collectVisitorTelemetry({
      sql,
      tenantId: TENANT_A,
      correlationId: "corr-1",
      config: VISITOR_ANALYTICS_DEFAULTS,
      method: "GET",
      rawPath: "/news/hello-world?utm_source=test",
      statusCode: 200,
      visitorKey,
      ipAddress: "203.0.113.10",
      userAgent: HUMAN_UA,
      referrerHeader: "https://www.google.com/search?q=x",
      isAuthenticated: false,
      identityId: null
    });

    const sessions = await fetchSessions();
    const events = await fetchEvents();

    expect(sessions).toHaveLength(1);
    expect(events).toHaveLength(1);

    const session = sessions[0]!;
    expect(session.area).toBe("public");
    expect(session.is_human).toBe(true);
    expect(session.is_authenticated).toBe(false);
    expect(session.login_identifier_snapshot).toBeNull();
    // Privacy-first default: raw IP not stored, hashed form is.
    expect(session.ip_address).toBeNull();
    expect(session.ip_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(session.browser_name).toBe("Chrome");
    expect(session.device_type).toBe("desktop");

    const event = events[0]!;
    expect(event.method).toBe("GET");
    expect(event.status_code).toBe(200);
    expect(event.area).toBe("public");
    // Sensitive-looking param stripped even though utm_source itself isn't sensitive.
    expect(event.path_sanitized).toBe("/news/hello-world?utm_source=test");
    expect(event.referrer_domain).toBe("www.google.com");
    expect(event.human_status).toBe("human");
    expect(event.correlation_id).toBe("corr-1");
    expect(event.visitor_session_id).toBe(session.id);
  });

  test("strips sensitive query params before path_sanitized is ever written", async () => {
    const sql = getTestSql();

    await collectVisitorTelemetry({
      sql,
      tenantId: TENANT_A,
      correlationId: "corr-2",
      config: VISITOR_ANALYTICS_DEFAULTS,
      method: "GET",
      rawPath: "/auth/reset?reset_token=super-secret-value",
      statusCode: 200,
      visitorKey: generateVisitorKey(),
      ipAddress: null,
      userAgent: HUMAN_UA,
      referrerHeader: null,
      isAuthenticated: false,
      identityId: null
    });

    const events = await fetchEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.path_sanitized).not.toContain("super-secret-value");
  });

  test("classifies a bot user-agent as bot on both session and event", async () => {
    const sql = getTestSql();

    await collectVisitorTelemetry({
      sql,
      tenantId: TENANT_A,
      correlationId: "corr-3",
      config: VISITOR_ANALYTICS_DEFAULTS,
      method: "GET",
      rawPath: "/news",
      statusCode: 200,
      visitorKey: generateVisitorKey(),
      ipAddress: "203.0.113.20",
      userAgent: BOT_UA,
      referrerHeader: null,
      isAuthenticated: false,
      identityId: null
    });

    const sessions = await fetchSessions();
    const events = await fetchEvents();

    expect(sessions[0]!.is_human).toBe(false);
    expect(sessions[0]!.bot_reason).toBe("Googlebot");
    expect(events[0]!.human_status).toBe("bot");
  });

  test("stores raw IP only when VISITOR_ANALYTICS_RAW_IP_ENABLED is on", async () => {
    const sql = getTestSql();

    await collectVisitorTelemetry({
      sql,
      tenantId: TENANT_A,
      correlationId: "corr-4",
      config: { ...VISITOR_ANALYTICS_DEFAULTS, rawIpEnabled: true },
      method: "GET",
      rawPath: "/news",
      statusCode: 200,
      visitorKey: generateVisitorKey(),
      ipAddress: "203.0.113.30",
      userAgent: HUMAN_UA,
      referrerHeader: null,
      isAuthenticated: false,
      identityId: null
    });

    const sessions = await fetchSessions();
    expect(sessions[0]!.ip_address).toBe("203.0.113.30");
  });

  test("reuses the same session row (throttled) within the online window, but always inserts a new event", async () => {
    const sql = getTestSql();
    const visitorKey = generateVisitorKey();

    await collectVisitorTelemetry({
      sql,
      tenantId: TENANT_A,
      correlationId: "corr-5a",
      config: VISITOR_ANALYTICS_DEFAULTS,
      method: "GET",
      rawPath: "/news",
      statusCode: 200,
      visitorKey,
      ipAddress: "203.0.113.40",
      userAgent: HUMAN_UA,
      referrerHeader: null,
      isAuthenticated: false,
      identityId: null
    });

    await collectVisitorTelemetry({
      sql,
      tenantId: TENANT_A,
      correlationId: "corr-5b",
      config: VISITOR_ANALYTICS_DEFAULTS,
      method: "GET",
      rawPath: "/news/second-page",
      statusCode: 200,
      visitorKey,
      ipAddress: "203.0.113.40",
      userAgent: HUMAN_UA,
      referrerHeader: null,
      isAuthenticated: false,
      identityId: null
    });

    const sessions = await fetchSessions();
    const events = await fetchEvents();

    expect(sessions).toHaveLength(1);
    expect(events).toHaveLength(2);
  });

  test("starts a new session once the previous one falls outside the online window", async () => {
    const sql = getTestSql();
    const visitorKey = generateVisitorKey();

    await collectVisitorTelemetry({
      sql,
      tenantId: TENANT_A,
      correlationId: "corr-6a",
      config: { ...VISITOR_ANALYTICS_DEFAULTS, onlineWindowSeconds: 300 },
      method: "GET",
      rawPath: "/news",
      statusCode: 200,
      visitorKey,
      ipAddress: "203.0.113.50",
      userAgent: HUMAN_UA,
      referrerHeader: null,
      isAuthenticated: false,
      identityId: null
    });

    // Simulate the session going stale beyond the online window (real
    // clock manipulation isn't available here — backdating last_seen_at
    // via the admin client is the standard way this repo tests
    // time-window behavior, e.g. rate-limit/session-expiry tests).
    const admin = getAdminSql();
    await admin`
      UPDATE awcms_mini_visitor_sessions
      SET last_seen_at = now() - interval '10 minutes'
      WHERE tenant_id = ${TENANT_A}
    `;

    await collectVisitorTelemetry({
      sql,
      tenantId: TENANT_A,
      correlationId: "corr-6b",
      config: { ...VISITOR_ANALYTICS_DEFAULTS, onlineWindowSeconds: 300 },
      method: "GET",
      rawPath: "/news/second-visit",
      statusCode: 200,
      visitorKey,
      ipAddress: "203.0.113.50",
      userAgent: HUMAN_UA,
      referrerHeader: null,
      isAuthenticated: false,
      identityId: null
    });

    const sessions = await fetchSessions();
    const events = await fetchEvents();

    expect(sessions).toHaveLength(2);
    expect(events).toHaveLength(2);
  });

  test("does not throw and writes nothing for a static/non-trackable path", async () => {
    const sql = getTestSql();

    await expect(
      collectVisitorTelemetry({
        sql,
        tenantId: TENANT_A,
        correlationId: "corr-7",
        config: VISITOR_ANALYTICS_DEFAULTS,
        method: "GET",
        rawPath: "/_astro/client.abc123.js",
        statusCode: 200,
        visitorKey: generateVisitorKey(),
        ipAddress: "203.0.113.60",
        userAgent: HUMAN_UA,
        referrerHeader: null,
        isAuthenticated: false,
        identityId: null
      })
    ).resolves.toBeUndefined();

    expect(await fetchSessions()).toHaveLength(0);
    expect(await fetchEvents()).toHaveLength(0);
  });

  test("fail-open: an invalid tenantId never throws, and writes nothing", async () => {
    const sql = getTestSql();

    await expect(
      collectVisitorTelemetry({
        sql,
        tenantId: "not-a-valid-uuid",
        correlationId: "corr-8",
        config: VISITOR_ANALYTICS_DEFAULTS,
        method: "GET",
        rawPath: "/news",
        statusCode: 200,
        visitorKey: generateVisitorKey(),
        ipAddress: "203.0.113.70",
        userAgent: HUMAN_UA,
        referrerHeader: null,
        isAuthenticated: false,
        identityId: null
      })
    ).resolves.toBeUndefined();

    expect(await fetchSessions()).toHaveLength(0);
  });

  test("an authenticated admin session records identityId and area=admin", async () => {
    const sql = getTestSql();

    // A real identity row so the FK is satisfiable — mirrors the binding
    // rule from the Issue #618 security-audit follow-up: identityId here
    // is always server-derived (never client-supplied) in the real
    // middleware caller, and this test seeds a real row for the same
    // reason a forged/foreign id must never reach this function.
    const admin = getAdminSql();
    const profileRows = await admin`
      INSERT INTO awcms_mini_profiles (tenant_id, display_name, profile_type)
      VALUES (${TENANT_A}, 'Owner', 'person')
      RETURNING id
    `;
    const profileId = (profileRows as { id: string }[])[0]!.id;
    const identityRows = await admin`
      INSERT INTO awcms_mini_identities
        (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${TENANT_A}, ${profileId}, 'owner@example.com', 'x')
      RETURNING id
    `;
    const identityId = (identityRows as { id: string }[])[0]!.id;

    await collectVisitorTelemetry({
      sql,
      tenantId: TENANT_A,
      correlationId: "corr-9",
      config: VISITOR_ANALYTICS_DEFAULTS,
      method: "GET",
      rawPath: "/admin/dashboard",
      statusCode: 200,
      visitorKey: generateVisitorKey(),
      ipAddress: "203.0.113.80",
      userAgent: HUMAN_UA,
      referrerHeader: null,
      isAuthenticated: true,
      identityId
    });

    const sessions = await fetchSessions();
    const events = await fetchEvents();

    expect(sessions[0]!.area).toBe("admin");
    expect(sessions[0]!.identity_id).toBe(identityId);
    expect(sessions[0]!.is_authenticated).toBe(true);
    expect(events[0]!.identity_id).toBe(identityId);
    expect(events[0]!.area).toBe("admin");
  });
});
