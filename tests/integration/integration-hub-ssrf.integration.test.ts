/**
 * SSRF-guard coverage for integration-hub OUTBOUND webhooks, backfilling
 * Issue #827 (epic #818). The existing `integration-hub.integration.test.ts`
 * exercises inbound signature/replay/tamper/secret-ref and the outbound HAPPY
 * path — but it does so with `INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS=true` so its
 * local fake server (127.0.0.1) is reachable, which means the SSRF guard is
 * never actually exercised BLOCKING anything through a real API/job path. This
 * file closes that gap on the two enforcement points the module documents:
 *
 *   1. WRITE-time (ingress): creating an outbound subscription whose targetUrl
 *      resolves to a private/link-local address is rejected at the real
 *      `POST /api/v1/integration-hub/subscriptions` route (400), never
 *      persisted.
 *   2. DISPATCH-time (defense in depth): a subscription whose target was
 *      private and slipped past the write-time check (e.g. the trusted-target
 *      env flag was later turned OFF, or a DNS-rebind flips a once-public host
 *      to a private address) is BLOCKED by the dispatcher before any HTTP
 *      request leaves the process — the delivery is dead-lettered (non-
 *      retryable) and NO packet reaches the target.
 *
 * NOTE: never assert a raw Bun.SQL/postgres rejection with
 * `.rejects.toThrow()` in this repo — it spins forever. Not needed here.
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
import { POST as createEndpointRoute } from "../../src/pages/api/v1/integration-hub/endpoints/index";
import { POST as createSubscriptionRoute } from "../../src/pages/api/v1/integration-hub/subscriptions/index";

import { fixtureSignatureTestHelpers } from "../../src/modules/integration-hub/domain/fixture-signature-schemes";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import { dispatchOutboundQueue } from "../../src/modules/integration-hub/application/outbound-dispatch";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";
const WEBHOOK_SECRET_ENV_VAR = "INTEGRATION_HUB_SSRF_TEST_WEBHOOK_SECRET";
const NORMALIZED_EVENT_TYPE =
  "awcms-mini.integration-hub.inbound-message.normalized";

type Bootstrap = { tenantId: string; token: string };

async function bootstrap(): Promise<Bootstrap> {
  const tenantCode = "acme";
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme",
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

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

async function createFixtureEndpoint(
  owner: Bootstrap,
  secret: string
): Promise<{ endpointToken: string }> {
  process.env[WEBHOOK_SECRET_ENV_VAR] = secret;
  const result = await invoke<{
    data: { endpoint: { endpointToken: string } };
  }>(createEndpointRoute, {
    method: "POST",
    path: "/api/v1/integration-hub/endpoints",
    headers: { ...authHeaders(owner), "idempotency-key": crypto.randomUUID() },
    body: {
      adapterKey: "fixture_hmac_sha256",
      displayName: "SSRF test endpoint",
      secretReference: `env:${WEBHOOK_SECRET_ENV_VAR}`
    }
  });
  expect(result.status).toBe(200);
  return { endpointToken: result.body.data.endpoint.endpointToken };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("integration-hub outbound SSRF guard (Issue #827)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    delete process.env[WEBHOOK_SECRET_ENV_VAR];
    delete process.env.INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS;
  });

  test("WRITE-time: creating a subscription targeting a link-local/private address is rejected at the real route (never persisted)", async () => {
    const owner = await bootstrap();
    // Guard ON (env flag deliberately unset in beforeEach).
    const blocked = await invoke(createSubscriptionRoute, {
      method: "POST",
      path: "/api/v1/integration-hub/subscriptions",
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      body: {
        subscribedEventType: NORMALIZED_EVENT_TYPE,
        targetAdapterKey: "generic_http_webhook",
        // Cloud metadata endpoint — the canonical SSRF target.
        targetUrl: "http://169.254.169.254/latest/meta-data/"
      }
    });
    expect(blocked.status).toBe(400);

    // Nothing was persisted.
    const admin = getAdminSql();
    const rows = await withTenant(
      admin,
      owner.tenantId,
      (tx) =>
        tx`SELECT id FROM awcms_mini_integration_subscriptions WHERE tenant_id = ${owner.tenantId}`
    );
    expect((rows as { id: string }[]).length).toBe(0);

    // A public https target IS accepted (proves the rejection is the SSRF
    // rule, not a blanket "all subscriptions rejected" false positive).
    const allowed = await invoke(createSubscriptionRoute, {
      method: "POST",
      path: "/api/v1/integration-hub/subscriptions",
      headers: {
        ...authHeaders(owner),
        "idempotency-key": crypto.randomUUID()
      },
      body: {
        subscribedEventType: NORMALIZED_EVENT_TYPE,
        targetAdapterKey: "generic_http_webhook",
        targetUrl: "https://webhook.example.com/hook"
      }
    });
    expect(allowed.status).toBe(200);
  });

  test("DISPATCH-time (defense in depth): a persisted private target that slipped past write-time validation is blocked before any HTTP is sent; the delivery is dead-lettered", async () => {
    const owner = await bootstrap();
    const secret = "ssrf-webhook-secret-value";
    const endpoint = await createFixtureEndpoint(owner, secret);

    // A real local server that COUNTS inbound HTTP requests. It listens on
    // 127.0.0.1 (a private address) — exactly what the dispatch-time SSRF guard
    // must refuse to reach. If the guard is working, this counter stays 0.
    let hitCount = 0;
    const targetServer = Bun.serve({
      port: 0,
      fetch: () => {
        hitCount += 1;
        return new Response("ok", { status: 200 });
      }
    });

    try {
      // Persist the subscription while private targets are TEMPORARILY allowed
      // (simulating a target that was public/allowed at creation time, then
      // became private via env-flip or DNS rebind).
      process.env.INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS = "true";
      const subscription = await invoke(createSubscriptionRoute, {
        method: "POST",
        path: "/api/v1/integration-hub/subscriptions",
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        body: {
          subscribedEventType: NORMALIZED_EVENT_TYPE,
          targetAdapterKey: "generic_http_webhook",
          targetUrl: `http://127.0.0.1:${targetServer.port}/hook`
        }
      });
      expect(subscription.status).toBe(200);

      // The guard is now back ON for the dispatch pass.
      delete process.env.INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS;

      // Drive a real signed inbound message so the fan-out enqueues an outbound
      // delivery for our subscription.
      const payload = { hello: "ssrf" };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = fixtureSignatureTestHelpers.signHmacSha256(
        secret,
        timestamp,
        rawBody
      );
      const inbound = await invoke(inboundReceive, {
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
      expect(inbound.status).toBe(200);

      const workerSql = getWorkerTestSql();
      const fanOut = await dispatchDomainEventsForTenant(
        workerSql,
        owner.tenantId
      );
      expect(fanOut.delivered).toBeGreaterThanOrEqual(1);

      // The dispatch pass with the guard ON.
      const outbound = await dispatchOutboundQueue(workerSql, owner.tenantId, {
        env: process.env
      });

      // No HTTP request ever left the process.
      expect(hitCount).toBe(0);
      // The delivery was blocked, not delivered.
      expect(outbound.delivered).toBe(0);
      // SSRF block is non-retryable -> straight to dead_letter.
      expect(outbound.deadLettered).toBe(1);

      const admin = getAdminSql();
      const deliveryRows = (await withTenant(
        admin,
        owner.tenantId,
        (tx) =>
          tx`SELECT status, last_error FROM awcms_mini_integration_outbound_deliveries WHERE tenant_id = ${owner.tenantId}`
      )) as { status: string; last_error: string | null }[];
      expect(deliveryRows.length).toBe(1);
      expect(deliveryRows[0]!.status).toBe("dead_letter");
      expect((deliveryRows[0]!.last_error ?? "").toLowerCase()).toContain(
        "rejected"
      );

      const attemptRows = (await withTenant(
        admin,
        owner.tenantId,
        (tx) =>
          tx`SELECT outcome FROM awcms_mini_integration_delivery_attempts WHERE tenant_id = ${owner.tenantId}`
      )) as { outcome: string }[];
      expect(attemptRows.length).toBe(1);
      expect(attemptRows[0]!.outcome).toBe("failure");
    } finally {
      targetServer.stop(true);
    }
  });
});
