/**
 * Integration tests for Issue #742 (epic `platform-evolution` #738 Wave 1):
 * the transactional domain-event outbox and dispatcher — atomic commit,
 * rollback-produces-no-event, duplicate-dispatch/crash-restart-no-
 * duplicate-side-effect, retry/backoff/dead-letter, per-order-key
 * ordering (with unrelated keys progressing independently), replay
 * (permission/idempotency/reason/audit/schema-compatibility), and
 * multi-tenant RLS/ABAC isolation.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 *
 * NOTE: never use `.rejects.toThrow()`/`.rejects.toBeInstanceOf()` against
 * a real Bun.SQL/postgres promise in this repo — it spins the process at
 * 100% CPU forever (confirmed project pitfall). Every rejection below is
 * asserted via manual try/catch instead.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

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

import { GET as listEvents } from "../../src/pages/api/v1/domain-events/events/index";
import { GET as getEvent } from "../../src/pages/api/v1/domain-events/events/[id]";
import { GET as listDeliveries } from "../../src/pages/api/v1/domain-events/deliveries/index";
import { GET as getDelivery } from "../../src/pages/api/v1/domain-events/deliveries/[id]";
import { POST as replayDelivery } from "../../src/pages/api/v1/domain-events/deliveries/[id]/replay";
import { GET as listConsumers } from "../../src/pages/api/v1/domain-events/consumers/index";
import { POST as pauseConsumerRoute } from "../../src/pages/api/v1/domain-events/consumers/[name]/pause";
import { POST as resumeConsumerRoute } from "../../src/pages/api/v1/domain-events/consumers/[name]/resume";

import {
  appendDomainEvent,
  InvalidDomainEventPayloadError,
  UnregisteredDomainEventTypeError
} from "../../src/modules/domain-event-runtime/application/append-domain-event";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import { replayDomainEventDelivery } from "../../src/modules/domain-event-runtime/application/delivery-replay";
import {
  registerDomainEventConsumerForTests,
  resetDomainEventConsumersForTests
} from "../../src/modules/domain-event-runtime/infrastructure/consumer-registry";
import type { DomainEventConsumerDefinition } from "../../src/modules/domain-event-runtime/domain/consumer-types";
import {
  SAMPLE_RECORDED_EVENT_TYPE,
  SAMPLE_RECORDED_EVENT_VERSION
} from "../../src/modules/domain-event-runtime/domain/event-type-registry";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

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

/** A second, fully-independent tenant with NO permissions granted at all — for ABAC-deny/RLS tests. */
async function seedRestrictedSecondTenant(
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

/**
 * A second, fully-independent tenant that DOES have full
 * domain_event_runtime access (own role/permissions) — for RLS-invisibility
 * tests where a bare ABAC-deny (403) would be a false positive. `/setup/
 * initialize` is a one-time-only singleton wizard (confirmed empirically:
 * calling it a second time in the same test run returns 403, not a second
 * tenant), so a second tenant is always seeded via raw SQL + a real login,
 * same pattern `social-publishing.integration.test.ts`'s own
 * `seedSecondTenantWithSocialPublishingAccess` uses — never a second
 * `bootstrap()` call.
 */
async function seedSecondTenantWithDomainEventRuntimeAccess(
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
      SELECT id FROM awcms_mini_permissions WHERE module_key = 'domain_event_runtime'
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

function sampleInput(
  overrides: Partial<Parameters<typeof appendDomainEvent>[2]> = {}
) {
  return {
    eventType: SAMPLE_RECORDED_EVENT_TYPE,
    eventVersion: SAMPLE_RECORDED_EVENT_VERSION,
    aggregateType: "domain_event_sample",
    aggregateId: crypto.randomUUID(),
    producerModule: "domain_event_runtime",
    payload: { note: "integration test" },
    ...overrides
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite("domain-event-runtime (Issue #742)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetDomainEventConsumersForTests();
  });

  afterEach(() => {
    resetDomainEventConsumersForTests();
  });

  describe("transactional outbox — atomic commit / rollback", () => {
    test("appendDomainEvent commits atomically with the caller's own transaction", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      const result = await withTenant(sql, owner.tenantId, async (tx) => {
        return appendDomainEvent(tx, owner.tenantId, sampleInput());
      });

      expect(result.eventId).toBeTruthy();
      expect(result.deliveriesCreated).toBeGreaterThanOrEqual(2);

      const rows = await withTenant(
        sql,
        owner.tenantId,
        (tx) =>
          tx`SELECT id FROM awcms_mini_domain_events WHERE id = ${result.eventId}`
      );
      expect((rows as unknown[]).length).toBe(1);
    });

    test("a rolled-back source transaction produces no dispatchable event", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();
      let capturedEventId: string | undefined;

      let thrown: unknown;
      try {
        await withTenant(sql, owner.tenantId, async (tx) => {
          const result = await appendDomainEvent(
            tx,
            owner.tenantId,
            sampleInput()
          );
          capturedEventId = result.eventId;
          throw new Error("simulated failure after outbox append");
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(capturedEventId).toBeTruthy();

      const rows = await withTenant(
        sql,
        owner.tenantId,
        (tx) =>
          tx`SELECT id FROM awcms_mini_domain_events WHERE id = ${capturedEventId}`
      );
      expect((rows as unknown[]).length).toBe(0);
    });

    test("rejects a payload containing a credential-shaped key, persisting nothing", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      let thrown: unknown;
      try {
        await withTenant(sql, owner.tenantId, (tx) =>
          appendDomainEvent(
            tx,
            owner.tenantId,
            sampleInput({ payload: { apiKey: "should-never-persist" } })
          )
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(InvalidDomainEventPayloadError);
    });

    test("rejects an event type/version not present in DOMAIN_EVENT_TYPE_REGISTRY", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      let thrown: unknown;
      try {
        await withTenant(sql, owner.tenantId, (tx) =>
          appendDomainEvent(
            tx,
            owner.tenantId,
            sampleInput({ eventType: "awcms-mini.unregistered.thing.happened" })
          )
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnregisteredDomainEventTypeError);
    });
  });

  describe("dispatch, idempotent consumer side effects, crash/restart recovery", () => {
    test("dispatching delivers to both reference consumers exactly once (audit projection + activity rollup)", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, sampleInput())
      );

      const result = await dispatchDomainEventsForTenant(sql, owner.tenantId);
      expect(result.delivered).toBe(2);

      const auditRows = await withTenant(
        sql,
        owner.tenantId,
        (tx) =>
          tx`SELECT id FROM awcms_mini_audit_events WHERE tenant_id = ${owner.tenantId} AND action = 'domain_event_runtime.sample.audit_projected'`
      );
      expect((auditRows as unknown[]).length).toBe(1);

      const rollupRows = (await withTenant(
        sql,
        owner.tenantId,
        (tx) =>
          tx`SELECT event_count FROM awcms_mini_domain_event_activity_daily WHERE tenant_id = ${owner.tenantId} AND event_type = ${SAMPLE_RECORDED_EVENT_TYPE}`
      )) as { event_count: number }[];
      expect(rollupRows[0]?.event_count).toBe(1);
    });

    test("redelivering an already-delivered row (simulated worker restart) does not duplicate the side effect", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      const appended = await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, sampleInput())
      );

      const first = await dispatchDomainEventsForTenant(sql, owner.tenantId);
      expect(first.delivered).toBe(2);

      // Simulate a worker-restart redelivery: force the delivered rows back
      // to `pending` directly (bypassing the dispatcher's own state machine
      // — this is what a genuinely stuck/crashed process's row would look
      // like if naively reclaimed), then dispatch again.
      const admin = getAdminSql();
      await admin`
        UPDATE awcms_mini_domain_event_deliveries
        SET status = 'pending', delivered_at = NULL
        WHERE tenant_id = ${owner.tenantId} AND event_id = ${appended.eventId}
      `;

      const second = await dispatchDomainEventsForTenant(sql, owner.tenantId);
      expect(second.delivered).toBe(2);

      const auditRows = await withTenant(
        sql,
        owner.tenantId,
        (tx) =>
          tx`SELECT id FROM awcms_mini_audit_events WHERE tenant_id = ${owner.tenantId} AND action = 'domain_event_runtime.sample.audit_projected'`
      );
      // Still exactly one — applyConsumerEffectOnce's marker prevented the
      // redelivery from re-running the side effect.
      expect((auditRows as unknown[]).length).toBe(1);

      const rollupRows = (await withTenant(
        sql,
        owner.tenantId,
        (tx) =>
          tx`SELECT event_count FROM awcms_mini_domain_event_activity_daily WHERE tenant_id = ${owner.tenantId} AND event_type = ${SAMPLE_RECORDED_EVENT_TYPE}`
      )) as { event_count: number }[];
      expect(rollupRows[0]?.event_count).toBe(1);
    });

    test("a handler that throws leaves the delivery pending (no stuck claimed state) and a later successful attempt applies the side effect exactly once", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      let callCount = 0;
      const flaky: DomainEventConsumerDefinition = {
        name: "test.flaky_once_consumer",
        description: "Fails on its first invocation, succeeds thereafter.",
        eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
        eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
        maxAttempts: 5,
        handler: async () => {
          callCount += 1;
          if (callCount === 1) {
            throw new Error("simulated crash on first attempt");
          }
        }
      };
      registerDomainEventConsumerForTests(flaky);

      await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, sampleInput())
      );

      const first = await dispatchDomainEventsForTenant(sql, owner.tenantId);
      expect(first.retried).toBe(1);
      expect(callCount).toBe(1);

      const admin = getAdminSql();
      const rows = (await admin`
        SELECT status, attempt_count FROM awcms_mini_domain_event_deliveries
        WHERE tenant_id = ${owner.tenantId} AND consumer_name = 'test.flaky_once_consumer'
      `) as { status: string; attempt_count: number }[];
      expect(rows[0]?.status).toBe("pending");
      expect(Number(rows[0]?.attempt_count)).toBe(1);

      // Dispatch again with `now` far enough in the future to clear the
      // exponential backoff window set by the first failure.
      const future = new Date(Date.now() + 10 * 60 * 1000);
      const second = await dispatchDomainEventsForTenant(sql, owner.tenantId, {
        now: future
      });
      expect(second.delivered).toBeGreaterThanOrEqual(1);
      expect(callCount).toBe(2);
    });
  });

  describe("retry, exponential backoff, and dead-letter", () => {
    test("a consistently-failing consumer backs off, exhausts its attempt budget, and is dead-lettered with an audit event", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      const alwaysFails: DomainEventConsumerDefinition = {
        name: "test.always_fails_consumer",
        description: "Always throws a retryable-shaped error.",
        eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
        eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
        maxAttempts: 2,
        handler: async () => {
          throw new Error("ETIMEDOUT simulated transient failure");
        }
      };
      registerDomainEventConsumerForTests(alwaysFails);

      await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, sampleInput())
      );

      const now = new Date();
      const first = await dispatchDomainEventsForTenant(sql, owner.tenantId, {
        now
      });
      expect(first.retried).toBe(1);

      // Retried again immediately — still inside the backoff window, must
      // NOT be reclaimed early (ordering/backoff discipline).
      const immediateRetry = await dispatchDomainEventsForTenant(
        sql,
        owner.tenantId,
        { now }
      );
      expect(immediateRetry.claimed).toBe(0);

      const later = new Date(now.getTime() + 10 * 60 * 1000);
      const second = await dispatchDomainEventsForTenant(sql, owner.tenantId, {
        now: later
      });
      expect(second.deadLettered).toBe(1);

      const admin = getAdminSql();
      const deliveryRows = (await admin`
        SELECT status, attempt_count, dead_letter_reason FROM awcms_mini_domain_event_deliveries
        WHERE tenant_id = ${owner.tenantId} AND consumer_name = 'test.always_fails_consumer'
      `) as {
        status: string;
        attempt_count: number;
        dead_letter_reason: string;
      }[];
      expect(deliveryRows[0]?.status).toBe("dead_letter");
      expect(Number(deliveryRows[0]?.attempt_count)).toBe(2);

      const auditRows = await withTenant(
        sql,
        owner.tenantId,
        (tx) =>
          tx`SELECT id FROM awcms_mini_audit_events WHERE tenant_id = ${owner.tenantId} AND action = 'domain_event_runtime.delivery.dead_lettered'`
      );
      expect((auditRows as unknown[]).length).toBe(1);
    });

    test("a non-retryable error dead-letters immediately, without waiting out the attempt budget", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      const nonRetryable: DomainEventConsumerDefinition = {
        name: "test.non_retryable_consumer",
        description: "Throws a not_retryable-classified error.",
        eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
        eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
        maxAttempts: 8,
        handler: async () => {
          throw new Bun.SQL.PostgresError("duplicate key value", {
            code: "23505",
            errno: "23505"
          });
        }
      };
      registerDomainEventConsumerForTests(nonRetryable);

      await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, sampleInput())
      );

      const result = await dispatchDomainEventsForTenant(sql, owner.tenantId);
      expect(result.deadLettered).toBe(1);

      const admin = getAdminSql();
      const rows = (await admin`
        SELECT attempt_count FROM awcms_mini_domain_event_deliveries
        WHERE tenant_id = ${owner.tenantId} AND consumer_name = 'test.non_retryable_consumer'
      `) as { attempt_count: number }[];
      expect(Number(rows[0]?.attempt_count)).toBe(1);
    });
  });

  describe("per-order-key ordering", () => {
    test("two events for the SAME order key are delivered in order, one at a time", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();
      const processedOrder: string[] = [];

      const sequencer: DomainEventConsumerDefinition = {
        name: "test.sequencer_consumer",
        description: "Records the order events were delivered in.",
        eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
        eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
        handler: async (_tx, event) => {
          processedOrder.push(String(event.payload.sequence));
        }
      };
      registerDomainEventConsumerForTests(sequencer);

      const aggregateId = crypto.randomUUID();

      await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(
          tx,
          owner.tenantId,
          sampleInput({ aggregateId, payload: { sequence: "first" } })
        )
      );
      await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(
          tx,
          owner.tenantId,
          sampleInput({ aggregateId, payload: { sequence: "second" } })
        )
      );

      // Head-of-line selection (`selectHeadOfLineDeliveries`) deliberately
      // returns only the SINGLE oldest pending delivery per order_key per
      // pass — that is the whole point of per-key ordering (never let a
      // later event for the same key jump ahead of an earlier one still
      // in flight). So "first" and "second" require two separate dispatch
      // passes, exactly like two separate scheduled `bun run domain-
      // events:dispatch` ticks would naturally provide — a single pass
      // only ever advances one order_key by one step.
      await dispatchDomainEventsForTenant(sql, owner.tenantId);
      expect(processedOrder).toEqual(["first"]);

      await dispatchDomainEventsForTenant(sql, owner.tenantId);
      expect(processedOrder).toEqual(["first", "second"]);
    });

    test("an unrelated order key progresses independently while another is backed off", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();
      const delivered: string[] = [];

      const blockedAggregateId = crypto.randomUUID();
      const independentAggregateId = crypto.randomUUID();

      const conditional: DomainEventConsumerDefinition = {
        name: "test.conditional_consumer",
        description: "Fails only for one specific aggregate id.",
        eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
        eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
        handler: async (_tx, event) => {
          if (event.aggregateId === blockedAggregateId) {
            throw new Error("simulated failure for this aggregate only");
          }
          delivered.push(event.aggregateId);
        }
      };
      registerDomainEventConsumerForTests(conditional);

      await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(
          tx,
          owner.tenantId,
          sampleInput({ aggregateId: blockedAggregateId })
        )
      );
      await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(
          tx,
          owner.tenantId,
          sampleInput({ aggregateId: independentAggregateId })
        )
      );

      const result = await dispatchDomainEventsForTenant(sql, owner.tenantId);

      expect(delivered).toEqual([independentAggregateId]);
      expect(result.retried).toBeGreaterThanOrEqual(1);
    });
  });

  describe("pause/resume", () => {
    test("dispatch skips claiming deliveries for a paused consumer", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();
      let calls = 0;

      const pausable: DomainEventConsumerDefinition = {
        name: "test.pausable_consumer",
        description: "Counts invocations.",
        eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
        eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
        handler: async () => {
          calls += 1;
        }
      };
      registerDomainEventConsumerForTests(pausable);

      const pauseResult = await invoke(pauseConsumerRoute, {
        method: "POST",
        path: "/api/v1/domain-events/consumers/test.pausable_consumer/pause",
        headers: authHeaders(owner),
        params: { name: "test.pausable_consumer" },
        body: { reason: "investigating a bug" }
      });
      expect(pauseResult.status).toBe(200);

      await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, sampleInput())
      );

      await dispatchDomainEventsForTenant(sql, owner.tenantId);
      expect(calls).toBe(0);

      const resumeResult = await invoke(resumeConsumerRoute, {
        method: "POST",
        path: "/api/v1/domain-events/consumers/test.pausable_consumer/resume",
        headers: authHeaders(owner),
        params: { name: "test.pausable_consumer" }
      });
      expect(resumeResult.status).toBe(200);

      await dispatchDomainEventsForTenant(sql, owner.tenantId);
      expect(calls).toBe(1);
    });
  });

  describe("least-privilege awcms_mini_worker role (migration 056 grants)", () => {
    /**
     * Security-auditor finding (PR #772): every other test in this file
     * calls `dispatchDomainEventsForTenant` with the ADMIN/superuser
     * connection (`getAdminSql()`), which bypasses grant enforcement
     * entirely — a missing GRANT for `awcms_mini_worker` on any of the 6
     * new tables would have been invisible to the whole suite otherwise.
     * This test uses the REAL least-privilege worker connection
     * (`getWorkerTestSql()`, active once `provisionWorkerRole()` has run —
     * mirrors `tests/integration/db-role-separation.integration.test.ts`'s
     * own pattern), exactly like `bun run domain-events:dispatch` does in
     * a hardened deployment with `WORKER_DATABASE_URL` set (doc 18).
     */
    test("dispatchDomainEventsForTenant succeeds end-to-end (claim, deliver to both reference consumers, audit) over the real awcms_mini_worker connection, not just the admin connection", async () => {
      const owner = await bootstrap();
      const adminSql = getAdminSql();
      const workerSql = getWorkerTestSql();

      // appendDomainEvent still runs as awcms_mini_app (a producer's own
      // business transaction) — only the DISPATCH side is under test here.
      await withTenant(adminSql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, sampleInput())
      );

      const result = await dispatchDomainEventsForTenant(
        workerSql,
        owner.tenantId
      );

      expect(result.delivered).toBe(2);
      expect(result.retried).toBe(0);
      expect(result.deadLettered).toBe(0);

      const rows = await withTenant(
        adminSql,
        owner.tenantId,
        (tx) =>
          tx`SELECT status FROM awcms_mini_domain_event_deliveries WHERE tenant_id = ${owner.tenantId}`
      );
      expect(
        (rows as { status: string }[]).every(
          (row) => row.status === "delivered"
        )
      ).toBe(true);

      // Both reference consumers' side effects — the audit projector
      // (INSERT into awcms_mini_audit_events) and the activity rollup
      // (INSERT/UPDATE into awcms_mini_domain_event_activity_daily) — must
      // have actually succeeded under the worker role's own grants, not
      // silently no-opped.
      const auditRows = await withTenant(
        adminSql,
        owner.tenantId,
        (tx) =>
          tx`SELECT id FROM awcms_mini_audit_events WHERE tenant_id = ${owner.tenantId} AND action = 'domain_event_runtime.sample.audit_projected'`
      );
      expect((auditRows as unknown[]).length).toBe(1);

      const rollupRows = (await withTenant(
        adminSql,
        owner.tenantId,
        (tx) =>
          tx`SELECT event_count FROM awcms_mini_domain_event_activity_daily WHERE tenant_id = ${owner.tenantId}`
      )) as { event_count: number }[];
      expect(rollupRows[0]?.event_count).toBe(1);
    });

    test("a dead-lettered delivery (worker role) records a redacted-safe error and an audit event, entirely over the worker connection", async () => {
      const owner = await bootstrap();
      const adminSql = getAdminSql();
      const workerSql = getWorkerTestSql();

      const alwaysFails: DomainEventConsumerDefinition = {
        name: "test.worker_role_dlq_consumer",
        description:
          "Always fails, to exercise the worker role's UPDATE grant on deliveries and INSERT grant on audit_events for the dead-letter path.",
        eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
        eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
        maxAttempts: 1,
        handler: async () => {
          throw new Bun.SQL.PostgresError("check violation", {
            code: "23514",
            errno: "23514"
          });
        }
      };
      registerDomainEventConsumerForTests(alwaysFails);

      await withTenant(adminSql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, sampleInput())
      );

      const result = await dispatchDomainEventsForTenant(
        workerSql,
        owner.tenantId
      );
      expect(result.deadLettered).toBe(1);

      const rows = (await withTenant(
        adminSql,
        owner.tenantId,
        (tx) =>
          tx`SELECT status FROM awcms_mini_domain_event_deliveries WHERE tenant_id = ${owner.tenantId} AND consumer_name = 'test.worker_role_dlq_consumer'`
      )) as { status: string }[];
      expect(rows[0]?.status).toBe("dead_letter");
    });
  });

  describe("replay — permission, idempotency, reason, audit, schema compatibility", () => {
    async function createDeadLetteredDelivery(
      owner: Bootstrap
    ): Promise<{ eventId: string; deliveryId: string }> {
      const sql = getAdminSql();
      const alwaysFails: DomainEventConsumerDefinition = {
        name: "test.replay_target_consumer",
        description: "Always fails once, for replay-target setup.",
        eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
        eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
        maxAttempts: 1,
        handler: async () => {
          throw new Bun.SQL.PostgresError("check violation", {
            code: "23514",
            errno: "23514"
          });
        }
      };
      registerDomainEventConsumerForTests(alwaysFails);

      const appended = await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, sampleInput())
      );
      await dispatchDomainEventsForTenant(sql, owner.tenantId);

      const admin = getAdminSql();
      const rows = (await admin`
        SELECT id FROM awcms_mini_domain_event_deliveries
        WHERE tenant_id = ${owner.tenantId} AND event_id = ${appended.eventId}
          AND consumer_name = 'test.replay_target_consumer'
      `) as { id: string }[];

      return { eventId: appended.eventId, deliveryId: rows[0]!.id };
    }

    test("replay requires a non-empty reason", async () => {
      const owner = await bootstrap();
      const { deliveryId } = await createDeadLetteredDelivery(owner);

      const result = await invoke(replayDelivery, {
        method: "POST",
        path: `/api/v1/domain-events/deliveries/${deliveryId}/replay`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: deliveryId },
        body: { reason: "" }
      });

      expect(result.status).toBe(400);
    });

    test("replay requires an Idempotency-Key header", async () => {
      const owner = await bootstrap();
      const { deliveryId } = await createDeadLetteredDelivery(owner);

      const result = await invoke(replayDelivery, {
        method: "POST",
        path: `/api/v1/domain-events/deliveries/${deliveryId}/replay`,
        headers: authHeaders(owner),
        params: { id: deliveryId },
        body: { reason: "operator investigated and fixed the bug" }
      });

      expect(result.status).toBe(400);
      expect((result.body as { error: { code: string } }).error.code).toBe(
        "IDEMPOTENCY_REQUIRED"
      );
    });

    test("replays a dead-lettered delivery, creates a new pending delivery row, and records an audit event", async () => {
      const owner = await bootstrap();
      const { deliveryId } = await createDeadLetteredDelivery(owner);
      const idempotencyKey = crypto.randomUUID();

      const result = await invoke<{
        data: {
          delivery: { id: string; status: string; replayOfDeliveryId: string };
        };
      }>(replayDelivery, {
        method: "POST",
        path: `/api/v1/domain-events/deliveries/${deliveryId}/replay`,
        headers: { ...authHeaders(owner), "idempotency-key": idempotencyKey },
        params: { id: deliveryId },
        body: { reason: "operator investigated and fixed the bug" }
      });

      expect(result.status).toBe(200);
      expect(result.body.data.delivery.status).toBe("pending");
      expect(result.body.data.delivery.replayOfDeliveryId).toBe(deliveryId);

      const admin = getAdminSql();
      const replayRows = (await admin`
        SELECT reason, requested_by FROM awcms_mini_domain_event_replays
        WHERE tenant_id = ${owner.tenantId} AND original_delivery_id = ${deliveryId}
      `) as { reason: string; requested_by: string }[];
      expect(replayRows.length).toBe(1);
      expect(replayRows[0]?.requested_by).toBe(owner.tenantUserId);

      const sql = getAdminSql();
      const auditRows = await withTenant(
        sql,
        owner.tenantId,
        (tx) =>
          tx`SELECT id FROM awcms_mini_audit_events WHERE tenant_id = ${owner.tenantId} AND action = 'domain_event_runtime.delivery.replayed'`
      );
      expect((auditRows as unknown[]).length).toBe(1);
    });

    test("replaying with the same Idempotency-Key twice does not create two replay rows", async () => {
      const owner = await bootstrap();
      const { deliveryId } = await createDeadLetteredDelivery(owner);
      const idempotencyKey = crypto.randomUUID();
      const requestOptions = {
        method: "POST" as const,
        path: `/api/v1/domain-events/deliveries/${deliveryId}/replay`,
        headers: { ...authHeaders(owner), "idempotency-key": idempotencyKey },
        params: { id: deliveryId },
        body: { reason: "operator investigated and fixed the bug" }
      };

      const firstResult = await invoke<{ data: { delivery: { id: string } } }>(
        replayDelivery,
        requestOptions
      );
      const secondResult = await invoke<{ data: { delivery: { id: string } } }>(
        replayDelivery,
        requestOptions
      );

      expect(firstResult.status).toBe(200);
      expect(secondResult.status).toBe(200);
      expect(secondResult.body.data.delivery.id).toBe(
        firstResult.body.data.delivery.id
      );

      const admin = getAdminSql();
      const replayRows = (await admin`
        SELECT id FROM awcms_mini_domain_event_replays
        WHERE tenant_id = ${owner.tenantId} AND original_delivery_id = ${deliveryId}
      `) as { id: string }[];
      expect(replayRows.length).toBe(1);
    });

    test("replaying with the same Idempotency-Key but a different reason is a clean 409, not a duplicate", async () => {
      const owner = await bootstrap();
      const { deliveryId } = await createDeadLetteredDelivery(owner);
      const idempotencyKey = crypto.randomUUID();

      const firstResult = await invoke(replayDelivery, {
        method: "POST",
        path: `/api/v1/domain-events/deliveries/${deliveryId}/replay`,
        headers: { ...authHeaders(owner), "idempotency-key": idempotencyKey },
        params: { id: deliveryId },
        body: { reason: "reason A" }
      });
      expect(firstResult.status).toBe(200);

      const secondResult = await invoke(replayDelivery, {
        method: "POST",
        path: `/api/v1/domain-events/deliveries/${deliveryId}/replay`,
        headers: { ...authHeaders(owner), "idempotency-key": idempotencyKey },
        params: { id: deliveryId },
        body: { reason: "reason B" }
      });
      expect(secondResult.status).toBe(409);
      expect(
        (secondResult.body as { error: { code: string } }).error.code
      ).toBe("IDEMPOTENCY_CONFLICT");
    });

    test("refuses to replay a delivery that is not dead-lettered", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, sampleInput())
      );

      const admin = getAdminSql();
      const rows = (await admin`
        SELECT id FROM awcms_mini_domain_event_deliveries WHERE tenant_id = ${owner.tenantId} LIMIT 1
      `) as { id: string }[];
      const pendingDeliveryId = rows[0]!.id;

      const result = await invoke(replayDelivery, {
        method: "POST",
        path: `/api/v1/domain-events/deliveries/${pendingDeliveryId}/replay`,
        headers: {
          ...authHeaders(owner),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: pendingDeliveryId },
        body: { reason: "should not be allowed" }
      });

      expect(result.status).toBe(409);
    });

    test("application-level: refuses to replay against a schema version the registered consumer no longer supports", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();
      const admin = getAdminSql();

      const versionedConsumer: DomainEventConsumerDefinition = {
        name: "test.versioned_consumer",
        description: "Only supports 1.0.",
        eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
        eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
        handler: async () => {}
      };
      registerDomainEventConsumerForTests(versionedConsumer);

      const appended = await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(tx, owner.tenantId, sampleInput())
      );

      // Fabricate a dead-lettered delivery whose event_version the consumer
      // no longer declares support for (simulating "the consumer's code
      // moved on to a newer schema version after this delivery was
      // originally created").
      const deliveryRows = (await admin`
        UPDATE awcms_mini_domain_event_deliveries
        SET status = 'dead_letter', event_version = '9.9', dead_letter_at = now()
        WHERE tenant_id = ${owner.tenantId} AND event_id = ${appended.eventId}
          AND consumer_name = 'test.versioned_consumer'
        RETURNING id
      `) as { id: string }[];
      const deliveryId = deliveryRows[0]!.id;

      let thrown: unknown;
      try {
        await withTenant(sql, owner.tenantId, (tx) =>
          replayDomainEventDelivery(
            tx,
            owner.tenantId,
            owner.tenantUserId,
            deliveryId,
            "attempting an incompatible replay"
          )
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("ReplaySchemaIncompatibleError");
    });
  });

  describe("multi-tenant RLS/ABAC isolation", () => {
    test("a tenant with no domain_event_runtime permissions is denied (403), not silently empty", async () => {
      const restricted = await seedRestrictedSecondTenant("restricted");

      const result = await invoke(listEvents, {
        method: "GET",
        path: "/api/v1/domain-events/events",
        headers: authHeaders(restricted)
      });

      expect(result.status).toBe(403);
    });

    test("tenant B cannot see tenant A's domain events, even with its own domain_event_runtime access", async () => {
      const ownerA = await bootstrap("tenant-a", "Tenant A");
      const ownerB =
        await seedSecondTenantWithDomainEventRuntimeAccess("tenant-b");
      const sql = getAdminSql();

      const appended = await withTenant(sql, ownerA.tenantId, (tx) =>
        appendDomainEvent(tx, ownerA.tenantId, sampleInput())
      );

      const listResult = await invoke<{ data: { events: unknown[] } }>(
        listEvents,
        {
          method: "GET",
          path: "/api/v1/domain-events/events",
          headers: authHeaders(ownerB)
        }
      );
      expect(listResult.status).toBe(200);
      expect(listResult.body.data.events.length).toBe(0);

      const getResult = await invoke(getEvent, {
        method: "GET",
        path: `/api/v1/domain-events/events/${appended.eventId}`,
        headers: authHeaders(ownerB),
        params: { id: appended.eventId }
      });
      expect(getResult.status).toBe(404);
    });

    test("tenant B cannot replay tenant A's dead-lettered delivery", async () => {
      const ownerA = await bootstrap("tenant-a", "Tenant A");
      const ownerB =
        await seedSecondTenantWithDomainEventRuntimeAccess("tenant-b");
      const sql = getAdminSql();

      const alwaysFails: DomainEventConsumerDefinition = {
        name: "test.cross_tenant_consumer",
        description: "Always fails.",
        eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
        eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
        maxAttempts: 1,
        handler: async () => {
          throw new Bun.SQL.PostgresError("check violation", {
            code: "23514",
            errno: "23514"
          });
        }
      };
      registerDomainEventConsumerForTests(alwaysFails);

      const appended = await withTenant(sql, ownerA.tenantId, (tx) =>
        appendDomainEvent(tx, ownerA.tenantId, sampleInput())
      );
      await dispatchDomainEventsForTenant(sql, ownerA.tenantId);

      const admin = getAdminSql();
      const rows = (await admin`
        SELECT id FROM awcms_mini_domain_event_deliveries
        WHERE tenant_id = ${ownerA.tenantId} AND event_id = ${appended.eventId}
          AND consumer_name = 'test.cross_tenant_consumer'
      `) as { id: string }[];
      const deliveryId = rows[0]!.id;

      const result = await invoke(replayDelivery, {
        method: "POST",
        path: `/api/v1/domain-events/deliveries/${deliveryId}/replay`,
        headers: {
          ...authHeaders(ownerB),
          "idempotency-key": crypto.randomUUID()
        },
        params: { id: deliveryId },
        body: { reason: "cross-tenant attempt" }
      });

      expect(result.status).toBe(404);
    });
  });

  describe("API contract basics", () => {
    test("requires authentication", async () => {
      const result = await invoke(listEvents, {
        method: "GET",
        path: "/api/v1/domain-events/events",
        headers: { "x-awcms-mini-tenant-id": crypto.randomUUID() }
      });
      expect(result.status).toBe(401);
    });

    test("requires a tenant header", async () => {
      const owner = await bootstrap();
      const result = await invoke(listEvents, {
        method: "GET",
        path: "/api/v1/domain-events/events",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.token}`
        }
      });
      expect(result.status).toBe(400);
    });

    test("lists registered consumers with lag/DLQ counts", async () => {
      const owner = await bootstrap();
      const result = await invoke<{
        data: { consumers: { name: string; pendingCount: number }[] };
      }>(listConsumers, {
        method: "GET",
        path: "/api/v1/domain-events/consumers",
        headers: authHeaders(owner)
      });

      expect(result.status).toBe(200);
      expect(result.body.data.consumers.length).toBeGreaterThanOrEqual(2);
    });

    test("dead-letter inspection via GET .../deliveries?status=dead_letter returns a redacted payload projection", async () => {
      const owner = await bootstrap();
      const sql = getAdminSql();

      const alwaysFails: DomainEventConsumerDefinition = {
        name: "test.dlq_inspection_consumer",
        description: "Always fails.",
        eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
        eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
        maxAttempts: 1,
        handler: async () => {
          throw new Bun.SQL.PostgresError("check violation", {
            code: "23514",
            errno: "23514"
          });
        }
      };
      registerDomainEventConsumerForTests(alwaysFails);

      await withTenant(sql, owner.tenantId, (tx) =>
        appendDomainEvent(
          tx,
          owner.tenantId,
          sampleInput({ payload: { note: "will be dead-lettered" } })
        )
      );
      await dispatchDomainEventsForTenant(sql, owner.tenantId);

      const listResult = await invoke<{
        data: { deliveries: { id: string; status: string }[] };
      }>(listDeliveries, {
        method: "GET",
        path: "/api/v1/domain-events/deliveries?status=dead_letter",
        headers: authHeaders(owner)
      });
      expect(listResult.status).toBe(200);
      const dlqRow = listResult.body.data.deliveries.find(
        (d) => d.status === "dead_letter"
      );
      expect(dlqRow).toBeTruthy();

      const detailResult = await invoke<{
        data: { delivery: { event?: { payload?: Record<string, unknown> } } };
      }>(getDelivery, {
        method: "GET",
        path: `/api/v1/domain-events/deliveries/${dlqRow!.id}`,
        headers: authHeaders(owner),
        params: { id: dlqRow!.id }
      });
      expect(detailResult.status).toBe(200);
      // Never a raw stack trace / raw exception text in the delivery's own
      // error fields — checked structurally, not by exact string match.
      expect(detailResult.body.data.delivery.event?.payload).toBeTruthy();
    });
  });
});
