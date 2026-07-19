/**
 * Integration tests for the SSR admin session resolver
 * (`src/lib/auth/ssr-session.ts` `loadSsrSessionData`) against real
 * PostgreSQL. Two properties, both regression-critical:
 *
 * 1. Issue #841 — the SSR permission set gates disabled modules at parity
 *    with the route path. The 54 admin pages gate purely on
 *    `context.permissions.has(...)`; the route path refuses
 *    `403 MODULE_DISABLED` (`resolveModuleEnabled` in `authorizeInTransaction`)
 *    BEFORE RBAC. This test pins the MECHANISM, not just an outcome (the
 *    lesson from the first SSR-vs-route parity test, which compared the wrong
 *    axis and stayed green while the gates disagreed): after a module is
 *    disabled, `fetchGrantedPermissionKeys` (the route's own source) STILL
 *    returns that module's keys, `resolveModuleEnabled` reads `false`, and the
 *    SSR permission set must therefore drop exactly that module's keys while
 *    keeping every other (still-enabled) module's keys.
 *
 * 2. Issue #835 §7 — `loadSsrSessionData` resolves the whole SSR context in
 *    exactly two DB round-trips (session lookup + one combined query), down
 *    from the previous five serial queries.
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
import { hashSessionToken } from "../../src/lib/auth/session-token";
import { loadSsrSessionData } from "../../src/lib/auth/ssr-session";
import { listModules } from "../../src/modules";
import {
  fetchGrantedPermissionKeys,
  resolveModuleEnabled,
  resolveTenantContext
} from "../../src/modules/identity-access/application/auth-context";
import { syncModuleDescriptors } from "../../src/modules/module-management/application/descriptor-sync";

const OWNER_PASSWORD = "integration-test-ssr-session-owner-password";

type Bootstrap = {
  tenantId: string;
  token: string;
  tenantUserId: string;
};

async function bootstrap(): Promise<Bootstrap> {
  const loginIdentifier = "ssr-owner@example.com";
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

  const admin = getAdminSql();
  const tenantUserRows = (await admin`
    SELECT tu.id FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${setup.body.data.tenantId}
      AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id
  };
}

function distinctModuleKeys(permissionKeys: Iterable<string>): string[] {
  const modules = new Set<string>();
  for (const key of permissionKeys) {
    modules.add(key.split(".")[0]!);
  }
  return [...modules];
}

const suite = integrationEnabled ? describe : describe.skip;

suite("ssr session module gate", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("baseline: SSR permission set equals the route's granted set, roles match, in 2 queries", async () => {
    const owner = await bootstrap();
    const appSql = getDatabaseClient();
    const tokenHash = hashSessionToken(owner.token);
    const now = new Date();

    await withTenant(appSql, owner.tenantId, async (tx) => {
      const context = await loadSsrSessionData(
        tx,
        owner.tenantId,
        tokenHash,
        now
      );
      expect(context).not.toBeNull();

      const granted = await fetchGrantedPermissionKeys(
        tx,
        owner.tenantId,
        owner.tenantUserId
      );
      const routeContext = await resolveTenantContext(
        tx,
        owner.tenantId,
        tokenHash,
        now
      );

      // Issue #870 (ADR-0022 §7): a `defaultTenantState: "disabled"` control-
      // plane module (`service_catalog`) has its permission keys STRIPPED from
      // the SSR set even with no explicit tenant_modules row, while the route's
      // `fetchGrantedPermissionKeys` does NOT strip them. So the SSR set is the
      // route's granted set MINUS those default-disabled module keys.
      const defaultDisabledModuleKeys = new Set(
        listModules()
          .filter((module) => module.defaultTenantState === "disabled")
          .map((module) => module.key)
      );
      const grantedAfterDefaultGate = [...granted].filter(
        (key) => !defaultDisabledModuleKeys.has(key.split(".")[0]!)
      );

      expect(context!.permissions.size).toBe(grantedAfterDefaultGate.length);
      for (const key of grantedAfterDefaultGate) {
        expect(context!.permissions.has(key)).toBe(true);
      }
      // The default-disabled module's granted keys are ABSENT from the SSR set.
      for (const key of granted) {
        if (defaultDisabledModuleKeys.has(key.split(".")[0]!)) {
          expect(context!.permissions.has(key)).toBe(false);
        }
      }

      // Roles match the route resolver's roles (compared as sets).
      expect([...context!.roles].sort()).toEqual(
        [...new Set(routeContext!.roles)].sort()
      );

      expect(context!.tenantUserId).toBe(owner.tenantUserId);
      expect(context!.identityId).toBe(routeContext!.identityId);
      return null;
    });

    // Issue #835 §7: exactly two DB round-trips (session + combined query).
    await withTenant(appSql, owner.tenantId, async (tx) => {
      let queryCount = 0;
      const countingTx = new Proxy(tx, {
        apply(target, thisArg, args) {
          queryCount += 1;
          return Reflect.apply(
            target as unknown as (...a: unknown[]) => unknown,
            thisArg,
            args
          );
        }
      }) as unknown as typeof tx;

      const context = await loadSsrSessionData(
        countingTx,
        owner.tenantId,
        tokenHash,
        now
      );
      expect(context).not.toBeNull();
      expect(queryCount).toBe(2);
      return null;
    });
  });

  test("disabling a module drops exactly that module's keys from the SSR set, keeps others, while the route source still grants them", async () => {
    const owner = await bootstrap();
    const appSql = getDatabaseClient();
    const admin = getAdminSql();
    const tokenHash = hashSessionToken(owner.token);
    const now = new Date();

    // Pick a module the owner really holds keys for, and a DIFFERENT one to
    // prove the gate is surgical (only the disabled module disappears).
    const grantedBefore = await withTenant(appSql, owner.tenantId, (tx) =>
      fetchGrantedPermissionKeys(tx, owner.tenantId, owner.tenantUserId)
    );
    const modules = distinctModuleKeys(grantedBefore);
    expect(modules.length).toBeGreaterThanOrEqual(2);
    const disabledModule = modules.includes("blog_content")
      ? "blog_content"
      : modules[0]!;
    const otherModule = modules.find((m) => m !== disabledModule)!;

    const disabledPrefix = `${disabledModule}.`;
    const otherPrefix = `${otherModule}.`;
    expect([...grantedBefore].some((k) => k.startsWith(disabledPrefix))).toBe(
      true
    );
    expect([...grantedBefore].some((k) => k.startsWith(otherPrefix))).toBe(
      true
    );

    // The tenant_modules FK requires awcms_mini_modules to be populated.
    await syncModuleDescriptors(admin);
    await admin`
      INSERT INTO awcms_mini_tenant_modules (tenant_id, module_key, enabled, disabled_at)
      VALUES (${owner.tenantId}, ${disabledModule}, false, now())
      ON CONFLICT (tenant_id, module_key)
        DO UPDATE SET enabled = false, disabled_at = now()
    `;

    await withTenant(appSql, owner.tenantId, async (tx) => {
      // Mechanism: the route's own permission source STILL grants the keys —
      // nothing revoked them; the module was merely disabled.
      const grantedAfter = await fetchGrantedPermissionKeys(
        tx,
        owner.tenantId,
        owner.tenantUserId
      );
      expect([...grantedAfter].some((k) => k.startsWith(disabledPrefix))).toBe(
        true
      );

      // Route gate reads the module as disabled...
      expect(
        await resolveModuleEnabled(tx, owner.tenantId, disabledModule)
      ).toBe(false);
      expect(await resolveModuleEnabled(tx, owner.tenantId, otherModule)).toBe(
        true
      );

      // ...so the SSR set must drop EVERY disabled-module key (gate)...
      const context = await loadSsrSessionData(
        tx,
        owner.tenantId,
        tokenHash,
        now
      );
      expect(context).not.toBeNull();
      expect(
        [...context!.permissions].some((k) => k.startsWith(disabledPrefix))
      ).toBe(false);

      // ...and keep every still-enabled module's keys (the other side).
      expect(
        [...context!.permissions].some((k) => k.startsWith(otherPrefix))
      ).toBe(true);

      // Roles are identity, not capability: the subject keeps its role even
      // for the disabled module.
      expect(context!.roles.length).toBeGreaterThan(0);
      return null;
    });
  });
});
