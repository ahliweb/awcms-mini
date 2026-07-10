/**
 * Integration tests for `applyNewsPortalFullOnlineR2Preset` (Issue #632,
 * epic `news_portal`) against a real PostgreSQL: proves the readiness gate
 * actually blocks activation (no module state change, rejection audited)
 * when full-online R2-only config is missing, and that a fully-configured
 * env lets the preset land through the existing, generic
 * `applyModulePreset` (module enable/disable + its own audit events,
 * covered already by `module-presets.integration.test.ts`) plus this
 * wrapper's own confirmation audit event.
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
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";
import { applyNewsPortalFullOnlineR2Preset } from "../../src/modules/news-portal/application/apply-news-portal-preset";
import { applyModulePreset } from "../../src/modules/module-management/application/module-presets";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

const FULLY_CONFIGURED_ENV = {
  NEWS_PORTAL_ENABLED: "true",
  NEWS_PORTAL_PROFILE: "full_online_r2",
  NEWS_MEDIA_R2_ENABLED: "true",
  NEWS_MEDIA_R2_ACCOUNT_ID: "acct",
  NEWS_MEDIA_R2_ACCESS_KEY_ID: "news-key",
  NEWS_MEDIA_R2_SECRET_ACCESS_KEY: "news-secret",
  NEWS_MEDIA_R2_BUCKET: "news-media-bucket",
  NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://media.example.test"
} as NodeJS.ProcessEnv;

type Bootstrap = { tenantId: string; token: string; tenantUserId: string };

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

  const admin = getAdminSql();
  const tenantUserRows = (await admin`
    SELECT tu.id FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${setup.body.data.tenantId} AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id
  };
}

async function fetchTenantModuleState(
  tenantId: string
): Promise<Map<string, boolean>> {
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT module_key, enabled FROM awcms_mini_tenant_modules
    WHERE tenant_id = ${tenantId}
  `) as { module_key: string; enabled: boolean }[];

  return new Map(rows.map((row) => [row.module_key, row.enabled]));
}

async function fetchNewsPortalAuditRows(
  tenantId: string
): Promise<{ action: string; severity: string; attributes: unknown }[]> {
  const admin = getAdminSql();
  return (await admin`
    SELECT action, severity, attributes
    FROM awcms_mini_audit_events
    WHERE tenant_id = ${tenantId}
      AND module_key = 'news_portal'
    ORDER BY created_at ASC
  `) as { action: string; severity: string; attributes: unknown }[];
}

const suite = integrationEnabled ? describe : describe.skip;

suite("applyNewsPortalFullOnlineR2Preset", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("readiness gate blocks activation on an empty env: no module state changes, one rejection audit event", async () => {
    const owner = await bootstrap();
    const sql = getDatabaseClient();

    const result = await withTenant(sql, owner.tenantId, (tx) =>
      applyNewsPortalFullOnlineR2Preset(
        tx,
        owner.tenantId,
        owner.tenantUserId,
        {} as NodeJS.ProcessEnv
      )
    );

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("NEWS_PORTAL_PRESET_NOT_READY");
    expect(result.reasons).toContain("news_portal_disabled");

    // news_portal itself was never enabled by this rejected attempt.
    const state = await fetchTenantModuleState(owner.tenantId);
    expect(state.get("news_portal")).toBeUndefined();

    const auditRows = await fetchNewsPortalAuditRows(owner.tenantId);
    expect(auditRows).toEqual([
      {
        action: "news_portal_preset_activation_rejected",
        severity: "warning",
        attributes: expect.objectContaining({
          reasons: expect.arrayContaining(["news_portal_disabled"])
        })
      }
    ]);
  });

  test("readiness gate blocks activation when NEWS_MEDIA_R2_BUCKET collides with sync-storage's R2_BUCKET", async () => {
    const owner = await bootstrap();
    const sql = getDatabaseClient();

    const result = await withTenant(sql, owner.tenantId, (tx) =>
      applyNewsPortalFullOnlineR2Preset(
        tx,
        owner.tenantId,
        owner.tenantUserId,
        {
          ...FULLY_CONFIGURED_ENV,
          R2_BUCKET: FULLY_CONFIGURED_ENV.NEWS_MEDIA_R2_BUCKET
        } as NodeJS.ProcessEnv
      )
    );

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.reasons).toContain(
      "news_media_r2_shares_sync_storage_bucket_or_credentials"
    );
  });

  test("fully-configured env lets the preset activate, enabling news_portal and writing a confirmation audit event", async () => {
    const owner = await bootstrap();
    const sql = getDatabaseClient();

    // Start from "minimal" so news_portal is genuinely disabled first —
    // proves this test observes a real state TRANSITION, not merely
    // "already enabled by every module's fresh-tenant default".
    await withTenant(sql, owner.tenantId, (tx) =>
      applyModulePreset(tx, owner.tenantId, owner.tenantUserId, "minimal")
    );
    const stateBefore = await fetchTenantModuleState(owner.tenantId);
    expect(stateBefore.get("news_portal")).toBe(false);

    const result = await withTenant(sql, owner.tenantId, (tx) =>
      applyNewsPortalFullOnlineR2Preset(
        tx,
        owner.tenantId,
        owner.tenantUserId,
        FULLY_CONFIGURED_ENV
      )
    );

    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") throw new Error("unreachable");
    expect(result.presetName).toBe("news_portal_full_online_r2");
    expect(result.changes.find((c) => c.moduleKey === "news_portal")).toEqual({
      moduleKey: "news_portal",
      action: "enabled",
      outcome: "applied"
    });

    const state = await fetchTenantModuleState(owner.tenantId);
    expect(state.get("news_portal")).toBe(true);

    const auditRows = await fetchNewsPortalAuditRows(owner.tenantId);
    expect(auditRows).toEqual([
      {
        action: "news_portal_preset_activated",
        severity: "info",
        attributes: expect.objectContaining({ changes: expect.any(Number) })
      }
    ]);
  });
});
