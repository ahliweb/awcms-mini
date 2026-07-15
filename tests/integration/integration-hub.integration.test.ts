/**
 * Integration tests for Issue #754 (epic `platform-evolution` #738 Wave
 * 3): signed inbound webhooks, replay protection enforced by a REAL
 * database uniqueness constraint (not only the in-process check),
 * outbound event subscriptions, the least-privilege `awcms_mini_worker`
 * role, and cross-tenant RLS isolation.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 *
 * NOTE: never use `.rejects.toThrow()`/`.rejects.toBeInstanceOf()` against
 * a real Bun.SQL/postgres promise in this repo — it spins the process at
 * 100% CPU forever (confirmed project pitfall). Every rejection below is
 * asserted via manual try/catch instead.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getWorkerTestSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { withTenant } from "../../src/lib/database/tenant-context";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";

import { POST as inboundReceive } from "../../src/pages/api/v1/integration-hub/inbound/[endpointToken]";
import {
  GET as listEndpoints,
  POST as createEndpointRoute
} from "../../src/pages/api/v1/integration-hub/endpoints/index";
import { POST as rotateSecretRoute } from "../../src/pages/api/v1/integration-hub/endpoints/[id]/rotate-secret";
import {
  GET as listSubscriptions,
  POST as createSubscriptionRoute
} from "../../src/pages/api/v1/integration-hub/subscriptions/index";
import { GET as listOutboundDeliveriesRoute } from "../../src/pages/api/v1/integration-hub/deliveries/outbound/index";

import { fixtureSignatureTestHelpers } from "../../src/modules/integration-hub/domain/fixture-signature-schemes";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import { dispatchOutboundQueue } from "../../src/modules/integration-hub/application/outbound-dispatch";

const OWNER_LOGIN = "owner@example.com";
const WEBHOOK_SECRET_ENV_VAR = "INTEGRATION_HUB_TEST_WEBHOOK_SECRET";

type Bootstrap = {
  tenantId: string;
  tenantCode: string;
  token: string;
  tenantUserId: string;
};

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
      ownerPassword: "integration-test-owner-password",
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
    body: { loginIdentifier, password: "integration-test-owner-password" },
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
    tenantCode,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id
  };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

/**
 * A second, fully-independent tenant that DOES have full `integration_hub`
 * access (own role/permissions) — for RLS-invisibility tests where a bare
 * ABAC-deny (403) would be a false positive. Same pattern
 * `domain-event-runtime.integration.test.ts`'s own
 * `seedSecondTenantWithDomainEventRuntimeAccess` establishes.
 */
async function seedSecondTenantWithIntegrationHubAccess(
  tenantCode: string
): Promise<Bootstrap> {
  const tenantId = crypto.randomUUID();
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const password = "integration-test-tenant-b-password";
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${tenantId}, ${tenantCode}, ${tenantCode}, ${tenantCode}, 'active', 'en', 'light')
  `;

  const passwordHash = await Bun.password.hash(password);
  let tenantUserId = "";

  await admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);

    const profile = (await tx`
      INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', 'Tenant B User') RETURNING id
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
    const role = (await tx`
      INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, 'full_access', 'Full Access') RETURNING id
    `) as { id: string }[];
    const permissions = (await tx`
      SELECT id FROM awcms_mini_permissions WHERE module_key = 'integration_hub'
    `) as { id: string }[];

    for (const permission of permissions) {
      await tx`
        INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
        VALUES (${tenantId}, ${role[0]!.id}, ${permission.id})
      `;
    }

    await tx`
      INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id)
      VALUES (${tenantId}, ${tenantUser[0]!.id}, ${role[0]!.id})
    `;

    tenantUserId = tenantUser[0]!.id;
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

  return { tenantId, tenantCode, token: login.body.data.token, tenantUserId };
}

type CreatedEndpoint = {
  id: string;
  endpointToken: string;
  secret: string;
};

