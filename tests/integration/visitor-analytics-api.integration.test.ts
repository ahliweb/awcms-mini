/**
 * Integration tests for the visitor analytics API (Issue #621, epic:
 * visitor analytics #617-#624) against a real PostgreSQL. Exercises the
 * real handlers — auth guard, ABAC allow/deny, raw-detail gating,
 * `range` validation, keyset pagination, settings secret-shaped-value
 * rejection, and retention-purge idempotency + audit.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { GET as getRealtime } from "../../src/pages/api/v1/analytics/realtime";
import { GET as getSummary } from "../../src/pages/api/v1/analytics/summary";
import { GET as getSessions } from "../../src/pages/api/v1/analytics/sessions";
import { GET as getEvents } from "../../src/pages/api/v1/analytics/events";
import {
  GET as getSettings,
  PATCH as patchSettings
} from "../../src/pages/api/v1/analytics/settings";
import { POST as postPurge } from "../../src/pages/api/v1/analytics/retention/purge";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string };

async function bootstrap(
  tenantCode = "acme",
  tenantName = "Acme"
): Promise<Bootstrap> {
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName,
      tenantCode,
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

  return { tenantId: setup.body.data.tenantId, token: login.body.data.token };
}

/** A second tenant_user in the SAME tenant, holding exactly `permissionKeys` (e.g. `["visitor_analytics.sessions.read"]`). Empty array = a real authenticated user with no analytics permission at all (ABAC-deny fixture). */
async function provisionScopedTenantUser(
  tenantId: string,
  loginIdentifier: string,
  permissionKeys: string[]
): Promise<{ token: string }> {
  const admin = getAdminSql();
  const password = "integration-test-scoped-user-password";
  const passwordHash = await Bun.password.hash(password);

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Scoped User') RETURNING id
    `) as { id: string }[];
    const identity = (await tx`
      INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, ${loginIdentifier}, ${passwordHash})
      RETURNING id
    `) as { id: string }[];
    const tenantUser = (await tx`
      INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
      VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
    `) as { id: string }[];

    if (permissionKeys.length > 0) {
      const role = (await tx`
        INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
        VALUES (${tenantId}, ${`scoped-${loginIdentifier}`}, 'Scoped Role')
        RETURNING id
      `) as { id: string }[];

      for (const key of permissionKeys) {
        const [moduleKey, activityCode, action] = key.split(".");
        const permission = (await tx`
          SELECT id FROM awcms_mini_permissions
          WHERE module_key = ${moduleKey} AND activity_code = ${activityCode} AND action = ${action}
        `) as { id: string }[];

        await tx`
          INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
          VALUES (${tenantId}, ${role[0]!.id}, ${permission[0]!.id})
        `;
      }

      await tx`
        INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
        VALUES (${tenantId}, ${tenantUser[0]!.id}, ${role[0]!.id})
      `;
    }
  });

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { token: login.body.data.token };
}

function authHeaders(tenantId: string, token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": tenantId,
    authorization: `Bearer ${token}`
  };
}

const HUMAN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function seedSession(
  tenantId: string,
  overrides: Partial<{
    visitorKeyHash: string;
    area: string;
    lastSeenAt: Date;
    isHuman: boolean;
    ipAddress: string | null;
    loginIdentifierSnapshot: string | null;
  }> = {}
): Promise<string> {
  const admin = getAdminSql();
  const rows = await admin`
    INSERT INTO awcms_mini_visitor_sessions
      (tenant_id, visitor_key_hash, area, last_seen_at, is_human, ip_address,
       ip_hash, user_agent_hash, login_identifier_snapshot, browser_name, device_type)
    VALUES (
      ${tenantId},
      ${overrides.visitorKeyHash ?? `sha256:${crypto.randomUUID()}`},
      ${overrides.area ?? "public"},
      ${overrides.lastSeenAt ?? new Date()},
      ${overrides.isHuman ?? true},
      ${overrides.ipAddress ?? null},
      'sha256:iphash',
      'sha256:uahash',
      ${overrides.loginIdentifierSnapshot ?? null},
      'Chrome',
      'desktop'
    )
    RETURNING id
  `;
  return (rows as { id: string }[])[0]!.id;
}

async function seedEvent(
  tenantId: string,
  sessionId: string,
  overrides: Partial<{
    occurredAt: Date;
    area: string;
    humanStatus: string;
    pathSanitized: string;
  }> = {}
): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_visit_events
      (tenant_id, visitor_session_id, method, area, path_sanitized,
       human_status, occurred_at, user_agent_parsed)
    VALUES (
      ${tenantId}, ${sessionId}, 'GET',
      ${overrides.area ?? "public"},
      ${overrides.pathSanitized ?? "/news/hello"},
      ${overrides.humanStatus ?? "human"},
      ${overrides.occurredAt ?? new Date()},
      ${JSON.stringify({ browserName: "Chrome", deviceType: "desktop" })}
    )
  `;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("visitor analytics API (Issue #621)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("requires a tenant header and a valid session (400/401)", async () => {
    const noTenant = await invoke(getRealtime, {
      path: "/api/v1/analytics/realtime"
    });
    expect(noTenant.status).toBe(400);

    const b = await bootstrap();
    const noAuth = await invoke(getRealtime, {
      path: "/api/v1/analytics/realtime",
      headers: { "x-awcms-mini-tenant-id": b.tenantId }
    });
    expect(noAuth.status).toBe(401);
  });

  test("ABAC default-deny: a user with no visitor_analytics permission gets 403 ACCESS_DENIED, never empty data", async () => {
    const b = await bootstrap();
    const scoped = await provisionScopedTenantUser(
      b.tenantId,
      "no-perms@example.com",
      []
    );
    const headers = authHeaders(b.tenantId, scoped.token);

    for (const invocation of [
      () =>
        invoke(getRealtime, { path: "/api/v1/analytics/realtime", headers }),
      () => invoke(getSummary, { path: "/api/v1/analytics/summary", headers }),
      () =>
        invoke(getSessions, { path: "/api/v1/analytics/sessions", headers }),
      () => invoke(getEvents, { path: "/api/v1/analytics/events", headers }),
      () => invoke(getSettings, { path: "/api/v1/analytics/settings", headers })
    ]) {
      const result = await invocation();
      expect(result.status).toBe(403);
      expect((result.body as { error: { code: string } }).error.code).toBe(
        "ACCESS_DENIED"
      );
    }
  });

  test("realtime: counts only sessions within the online window, by area/human", async () => {
    const b = await bootstrap();
    const now = new Date();
    const stale = new Date(now.getTime() - 10 * 60 * 1000);

    await seedSession(b.tenantId, {
      area: "admin",
      lastSeenAt: now,
      isHuman: true
    });
    await seedSession(b.tenantId, {
      area: "public",
      lastSeenAt: now,
      isHuman: true
    });
    await seedSession(b.tenantId, {
      area: "public",
      lastSeenAt: stale,
      isHuman: true
    });

    const result = await invoke<{
      data: {
        onlineAdminCount: number;
        onlinePublicCount: number;
        onlineHumanCount: number;
      };
    }>(getRealtime, {
      path: "/api/v1/analytics/realtime",
      headers: authHeaders(b.tenantId, b.token)
    });

    expect(result.status).toBe(200);
    expect(result.body.data.onlineAdminCount).toBe(1);
    expect(result.body.data.onlinePublicCount).toBe(1);
    expect(result.body.data.onlineHumanCount).toBe(2);
  });

  test("summary: rejects an invalid range with 400 VALIDATION_ERROR", async () => {
    const b = await bootstrap();
    const result = await invoke(getSummary, {
      path: "/api/v1/analytics/summary?range=1h",
      headers: authHeaders(b.tenantId, b.token)
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "VALIDATION_ERROR"
    );
  });

  test("summary: computes human/bot pageview and unique-visitor counts within range", async () => {
    const b = await bootstrap();
    const session1 = await seedSession(b.tenantId, { area: "public" });
    const session2 = await seedSession(b.tenantId, { area: "public" });

    await seedEvent(b.tenantId, session1, {
      humanStatus: "human",
      pathSanitized: "/news/a"
    });
    await seedEvent(b.tenantId, session2, {
      humanStatus: "human",
      pathSanitized: "/news/a"
    });
    await seedEvent(b.tenantId, session1, {
      humanStatus: "bot",
      pathSanitized: "/news/b"
    });

    const result = await invoke<{
      data: {
        humanPageviews: number;
        botPageviews: number;
        humanUniqueVisitors: number;
        topPaths: { name: string; count: number }[];
      };
    }>(getSummary, {
      path: "/api/v1/analytics/summary?range=7d",
      headers: authHeaders(b.tenantId, b.token)
    });

    expect(result.status).toBe(200);
    expect(result.body.data.humanPageviews).toBe(2);
    expect(result.body.data.botPageviews).toBe(1);
    expect(result.body.data.humanUniqueVisitors).toBe(2);
    expect(result.body.data.topPaths[0]?.name).toBe("/news/a");
    expect(result.body.data.topPaths[0]?.count).toBe(2);
  });

  test("sessions: raw detail fields are nulled without raw_detail.read, populated with it", async () => {
    const b = await bootstrap();
    await seedSession(b.tenantId, {
      ipAddress: "203.0.113.10",
      loginIdentifierSnapshot: "owner@example.com"
    });

    const withoutRawDetail = await provisionScopedTenantUser(
      b.tenantId,
      "sessions-only@example.com",
      ["visitor_analytics.sessions.read"]
    );
    const withRawDetail = await provisionScopedTenantUser(
      b.tenantId,
      "sessions-plus-raw@example.com",
      ["visitor_analytics.sessions.read", "visitor_analytics.raw_detail.read"]
    );

    const gated = await invoke<{
      data: {
        sessions: {
          ipAddress: string | null;
          loginIdentifierSnapshot: string | null;
        }[];
      };
    }>(getSessions, {
      path: "/api/v1/analytics/sessions",
      headers: authHeaders(b.tenantId, withoutRawDetail.token)
    });
    expect(gated.status).toBe(200);
    expect(gated.body.data.sessions[0]?.ipAddress).toBeNull();
    expect(gated.body.data.sessions[0]?.loginIdentifierSnapshot).toBeNull();

    const revealed = await invoke<{
      data: {
        sessions: {
          ipAddress: string | null;
          loginIdentifierSnapshot: string | null;
        }[];
      };
    }>(getSessions, {
      path: "/api/v1/analytics/sessions",
      headers: authHeaders(b.tenantId, withRawDetail.token)
    });
    expect(revealed.status).toBe(200);
    expect(revealed.body.data.sessions[0]?.ipAddress).toBe("203.0.113.10");
    expect(revealed.body.data.sessions[0]?.loginIdentifierSnapshot).toBe(
      "owner@example.com"
    );
  });

  test("events: keyset pagination returns nextCursor and pages through all rows exactly once", async () => {
    const b = await bootstrap();
    const session = await seedSession(b.tenantId);

    for (let i = 0; i < 55; i += 1) {
      await seedEvent(b.tenantId, session, {
        occurredAt: new Date(Date.now() - i * 1000),
        pathSanitized: `/news/${i}`
      });
    }

    const headers = authHeaders(b.tenantId, b.token);
    const firstPage = await invoke<{
      data: { events: { id: string }[]; nextCursor: string | null };
    }>(getEvents, { path: "/api/v1/analytics/events", headers });

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.events).toHaveLength(50);
    expect(firstPage.body.data.nextCursor).not.toBeNull();

    const secondPage = await invoke<{
      data: { events: { id: string }[]; nextCursor: string | null };
    }>(getEvents, {
      path: `/api/v1/analytics/events?cursor=${encodeURIComponent(firstPage.body.data.nextCursor!)}`,
      headers
    });

    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data.events).toHaveLength(5);
    expect(secondPage.body.data.nextCursor).toBeNull();

    const firstIds = new Set(firstPage.body.data.events.map((e) => e.id));
    const secondIds = new Set(secondPage.body.data.events.map((e) => e.id));
    expect([...firstIds].some((id) => secondIds.has(id))).toBe(false);
  });

  test("events: rejects a malformed cursor with 400 VALIDATION_ERROR", async () => {
    const b = await bootstrap();
    const result = await invoke(getEvents, {
      path: "/api/v1/analytics/events?cursor=not-a-real-cursor",
      headers: authHeaders(b.tenantId, b.token)
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "VALIDATION_ERROR"
    );
  });

  test("settings: GET returns a view even with no override yet, PATCH stores non-secret keys", async () => {
    const b = await bootstrap();
    const headers = authHeaders(b.tenantId, b.token);

    const before = await invoke<{
      data: { effective: Record<string, unknown> };
    }>(getSettings, { path: "/api/v1/analytics/settings", headers });
    expect(before.status).toBe(200);

    const patched = await invoke<{
      data: { effective: Record<string, unknown> };
    }>(patchSettings, {
      method: "PATCH",
      path: "/api/v1/analytics/settings",
      headers,
      body: { dashboardLabel: "Visitor Insights" }
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.effective.dashboardLabel).toBe("Visitor Insights");
  });

  test("settings: PATCH rejects a secret-shaped key", async () => {
    const b = await bootstrap();
    const result = await invoke(patchSettings, {
      method: "PATCH",
      path: "/api/v1/analytics/settings",
      headers: authHeaders(b.tenantId, b.token),
      body: { apiToken: "some-value" }
    });
    expect(result.status).toBe(400);
  });

  test("retention purge: requires Idempotency-Key, deletes old data, is idempotent, and is audited", async () => {
    const b = await bootstrap();
    const oldSession = await seedSession(b.tenantId, {
      lastSeenAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    });
    await seedEvent(b.tenantId, oldSession, {
      occurredAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    });

    const headers = authHeaders(b.tenantId, b.token);

    const missingKey = await invoke(postPurge, {
      method: "POST",
      path: "/api/v1/analytics/retention/purge",
      headers
    });
    expect(missingKey.status).toBe(400);
    expect((missingKey.body as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_REQUIRED"
    );

    const idempotencyKey = crypto.randomUUID();
    const first = await invoke<{ data: { eventsDeleted: number } }>(postPurge, {
      method: "POST",
      path: "/api/v1/analytics/retention/purge",
      headers: { ...headers, "idempotency-key": idempotencyKey }
    });
    expect(first.status).toBe(200);
    expect(first.body.data.eventsDeleted).toBeGreaterThan(0);

    const admin = getAdminSql();
    const remainingEvents = await admin`
      SELECT count(*)::int AS count FROM awcms_mini_visit_events WHERE tenant_id = ${b.tenantId}
    `;
    expect((remainingEvents as { count: number }[])[0]!.count).toBe(0);

    const auditRows = await admin`
      SELECT action, severity FROM awcms_mini_audit_events
      WHERE tenant_id = ${b.tenantId} AND action = 'retention_purged'
    `;
    expect(auditRows).toHaveLength(1);
    expect((auditRows as { severity: string }[])[0]!.severity).toBe("critical");

    const replay = await invoke<{ data: { eventsDeleted: number } }>(
      postPurge,
      {
        method: "POST",
        path: "/api/v1/analytics/retention/purge",
        headers: { ...headers, "idempotency-key": idempotencyKey }
      }
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data.eventsDeleted).toBe(first.body.data.eventsDeleted);

    const auditRowsAfterReplay = await admin`
      SELECT id FROM awcms_mini_audit_events
      WHERE tenant_id = ${b.tenantId} AND action = 'retention_purged'
    `;
    expect(auditRowsAfterReplay).toHaveLength(1);
  });
});
