/**
 * Step-up RUNTIME enforcement at the authorization chokepoint (Issue #879,
 * ADR-0022 §5/§8, FIX MEDIUM-3). Proves the AC "high-risk actions require current
 * assurance/step-up according to registry policy" is ENFORCED at
 * `authorizeInTransaction`, not merely declared in the registry: a step-up-
 * required control-plane permission is DENIED (STEP_UP_REQUIRED) when the session
 * assurance is stale, and ALLOWED when it is fresh.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  invoke,
  provisionAppRole
} from "./harness";
import { resetDatabase } from "./harness";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { withTenant } from "../../src/lib/database/tenant-context";
import { hashSessionToken } from "../../src/lib/auth/session-token";
import { authorizeInTransaction } from "../../src/modules/identity-access/application/access-guard";
import { syncModuleDescriptors } from "../../src/modules/module-management/application/descriptor-sync";

const suite = integrationEnabled ? describe : describe.skip;

const OWNER_PASSWORD = "correct horse battery staple";

async function bootstrap(): Promise<{ tenantId: string; token: string }> {
  const loginIdentifier = "owner@example.com";
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme",
      tenantCode: "acme",
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

// `payment_gateway.refunds.create` is a step-up-required control-plane key
// (control-plane-step-up-registry.ts). `create` is not high-risk, so the SoD
// chokepoint does not interfere — this isolates the step-up decision.
const GUARD = {
  moduleKey: "payment_gateway",
  activityCode: "refunds",
  action: "create" as const
};

suite("step-up runtime enforcement at the chokepoint (Issue #879)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  test("a step-up-required control-plane action is DENIED on stale assurance and ALLOWED on fresh", async () => {
    const { tenantId, token } = await bootstrap();
    const tokenHash = hashSessionToken(token);
    const admin = getAdminSql();

    // Ensure the module registry is populated (FK target), then enable the
    // (default-disabled) control-plane module for this tenant so the
    // module-enabled gate passes and we actually reach the step-up check.
    await admin.begin((tx) => syncModuleDescriptors(tx as unknown as Bun.SQL));
    await admin`
      INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key, enabled)
      VALUES (${tenantId}, 'payment_gateway', true)
      ON CONFLICT (tenant_id, module_key) DO UPDATE SET enabled = true
    `;

    const sql = getTestSql();

    // FRESH assurance (the login just set assurance_at = now()) -> allowed.
    const fresh = await withTenant(sql, tenantId, (tx) =>
      authorizeInTransaction(tx, tenantId, tokenHash, new Date(), GUARD)
    );
    expect(fresh.allowed).toBe(true);

    // Make the assurance STALE (older than the 300s window).
    await admin`
      UPDATE awcms_mini_sessions
      SET assurance_at = now() - interval '10 minutes'
      WHERE token_hash = ${tokenHash}
    `;

    const stale = await withTenant(sql, tenantId, (tx) =>
      authorizeInTransaction(tx, tenantId, tokenHash, new Date(), GUARD)
    );
    expect(stale.allowed).toBe(false);
    if (!stale.allowed) {
      const body = (await stale.denied.json()) as {
        error?: { code?: string };
      };
      expect(body.error?.code).toBe("STEP_UP_REQUIRED");
    }
  });
});