async function createFixtureEndpoint(
  owner: Bootstrap,
  secret: string,
  adapterKey = "fixture_hmac_sha256"
): Promise<CreatedEndpoint> {
  process.env[WEBHOOK_SECRET_ENV_VAR] = secret;

  const result = await invoke<{
    data: { endpoint: { id: string; endpointToken: string } };
  }>(createEndpointRoute, {
    method: "POST",
    path: "/api/v1/integration-hub/endpoints",
    headers: { ...authHeaders(owner), "idempotency-key": crypto.randomUUID() },
    body: {
      adapterKey,
      displayName: "Test webhook endpoint",
      secretReference: `env:${WEBHOOK_SECRET_ENV_VAR}`
    }
  });

  expect(result.status).toBe(200);

  return {
    id: result.body.data.endpoint.id,
    endpointToken: result.body.data.endpoint.endpointToken,
    secret
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("integration_hub (Issue #754)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  // `beforeEach` (not `afterEach`) — matches the established convention
  // (`domain-event-runtime.integration.test.ts`, `db-role-separation.
  // integration.test.ts`) so the FIRST test in this file is never
  // dependent on whichever OTHER file `bun test` happened to run right
  // before this one having cleaned up after itself (every integration
  // test file shares one Postgres instance in the same process — an
  // `afterEach`-only reset leaves the very first test in a file exposed
  // to cross-file ordering, in particular the `awcms_mini_setup_state`
  // singleton `/setup/initialize` guards).
  beforeEach(async () => {
    await resetDatabase();
    delete process.env[WEBHOOK_SECRET_ENV_VAR];
    delete process.env.INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS;
  });

  describe("signed inbound webhook — signature verification + real DB replay protection", () => {
    test("valid signature is accepted and normalizes to a domain event", async () => {
      const owner = await bootstrap();
      await provisionAppRole();

      const secret = "webhook-secret-value";
      const endpoint = await createFixtureEndpoint(owner, secret);

      const payload = { hello: "world" };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = fixtureSignatureTestHelpers.signHmacSha256(
        secret,
        timestamp,
        rawBody
      );

      const result = await invoke<{
        data: { status: string; deliveryId: string };
      }>(inboundReceive, {
        method: "POST",
        path: `/api/v1/integration-hub/inbound/${endpoint.endpointToken}`,
        headers: {
          "content-type": "application/json",
          "x-integration-signature": signature,
          "x-integration-timestamp": timestamp,
          "x-integration-delivery-id": "delivery-1"
        },
        body: payload,
        params: { endpointToken: endpoint.endpointToken }
      });

      expect(result.status).toBe(200);
      expect(result.body.data.status).toBe("accepted");

      const admin = getAdminSql();
      const deliveryRows = await withTenant(
        admin,
        owner.tenantId,
        (tx) =>
          tx`SELECT status, signature_valid FROM awcms_mini_integration_inbound_deliveries WHERE tenant_id = ${owner.tenantId}`
      );
      expect((deliveryRows as { status: string }[]).length).toBe(1);
      expect((deliveryRows as { status: string }[])[0]!.status).toBe(
        "normalized"
      );

      const eventRows = await withTenant(
        admin,
        owner.tenantId,
        (tx) =>
          tx`SELECT id FROM awcms_mini_domain_events WHERE tenant_id = ${owner.tenantId} AND event_type = 'awcms-mini.integration-hub.inbound-message.normalized'`
      );
      expect((eventRows as unknown[]).length).toBe(1);
    });

    test("REPLAY: the identical delivery POSTed twice is deduplicated by a REAL database uniqueness constraint — exactly one delivery row and one domain event exist after both requests", async () => {
      const owner = await bootstrap();
      await provisionAppRole();

      const secret = "webhook-secret-value";
      const endpoint = await createFixtureEndpoint(owner, secret);

      const payload = { hello: "world" };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = fixtureSignatureTestHelpers.signHmacSha256(
        secret,
        timestamp,
        rawBody
      );
      const headers = {
        "content-type": "application/json",
        "x-integration-signature": signature,
        "x-integration-timestamp": timestamp,
        "x-integration-delivery-id": "delivery-fixed-id"
      };

      const first = await invoke<{ data: { status: string } }>(inboundReceive, {
        method: "POST",
        path: `/api/v1/integration-hub/inbound/${endpoint.endpointToken}`,
        headers,
        body: payload,
        params: { endpointToken: endpoint.endpointToken }
      });
      expect(first.status).toBe(200);
      expect(first.body.data.status).toBe("accepted");

      const second = await invoke<{ data: { status: string } }>(
        inboundReceive,
        {
          method: "POST",
          path: `/api/v1/integration-hub/inbound/${endpoint.endpointToken}`,
          headers,
          body: payload,
          params: { endpointToken: endpoint.endpointToken }
        }
      );
      expect(second.status).toBe(200);
      expect(second.body.data.status).toBe("duplicate_ignored");

      const admin = getAdminSql();
      const deliveryRows = await withTenant(
        admin,
        owner.tenantId,
        (tx) =>
          tx`SELECT id FROM awcms_mini_integration_inbound_deliveries WHERE tenant_id = ${owner.tenantId} AND replay_key = 'delivery-fixed-id'`
      );
      // The DB uniqueness constraint (tenant_id, endpoint_id, replay_key)
      // is what makes this exactly 1, not application-layer logic alone.
      expect((deliveryRows as unknown[]).length).toBe(1);

      const eventRows = await withTenant(
        admin,
        owner.tenantId,
        (tx) =>
          tx`SELECT id FROM awcms_mini_domain_events WHERE tenant_id = ${owner.tenantId} AND event_type = 'awcms-mini.integration-hub.inbound-message.normalized'`
      );
      expect((eventRows as unknown[]).length).toBe(1);
    });

    test("ADVERSARIAL: a near-correct-but-wrong signature is rejected (401) at the real HTTP boundary", async () => {
      const owner = await bootstrap();
      await provisionAppRole();

      const secret = "webhook-secret-value";
      const endpoint = await createFixtureEndpoint(owner, secret);

      const payload = { hello: "world" };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const correctSignature = fixtureSignatureTestHelpers.signHmacSha256(
        secret,
        timestamp,
        rawBody
      );
      const almostRightSignature =
        correctSignature.slice(0, -1) +
        (correctSignature.endsWith("0") ? "1" : "0");

      const result = await invoke(inboundReceive, {
        method: "POST",
        path: `/api/v1/integration-hub/inbound/${endpoint.endpointToken}`,
        headers: {
          "content-type": "application/json",
          "x-integration-signature": almostRightSignature,
          "x-integration-timestamp": timestamp
        },
        body: payload,
        params: { endpointToken: endpoint.endpointToken }
      });

      expect(result.status).toBe(401);

      const admin = getAdminSql();
      const deliveryRows = await withTenant(
        admin,
        owner.tenantId,
        (tx) =>
          tx`SELECT signature_valid, status FROM awcms_mini_integration_inbound_deliveries WHERE tenant_id = ${owner.tenantId}`
      );
      expect(
        (deliveryRows as { signature_valid: boolean }[])[0]!.signature_valid
      ).toBe(false);

      const eventRows = await withTenant(
        admin,
        owner.tenantId,
        (tx) =>
          tx`SELECT id FROM awcms_mini_domain_events WHERE tenant_id = ${owner.tenantId}`
      );
      expect((eventRows as unknown[]).length).toBe(0);
    });

    test("a tampered body is rejected (401) even with a signature valid for the original body", async () => {
      const owner = await bootstrap();
      await provisionAppRole();

      const secret = "webhook-secret-value";
      const endpoint = await createFixtureEndpoint(owner, secret);

      const originalBody = JSON.stringify({ hello: "world" });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = fixtureSignatureTestHelpers.signHmacSha256(
        secret,
        timestamp,
        originalBody
      );

      const result = await invoke(inboundReceive, {
        method: "POST",
        path: `/api/v1/integration-hub/inbound/${endpoint.endpointToken}`,
        headers: {
          "content-type": "application/json",
          "x-integration-signature": signature,
          "x-integration-timestamp": timestamp
        },
        body: { hello: "TAMPERED" },
        params: { endpointToken: endpoint.endpointToken }
      });

      expect(result.status).toBe(401);
    });

    test("a stale timestamp is rejected (401)", async () => {
      const owner = await bootstrap();
      await provisionAppRole();

      const secret = "webhook-secret-value";
      const endpoint = await createFixtureEndpoint(owner, secret);

      const payload = { hello: "world" };
      const rawBody = JSON.stringify(payload);
      const staleTimestamp = String(Math.floor(Date.now() / 1000) - 7200);
      const signature = fixtureSignatureTestHelpers.signHmacSha256(
        secret,
        staleTimestamp,
        rawBody
      );

      const result = await invoke(inboundReceive, {
        method: "POST",
        path: `/api/v1/integration-hub/inbound/${endpoint.endpointToken}`,
        headers: {
          "content-type": "application/json",
          "x-integration-signature": signature,
          "x-integration-timestamp": staleTimestamp
        },
        body: payload,
        params: { endpointToken: endpoint.endpointToken }
      });

      expect(result.status).toBe(401);
    });

    test("an unknown endpoint token returns 404 (never reveals whether a token exists)", async () => {
      const result = await invoke(inboundReceive, {
        method: "POST",
        path: "/api/v1/integration-hub/inbound/does-not-exist",
        headers: { "content-type": "application/json" },
        body: { hello: "world" },
        params: { endpointToken: "does-not-exist" }
      });

      expect(result.status).toBe(404);
    });

    test("wrong tenant's endpoint token never resolves another tenant's data — a delivery for tenant A's endpoint is only ever visible under tenant A", async () => {
      const ownerA = await bootstrap("tenant-a", "Tenant A");
      await provisionAppRole();
      const secret = "webhook-secret-value";
      const endpointA = await createFixtureEndpoint(ownerA, secret);

      const ownerB = await seedSecondTenantWithIntegrationHubAccess("tenant-b");

      const payload = { hello: "world" };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = fixtureSignatureTestHelpers.signHmacSha256(
        secret,
        timestamp,
        rawBody
      );

      const result = await invoke(inboundReceive, {
        method: "POST",
        path: `/api/v1/integration-hub/inbound/${endpointA.endpointToken}`,
        headers: {
          "content-type": "application/json",
          "x-integration-signature": signature,
          "x-integration-timestamp": timestamp
        },
        body: payload,
        params: { endpointToken: endpointA.endpointToken }
      });
      expect(result.status).toBe(200);

      const listAsB = await invoke<{ data: { deliveries: unknown[] } }>(
        listOutboundDeliveriesRoute,
        {
          method: "GET",
          path: "/api/v1/integration-hub/deliveries/outbound",
          headers: authHeaders(ownerB)
        }
      );
      expect(listAsB.status).toBe(200);
      expect(listAsB.body.data.deliveries.length).toBe(0);
    });
  });

  describe("cross-tenant isolation (RLS)", () => {
    test("tenant B cannot see tenant A's inbound endpoints, even with its own integration_hub access", async () => {
      const ownerA = await bootstrap("tenant-a", "Tenant A");
      await provisionAppRole();
      await createFixtureEndpoint(ownerA, "secret-a");

      const ownerB = await seedSecondTenantWithIntegrationHubAccess("tenant-b");

      const listAsB = await invoke<{ data: { endpoints: unknown[] } }>(
        listEndpoints,
        {
          method: "GET",
          path: "/api/v1/integration-hub/endpoints",
          headers: authHeaders(ownerB)
        }
      );

      expect(listAsB.status).toBe(200);
      expect(listAsB.body.data.endpoints.length).toBe(0);
    });

    test("a tenant with no integration_hub permissions is denied (403), not silently empty", async () => {
      const owner = await bootstrap();
      await provisionAppRole();

      // No permissions granted for this random tenant/session shape —
      // reuse the restricted-tenant pattern inline (bare fetch of a
      // non-owner session is out of scope here; assert the owner's OWN
      // role, once stripped of integration_hub permissions, is denied).
      const admin = getAdminSql();
      await admin`
        DELETE FROM awcms_mini_role_permissions
        WHERE tenant_id = ${owner.tenantId}
          AND permission_id IN (SELECT id FROM awcms_mini_permissions WHERE module_key = 'integration_hub')
      `;

      const result = await invoke(listEndpoints, {
        method: "GET",
        path: "/api/v1/integration-hub/endpoints",
        headers: authHeaders(owner)
      });

      expect(result.status).toBe(403);
    });
  });

  describe("least-privilege awcms_mini_worker role", () => {
    test("fan-out consumer + outbound dispatch job succeed end-to-end over the real awcms_mini_worker connection (not just admin/superuser)", async () => {
      const owner = await bootstrap();
      await provisionAppRole();
      await provisionWorkerRole();

      const secret = "webhook-secret-value";
      const endpoint = await createFixtureEndpoint(owner, secret);

      process.env.INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS = "true";

      let receivedBody: unknown = null;
      let receivedCount = 0;
      const fakeServer = Bun.serve({
        port: 0,
        fetch: async (request) => {
          receivedCount += 1;
          receivedBody = await request.json().catch(() => null);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
      });

      try {
        const subscriptionResult = await invoke<{
          data: { subscription: { id: string } };
        }>(createSubscriptionRoute, {
          method: "POST",
          path: "/api/v1/integration-hub/subscriptions",
          headers: {
            ...authHeaders(owner),
            "idempotency-key": crypto.randomUUID()
          },
          body: {
            subscribedEventType:
              "awcms-mini.integration-hub.inbound-message.normalized",
            targetAdapterKey: "generic_http_webhook",
            targetUrl: `http://127.0.0.1:${fakeServer.port}/webhook`
          }
        });
        expect(subscriptionResult.status).toBe(200);

        const subscriptionListResult = await invoke<{
          data: { subscriptions: { id: string; targetAdapterKey: string }[] };
        }>(listSubscriptions, {
          method: "GET",
          path: "/api/v1/integration-hub/subscriptions",
          headers: authHeaders(owner)
        });
        expect(subscriptionListResult.status).toBe(200);
        expect(
          subscriptionListResult.body.data.subscriptions.map((s) => s.id)
        ).toContain(subscriptionResult.body.data.subscription.id);
        expect(
          subscriptionListResult.body.data.subscriptions[0]!.targetAdapterKey
        ).toBe("generic_http_webhook");

        const payload = { hello: "world" };
        const rawBody = JSON.stringify(payload);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = fixtureSignatureTestHelpers.signHmacSha256(
          secret,
          timestamp,
          rawBody
        );

        const inboundResult = await invoke(inboundReceive, {
          method: "POST",
          path: `/api/v1/integration-hub/inbound/${endpoint.endpointToken}`,
          headers: {
            "content-type": "application/json",
            "x-integration-signature": signature,
            "x-integration-timestamp": timestamp
          },
          body: payload,
          params: { endpointToken: endpoint.endpointToken }
        });
        expect(inboundResult.status).toBe(200);

        const workerSql = getWorkerTestSql();

        const dispatchResult = await dispatchDomainEventsForTenant(
          workerSql,
          owner.tenantId
        );
        expect(dispatchResult.delivered).toBeGreaterThanOrEqual(1);

        const admin = getAdminSql();
        const pendingRows = await withTenant(
          admin,
          owner.tenantId,
          (tx) =>
            tx`SELECT id, status FROM awcms_mini_integration_outbound_deliveries WHERE tenant_id = ${owner.tenantId}`
        );
        expect((pendingRows as { status: string }[]).length).toBe(1);
        expect((pendingRows as { status: string }[])[0]!.status).toBe(
          "pending"
        );

        const outboundResult = await dispatchOutboundQueue(
          workerSql,
          owner.tenantId,
          { env: process.env }
        );
        expect(outboundResult.delivered).toBe(1);
        expect(receivedCount).toBe(1);
        expect(receivedBody).toMatchObject({
          eventType: "awcms-mini.integration-hub.inbound-message.normalized"
        });

        const deliveredRows = await withTenant(
          admin,
          owner.tenantId,
          (tx) =>
            tx`SELECT status FROM awcms_mini_integration_outbound_deliveries WHERE tenant_id = ${owner.tenantId}`
        );
        expect((deliveredRows as { status: string }[])[0]!.status).toBe(
          "delivered"
        );

        const attemptRows = await withTenant(
          admin,
          owner.tenantId,
          (tx) =>
            tx`SELECT outcome FROM awcms_mini_integration_delivery_attempts WHERE tenant_id = ${owner.tenantId}`
        );
        expect((attemptRows as { outcome: string }[]).length).toBe(1);
        expect((attemptRows as { outcome: string }[])[0]!.outcome).toBe(
          "success"
        );

        const healthRows = await withTenant(
          admin,
          owner.tenantId,
          (tx) =>
            tx`SELECT state FROM awcms_mini_integration_adapter_health WHERE tenant_id = ${owner.tenantId} AND direction = 'outbound'`
        );
        expect((healthRows as { state: string }[])[0]!.state).toBe("up");
      } finally {
        fakeServer.stop(true);
      }
    });
  });

  describe("secret reference naming restriction (security-auditor Medium finding, PR #784)", () => {
    test("ADVERSARIAL: endpoint create is rejected when secretReference points at an unrelated env var", async () => {
      const owner = await bootstrap();

      const result = await invoke(createEndpointRoute, {
        method: "POST",
        path: "/api/v1/integration-hub/endpoints",
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        body: {
          adapterKey: "fixture_hmac_sha256",
          displayName: "Test endpoint",
          // Not prefixed INTEGRATION_HUB_ — a confused-deputy attempt to
          // reference an unrelated process-wide secret.
          secretReference: "env:DATABASE_URL"
        }
      });

      expect(result.status).toBe(400);
    });

    test("endpoint create succeeds with a properly-prefixed secretReference", async () => {
      const owner = await bootstrap();

      const result = await invoke<{ data: { endpoint: { id: string } } }>(
        createEndpointRoute,
        {
          method: "POST",
          path: "/api/v1/integration-hub/endpoints",
          headers: {
            ...authHeaders(owner),
            "idempotency-key": crypto.randomUUID()
          },
          body: {
            adapterKey: "fixture_hmac_sha256",
            displayName: "Test endpoint",
            secretReference: "env:INTEGRATION_HUB_SOME_SECRET"
          }
        }
      );

      expect(result.status).toBe(200);
    });

    test("ADVERSARIAL: rotate-secret is rejected when the new reference points at an unrelated env var", async () => {
      const owner = await bootstrap();
      await provisionAppRole();
      const endpoint = await createFixtureEndpoint(
        owner,
        "webhook-secret-value"
      );

      const result = await invoke(rotateSecretRoute, {
        method: "POST",
        path: `/api/v1/integration-hub/endpoints/${endpoint.id}/rotate-secret`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: endpoint.id },
        body: { newSecretReference: "env:MAILKETING_API_KEY" }
      });

      expect(result.status).toBe(400);
    });

    test("ADVERSARIAL: subscription create is rejected when secretReference points at an unrelated env var", async () => {
      const owner = await bootstrap();

      const result = await invoke(createSubscriptionRoute, {
        method: "POST",
        path: "/api/v1/integration-hub/subscriptions",
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        body: {
          subscribedEventType:
            "awcms-mini.integration-hub.inbound-message.normalized",
          targetAdapterKey: "generic_http_webhook",
          targetUrl: "https://example.com/webhook",
          secretReference: "env:DATABASE_URL"
        }
      });

      expect(result.status).toBe(400);
    });
  });

  describe("stale 'sending' lease reclaim (reviewer Medium finding, PR #784)", () => {
    test("a delivery stranded in 'sending' after its lease expired (simulated worker crash) is reclaimed and delivered on the next dispatch pass", async () => {
      const owner = await bootstrap();
      await provisionAppRole();
      await provisionWorkerRole();

      const secret = "webhook-secret-value";
      const endpoint = await createFixtureEndpoint(owner, secret);
      process.env.INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS = "true";

      let receivedCount = 0;
      const fakeServer = Bun.serve({
        port: 0,
        fetch: async () => {
          receivedCount += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
      });

      try {
        const subscriptionResult = await invoke<{
          data: { subscription: { id: string } };
        }>(createSubscriptionRoute, {
          method: "POST",
          path: "/api/v1/integration-hub/subscriptions",
          headers: {
            ...authHeaders(owner),
            "idempotency-key": crypto.randomUUID()
          },
          body: {
            subscribedEventType:
              "awcms-mini.integration-hub.inbound-message.normalized",
            targetAdapterKey: "generic_http_webhook",
            targetUrl: `http://127.0.0.1:${fakeServer.port}/webhook`
          }
        });
        expect(subscriptionResult.status).toBe(200);

        const payload = { hello: "world" };
        const rawBody = JSON.stringify(payload);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = fixtureSignatureTestHelpers.signHmacSha256(
          secret,
          timestamp,
          rawBody
        );

        const inboundResult = await invoke(inboundReceive, {
          method: "POST",
          path: `/api/v1/integration-hub/inbound/${endpoint.endpointToken}`,
          headers: {
            "content-type": "application/json",
            "x-integration-signature": signature,
            "x-integration-timestamp": timestamp
          },
          body: payload,
          params: { endpointToken: endpoint.endpointToken }
        });
        expect(inboundResult.status).toBe(200);

        const workerSql = getWorkerTestSql();
        const admin = getAdminSql();

        await dispatchDomainEventsForTenant(workerSql, owner.tenantId);

        // Simulate a worker that claimed the delivery (flipped it to
        // 'sending') and then crashed mid-fetch(), BEFORE the fix's
        // reclaim clause existed the row would sit in 'sending' forever
        // (next_attempt_at reused as the lease expiry, already elapsed).
        const staleLeaseExpiry = new Date(Date.now() - 60_000);
        await withTenant(
          admin,
          owner.tenantId,
          (tx) =>
            tx`
            UPDATE awcms_mini_integration_outbound_deliveries
            SET status = 'sending', next_attempt_at = ${staleLeaseExpiry}
            WHERE tenant_id = ${owner.tenantId}
          `
        );

        const strandedRows = await withTenant(
          admin,
          owner.tenantId,
          (tx) =>
            tx`SELECT status FROM awcms_mini_integration_outbound_deliveries WHERE tenant_id = ${owner.tenantId}`
        );
        expect((strandedRows as { status: string }[])[0]!.status).toBe(
          "sending"
        );

        const dispatchResult = await dispatchOutboundQueue(
          workerSql,
          owner.tenantId,
          { env: process.env }
        );

        expect(dispatchResult.claimed).toBe(1);
        expect(dispatchResult.delivered).toBe(1);
        expect(receivedCount).toBe(1);

        const finalRows = await withTenant(
          admin,
          owner.tenantId,
          (tx) =>
            tx`SELECT status FROM awcms_mini_integration_outbound_deliveries WHERE tenant_id = ${owner.tenantId}`
        );
        expect((finalRows as { status: string }[])[0]!.status).toBe(
          "delivered"
        );
      } finally {
        fakeServer.stop(true);
      }
    });
  });

  describe("inbound payload PII redaction (security-auditor Low finding, PR #784)", () => {
    test("a PII-key-named field in the provider payload is redacted before being persisted into the domain event", async () => {
      const owner = await bootstrap();
      await provisionAppRole();

      const secret = "webhook-secret-value";
      const endpoint = await createFixtureEndpoint(owner, secret);

      const payload = {
        orderId: "order-123",
        email: "customer@example.com",
        phone: "+6281234567890"
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = fixtureSignatureTestHelpers.signHmacSha256(
        secret,
        timestamp,
        rawBody
      );

      const result = await invoke(inboundReceive, {
        method: "POST",
        path: `/api/v1/integration-hub/inbound/${endpoint.endpointToken}`,
        headers: {
          "content-type": "application/json",
          "x-integration-signature": signature,
          "x-integration-timestamp": timestamp
        },
        body: payload,
        params: { endpointToken: endpoint.endpointToken }
      });
      expect(result.status).toBe(200);

      const admin = getAdminSql();
      const eventRows = (await withTenant(
        admin,
        owner.tenantId,
        (tx) =>
          tx`SELECT payload FROM awcms_mini_domain_events WHERE tenant_id = ${owner.tenantId} AND event_type = 'awcms-mini.integration-hub.inbound-message.normalized'`
      )) as { payload: { body: Record<string, unknown> } }[];

      expect(eventRows.length).toBe(1);
      const body = eventRows[0]!.payload.body as Record<string, unknown>;
      expect(body.orderId).toBe("order-123");
      expect(body.email).toBe("[REDACTED]");
      expect(body.phone).toBe("[REDACTED]");
    });

    // Security-auditor Medium finding (PR #784): `raw_body_snippet` only
    // ever got secret-PATTERN redaction, never the PII-key-based masking
    // `normalizedBody` gets above — a PII-key-named field (nik/npwp/phone/
    // email) was stored in plaintext in `awcms_mini_integration_inbound_
    // deliveries.raw_body_snippet`. Fixed by not persisting the raw
    // snippet at all once the normalized body already IS the real,
    // key-redacted artifact for this delivery (a JSON object payload).
    test("raw_body_snippet is NOT persisted for a JSON-object payload (the redacted normalized body already covers troubleshooting)", async () => {
      const owner = await bootstrap();
      await provisionAppRole();

      const secret = "webhook-secret-value";
      const endpoint = await createFixtureEndpoint(owner, secret);

      const payload = {
        orderId: "order-456",
        nik: "3271011234567890",
        npwp: "12.345.678.9-012.000"
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = fixtureSignatureTestHelpers.signHmacSha256(
        secret,
        timestamp,
        rawBody
      );

      const result = await invoke(inboundReceive, {
        method: "POST",
        path: `/api/v1/integration-hub/inbound/${endpoint.endpointToken}`,
        headers: {
          "content-type": "application/json",
          "x-integration-signature": signature,
          "x-integration-timestamp": timestamp
        },
        body: payload,
        params: { endpointToken: endpoint.endpointToken }
      });
      expect(result.status).toBe(200);

      const admin = getAdminSql();
      const deliveryRows = (await withTenant(
        admin,
        owner.tenantId,
        (tx) =>
          tx`SELECT raw_body_snippet FROM awcms_mini_integration_inbound_deliveries WHERE tenant_id = ${owner.tenantId}`
      )) as { raw_body_snippet: string | null }[];

      expect(deliveryRows.length).toBe(1);
      expect(deliveryRows[0]!.raw_body_snippet).toBeNull();
    });

    // Regression guard for the OTHER branch of the same fix: when the
    // payload is NOT a JSON object (here, a top-level JSON array — never
    // redacted by `redactNormalizedBodyPii`, same restriction
    // `redactSensitiveAttributes` itself has), the raw snippet remains the
    // only troubleshooting artifact this delivery has, so it must still
    // be persisted (secret-pattern-redacted, as before this fix).
    test("raw_body_snippet IS still persisted (secret-pattern-redacted) for a non-object JSON payload", async () => {
      const owner = await bootstrap();
      await provisionAppRole();

      const secret = "webhook-secret-value";
      const endpoint = await createFixtureEndpoint(owner, secret);

      const payload = [{ orderId: "order-789" }];
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = fixtureSignatureTestHelpers.signHmacSha256(
        secret,
        timestamp,
        rawBody
      );

      const result = await invoke(inboundReceive, {
        method: "POST",
        path: `/api/v1/integration-hub/inbound/${endpoint.endpointToken}`,
        headers: {
          "content-type": "application/json",
          "x-integration-signature": signature,
          "x-integration-timestamp": timestamp
        },
        body: payload,
        params: { endpointToken: endpoint.endpointToken }
      });
      expect(result.status).toBe(200);

      const admin = getAdminSql();
      const deliveryRows = (await withTenant(
        admin,
        owner.tenantId,
        (tx) =>
          tx`SELECT raw_body_snippet FROM awcms_mini_integration_inbound_deliveries WHERE tenant_id = ${owner.tenantId}`
      )) as { raw_body_snippet: string | null }[];

      expect(deliveryRows.length).toBe(1);
      expect(deliveryRows[0]!.raw_body_snippet).toBe(rawBody);
    });
  });
});
