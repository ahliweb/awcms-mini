/**
 * Integration tests for the per-module control-plane signal collectors
 * (Issue #930, epic #868), against a real PostgreSQL database.
 *
 * These exist because the risky part of this feature is SQL, and SQL that is
 * only exercised by a smoke run returning zeros is not exercised at all — a
 * wrong predicate, a wrong join, or a status enum that does not match the
 * schema all produce a confident 0. Each test therefore seeds rows that
 * SHOULD count and rows that should NOT, and asserts the boundary between
 * them.
 *
 * The billing collector gets the most attention: it joins invoices to their
 * dunning attempts, and the obvious phrasing (a plain join) silently
 * multiplies one invoice by its retry count — so the metric would climb as
 * dunning worked HARDER, which is precisely backwards.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getWorkerTestSql,
  integrationEnabled,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { withTenant } from "../../src/lib/database/tenant-context";
import { collectEntitlementSignals } from "../../src/modules/tenant-entitlement/application/control-plane-signals";
import { collectPaymentGatewaySignals } from "../../src/modules/payment-gateway/application/control-plane-signals";
import { collectProvisioningSignals } from "../../src/modules/tenant-provisioning/application/control-plane-signals";
import { collectSubscriptionBillingSignals } from "../../src/modules/subscription-billing/application/control-plane-signals";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-01T00:00:00.000Z");
const EARLIER = new Date("2026-05-01T00:00:00.000Z");
const PAST = new Date("2026-06-01T00:00:00.000Z");
const FUTURE = new Date("2026-08-01T00:00:00.000Z");

async function seedTenant(): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${TENANT_ID}, 'signals', 'Signals', 'Signals', 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

/** Seeding runs as the admin/owner connection. */
function inTenant<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  return withTenant(getAdminSql(), TENANT_ID, fn);
}

/**
 * READS run as the real `awcms_mini_worker` role — the role the fleet sweep
 * actually uses. This is not incidental: a developer DATABASE_URL is usually a
 * superuser, and a superuser bypasses BOTH grants and RLS, so collectors
 * exercised through the admin connection appear to work perfectly while
 * missing a GRANT (the job then fails on its first tenant in production) and
 * while silently reading every tenant's rows at once. Running the collectors
 * as the worker role is what makes this suite able to catch either.
 */
function asWorker<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenant(getWorkerTestSql(), tenantId, fn);
}

const suite = integrationEnabled ? describe : describe.skip;

suite("control-plane signal collectors (Issue #930)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
  });

  describe("provisioning", () => {
    /**
     * `awcms_mini_tenant_provisioning_requests` carries a UNIQUE constraint on
     * `tenant_id` — provisioning is 1:1 with a tenant, so a single tenant can
     * never hold more than one request. Exercising several statuses therefore
     * requires several TENANTS, which is also exactly the fleet shape the
     * sweep aggregates: per tenant the collector returns at most one row, and
     * the fleet total is the count of tenants in each state.
     */
    async function seedTenantWithRequest(
      tenantId: string,
      code: string,
      status: string,
      requestedAt: Date,
      extra: { readinessState?: string; canceled?: boolean } = {}
    ): Promise<void> {
      await getAdminSql()`
        INSERT INTO awcms_mini_tenants
          (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
        VALUES (${tenantId}, ${code}, ${code}, ${code}, 'active', 'en', 'light')
        ON CONFLICT (id) DO NOTHING
      `;
      await withTenant(
        getAdminSql(),
        tenantId,
        (tx) => tx`
        INSERT INTO awcms_mini_tenant_provisioning_requests
          (tenant_id, plan_key, plan_version, target_key, status, readiness_state,
           inputs_hash, inputs, idempotency_key, total_steps, completed_steps,
           requested_at, canceled_at)
        VALUES (${tenantId}, 'plan', 1, 'target', ${status},
                ${extra.readinessState ?? "pending"},
                ${"a".repeat(64)}, '{}'::jsonb, ${code}, 3, 0, ${requestedAt},
                ${extra.canceled ? requestedAt : null})
      `
      );
    }

    function tenantUuid(suffix: number): string {
      return `2222${String(suffix).padStart(4, "0")}-2222-4222-8222-222222222222`;
    }

    async function signalsFor(tenantId: string) {
      return asWorker(tenantId, (tx) => collectProvisioningSignals(tx, NOW));
    }

    test("maps module statuses onto the metric's coarser label vocabulary", async () => {
      const cases = [
        ["requested", "pending"],
        ["in_progress", "running"],
        ["compensating", "running"],
        ["reconciling", "running"],
        ["blocked", "waiting"],
        ["failed", "failed"]
      ] as const;

      for (const [index, [status, expectedLabel]] of cases.entries()) {
        const tenantId = tenantUuid(index);
        await seedTenantWithRequest(tenantId, `prov${index}`, status, PAST);
        const signals = await signalsFor(tenantId);
        expect(
          `${status}:${JSON.stringify(signals.backlogByAttemptStatus)}`
        ).toBe(`${status}:${JSON.stringify({ [expectedLabel]: 1 })}`);
      }
    });

    test("blocked is the manual-intervention signal", async () => {
      const tenantId = tenantUuid(20);
      await seedTenantWithRequest(tenantId, "prov20", "blocked", PAST);
      const signals = await signalsFor(tenantId);
      expect(signals.manualInterventionCount).toBe(1);
    });

    test("terminal successes and cancellations are not backlog", async () => {
      const provisioned = tenantUuid(30);
      await seedTenantWithRequest(provisioned, "prov30", "provisioned", PAST, {
        readinessState: "ready"
      });
      const canceled = tenantUuid(31);
      await seedTenantWithRequest(canceled, "prov31", "canceled", PAST, {
        canceled: true
      });

      for (const tenantId of [provisioned, canceled]) {
        const signals = await signalsFor(tenantId);
        expect(signals.backlogByAttemptStatus).toEqual({});
        expect(signals.oldestPendingSeconds).toBeNull();
      }
    });

    test("a failed request does not pin the oldest-pending age forever", async () => {
      // `failed` is counted in the backlog (an operator must act) but must
      // NOT age: it is not waiting on anything, so including it would make
      // the age climb without bound after a single failure and permanently
      // hold the alert open.
      const tenantId = tenantUuid(40);
      await seedTenantWithRequest(
        tenantId,
        "prov40",
        "failed",
        new Date("2020-01-01T00:00:00.000Z")
      );

      const signals = await signalsFor(tenantId);
      expect(signals.backlogByAttemptStatus).toEqual({ failed: 1 });
      expect(signals.oldestPendingSeconds).toBeNull();
    });

    test("a waiting request DOES age", async () => {
      const tenantId = tenantUuid(41);
      await seedTenantWithRequest(
        tenantId,
        "prov41",
        "requested",
        new Date("2026-06-30T00:00:00.000Z")
      );
      const signals = await signalsFor(tenantId);
      expect(signals.oldestPendingSeconds).toBe(86_400);
    });

    test("no rows means no age at all, not zero", async () => {
      const signals = await asWorker(TENANT_ID, (tx) =>
        collectProvisioningSignals(tx, NOW)
      );
      // null and 0 mean different things: "nothing waiting" vs "something
      // waiting, but it just arrived".
      expect(signals.oldestPendingSeconds).toBeNull();
    });
  });

  describe("entitlement", () => {
    /**
     * A partial UNIQUE index allows only ONE live assignment per
     * (tenant, plan_key), so each fixture needs its own plan key — the
     * constraint models "a tenant holds one current entitlement per plan",
     * not "one entitlement overall".
     */
    async function seedAssignment(
      status: string,
      effectiveTo: Date | null,
      planKey: string
    ): Promise<void> {
      // `suspended_at` is required whenever status is `suspended` (table CHECK
      // constraint), so it is set unconditionally rather than conditionally —
      // it is ignored for every other status.
      await inTenant(
        (tx) => tx`
        INSERT INTO awcms_mini_tenant_entitlement_assignments
          (tenant_id, plan_key, offer_version, offer_hash, currency, source,
           status, effective_from, effective_to, suspended_at)
        VALUES (${TENANT_ID}, ${planKey}, 1, ${"b".repeat(64)}, 'IDR', 'manual',
                ${status}, ${EARLIER}, ${effectiveTo},
                ${status === "suspended" ? PAST : null})
      `
      );
    }

    test("counts only active assignments whose window has closed", async () => {
      await seedAssignment("active", PAST, "expired"); // counts
      await seedAssignment("active", FUTURE, "still_valid");
      await seedAssignment("active", null, "open_ended"); // never expires
      await seedAssignment("suspended", PAST, "suspended"); // not active

      const signals = await asWorker(TENANT_ID, (tx) =>
        collectEntitlementSignals(tx, NOW)
      );
      expect(signals.expiredUnswept).toBe(1);
    });

    test("an open-ended assignment is never counted as expired", async () => {
      // Guards the explicit NULL check: `NULL < now()` is NULL, not false, so
      // a naive negated predicate would drop these rows into neither branch.
      await seedAssignment("active", null, "open_ended");
      const signals = await asWorker(TENANT_ID, (tx) =>
        collectEntitlementSignals(tx, NOW)
      );
      expect(signals.expiredUnswept).toBe(0);
    });
  });

  describe("payment gateway", () => {
    test("counts dead outbox rows and unnormalized webhook envelopes", async () => {
      const account = (await inTenant(
        (tx) => tx`
        INSERT INTO awcms_mini_payment_gateway_provider_accounts
          (tenant_id, provider_key, provider_account_ref, display_name, status,
           endpoint_host, callback_host, signing_secret_ref)
        VALUES (${TENANT_ID}, 'fake', 'acct_signals', 'Signals', 'active',
                'api.example.com', 'cb.example.com', 'env:FAKE')
        RETURNING id
      `
      )) as { id: string }[];

      for (const status of ["dead", "dead", "pending", "succeeded"]) {
        await inTenant(
          (tx) => tx`
          INSERT INTO awcms_mini_payment_gateway_outbox
            (tenant_id, provider_account_id, kind, status, attempts,
             max_attempts, payload)
          VALUES (${TENANT_ID}, ${account[0]!.id}, 'query_status', ${status},
                  1, 5, '{}'::jsonb)
        `
        );
      }

      for (const [index, status] of [
        "received",
        "received",
        "normalized"
      ].entries()) {
        await inTenant(
          (tx) => tx`
          INSERT INTO awcms_mini_payment_gateway_webhook_inbox
            (tenant_id, provider_account_id, provider_event_id, provider_key,
             signature_valid, raw_body_sha256, raw_body_size, status)
          VALUES (${TENANT_ID}, ${account[0]!.id}, ${`evt_${index}`}, 'fake',
                  true, ${"c".repeat(64)}, 10, ${status})
        `
        );
      }

      const signals = await asWorker(TENANT_ID, (tx) =>
        collectPaymentGatewaySignals(tx)
      );
      expect(signals.deadLetterDepth).toBe(2);
      expect(signals.webhookBacklog).toBe(2);
      // The DLQ IS this subsystem's manual-intervention queue.
      expect(signals.manualInterventionCount).toBe(2);
    });
  });

  describe("subscription billing", () => {
    /** Invoices carry a NOT NULL `subscription_id`, so every invoice fixture needs one. */
    async function seedSubscription(): Promise<string> {
      const rows = (await inTenant(
        (tx) => tx`
        INSERT INTO awcms_mini_subscription_billing_subscriptions
          (tenant_id, offer_plan_key, offer_version, offer_hash, currency)
        VALUES (${TENANT_ID}, 'plan', 1, ${"d".repeat(64)}, 'IDR')
        RETURNING id
      `
      )) as { id: string }[];
      return rows[0]!.id;
    }

    async function seedInvoice(
      subscriptionId: string,
      status: string,
      dueAt: Date | null,
      number: string
    ): Promise<string> {
      const rows = (await inTenant(
        (tx) => tx`
        INSERT INTO awcms_mini_subscription_billing_invoices
          (tenant_id, subscription_id, offer_version, invoice_number, status,
           currency, rounding_mode, subtotal_minor, total_minor, credited_minor,
           allocated_minor, issued_at, due_at)
        VALUES (${TENANT_ID}, ${subscriptionId}, 1, ${number}, ${status}, 'IDR',
                'half_up', 1000, 1000, 0, 0, ${PAST}, ${dueAt})
        RETURNING id
      `
      )) as { id: string }[];
      return rows[0]!.id;
    }

    test("groups overdue invoices by their LATEST dunning stage", async () => {
      const subscription = await seedSubscription();
      const invoiceA = await seedInvoice(subscription, "issued", PAST, "INV-A");
      await seedInvoice(subscription, "issued", PAST, "INV-B"); // overdue, never dunned
      await seedInvoice(subscription, "issued", FUTURE, "INV-C"); // not due yet
      await seedInvoice(subscription, "paid", PAST, "INV-D"); // settled

      for (const [attemptNo, state] of [
        [1, "past_due"],
        [2, "grace"],
        [3, "suspended"]
      ] as const) {
        await inTenant(
          (tx) => tx`
          INSERT INTO awcms_mini_subscription_billing_dunning_attempts
            (tenant_id, invoice_id, subscription_id, attempt_no, scheduled_at,
             state, requested_lifecycle_state)
          VALUES (${TENANT_ID}, ${invoiceA}, ${subscription}, ${attemptNo},
                  ${PAST}, 'executed', ${state})
        `
        );
      }

      const signals = await asWorker(TENANT_ID, (tx) =>
        collectSubscriptionBillingSignals(tx, NOW)
      );

      // THE property this test exists for: invoice A had THREE dunning
      // attempts but must be counted exactly ONCE, under its latest stage.
      // A plain join would report suspended:1, grace:1, past_due:1 — a total
      // of 4 rather than 2, climbing as dunning retried harder.
      expect(signals.overdueByDunningStage).toEqual({
        suspended: 1,
        none: 1
      });
      expect(signals.overdueTotal).toBe(2);
    });

    test("an invoice with no due date is never overdue", async () => {
      await seedInvoice(await seedSubscription(), "issued", null, "INV-NODUE");
      const signals = await asWorker(TENANT_ID, (tx) =>
        collectSubscriptionBillingSignals(tx, NOW)
      );
      expect(signals.overdueTotal).toBe(0);
    });
  });
});
