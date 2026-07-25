/**
 * Integration tests for Issue #932 (epic #868): payment webhook evidence
 * retention.
 *
 * What these prove, on a real PostgreSQL database:
 *
 * 1. the evidence chain can now be purged at all (before migration 102 no role
 *    could delete a single row), and it is purged in FK-SAFE order;
 * 2. a row whose child is still inside the retention window SURVIVES — the
 *    chain ages out whole, never in fragments that would leave uninterpretable
 *    evidence;
 * 3. a legal hold on ANY link blocks the WHOLE chain, and a hold on the
 *    independent reconciliation log blocks only that;
 * 4. the request-path role `awcms_mini_app` STILL cannot delete these rows —
 *    the boundary moved from "impossible for everyone" to "grants", and this
 *    asserts the grant half really holds;
 * 5. the UPDATE protections migration 102 narrowed are UNCHANGED — every table
 *    still rejects in-place edits, and the webhook inbox still permits exactly
 *    its one `received -> normalized` forward advance.
 *
 * (5) is the regression this change most needs: the whole point of narrowing
 * those triggers was to touch DELETE and nothing else, and a mistake there
 * would silently unfreeze payment evidence.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 *
 * NOTE: never use `.rejects.toThrow()` against a real Bun.SQL promise in this
 * repo — it spins the process at 100% CPU forever. Rejections are asserted
 * with manual try/catch.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  getTestSql,
  getWorkerTestSql,
  integrationEnabled,
  provisionAppRole,
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { withTenant } from "../../src/lib/database/tenant-context";
import { legalHoldGuardPortAdapter } from "../../src/modules/data-lifecycle/application/legal-hold-guard-port-adapter";
import { purgeExpiredPaymentEvidence } from "../../src/modules/payment-gateway/application/retention-purge";
import {
  PAYMENT_GATEWAY_NORMALIZED_EVENTS_LIFECYCLE_KEY,
  PAYMENT_GATEWAY_PROCESSING_ATTEMPTS_LIFECYCLE_KEY,
  PAYMENT_GATEWAY_RECONCILIATIONS_LIFECYCLE_KEY,
  PAYMENT_GATEWAY_WEBHOOK_INBOX_LIFECYCLE_KEY
} from "../../src/modules/payment-gateway/domain/lifecycle-keys";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

/** A never-held descriptor key, so the guard's "no hold" path is exercised too. */
const NOW = new Date("2026-07-01T00:00:00.000Z");
const OLD = new Date("2020-01-01T00:00:00.000Z"); // far outside any retention window
const RECENT = new Date("2026-06-30T00:00:00.000Z"); // inside the window

async function seedTenant(): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${TENANT_ID}, 'retention', 'Retention', 'Retention', 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedProviderAccount(): Promise<string> {
  const rows = (await withTenant(
    getAdminSql(),
    TENANT_ID,
    (tx) => tx`
    INSERT INTO awcms_mini_payment_gateway_provider_accounts
      (tenant_id, provider_key, provider_account_ref, display_name, status,
       endpoint_host, callback_host, signing_secret_ref)
    VALUES (${TENANT_ID}, 'fake', 'acct_retention_9999', 'Retention', 'active',
            'api.example.com', 'cb.example.com', 'env:FAKE_SECRET')
    RETURNING id
  `
  )) as { id: string }[];
  return rows[0]!.id;
}

/**
 * Seeds ONE complete evidence chain (inbox -> normalized -> attempt) with
 * explicit timestamps per level, so a test can age the levels independently
 * and exercise the surviving-child guard.
 */
async function seedChain(
  providerAccountId: string,
  eventId: string,
  timestamps: { inbox: Date; normalized: Date; attempt: Date | null }
): Promise<{ inboxId: string; normalizedId: string }> {
  return withTenant(getAdminSql(), TENANT_ID, async (tx) => {
    const inbox = (await tx`
      INSERT INTO awcms_mini_payment_gateway_webhook_inbox
        (tenant_id, provider_account_id, provider_event_id, provider_key,
         signature_valid, raw_body_sha256, raw_body_size, status, received_at, created_at)
      VALUES (${TENANT_ID}, ${providerAccountId}, ${eventId}, 'fake',
              true, ${"a".repeat(64)}, 128, 'received',
              ${timestamps.inbox}, ${timestamps.inbox})
      RETURNING id
    `) as { id: string }[];

    const normalized = (await tx`
      INSERT INTO awcms_mini_payment_gateway_normalized_events
        (tenant_id, webhook_inbox_id, provider_key, normalized_status, provider_sequence, created_at)
      VALUES (${TENANT_ID}, ${inbox[0]!.id}, 'fake', 'settled', 1, ${timestamps.normalized})
      RETURNING id
    `) as { id: string }[];

    if (timestamps.attempt) {
      await tx`
        INSERT INTO awcms_mini_payment_gateway_processing_attempts
          (tenant_id, normalized_event_id, outcome, created_at)
        VALUES (${TENANT_ID}, ${normalized[0]!.id}, 'ignored_unknown_intent', ${timestamps.attempt})
      `;
    }

    return { inboxId: inbox[0]!.id, normalizedId: normalized[0]!.id };
  });
}

/**
 * A payment intent, which `reconciliations.intent_id` requires (NOT NULL FK).
 * `invoice_id` carries no FK of its own, so a bare UUID is enough here — this
 * purge never touches intents or invoices, they only anchor the row.
 */
async function seedIntent(providerAccountId: string): Promise<string> {
  const rows = (await withTenant(
    getAdminSql(),
    TENANT_ID,
    (tx) => tx`
    INSERT INTO awcms_mini_payment_gateway_payment_intents
      (tenant_id, provider_account_id, provider_key, invoice_id, currency,
       amount_minor, status)
    VALUES (${TENANT_ID}, ${providerAccountId}, 'fake', ${crypto.randomUUID()},
            'IDR', 10000, 'settled')
    RETURNING id
  `
  )) as { id: string }[];
  return rows[0]!.id;
}

async function countRows(table: string): Promise<number> {
  const rows = (await withTenant(getAdminSql(), TENANT_ID, (tx) =>
    tx.unsafe(
      `SELECT count(*)::int AS count FROM ${table} WHERE tenant_id = $1`,
      [TENANT_ID]
    )
  )) as { count: number }[];
  return rows[0]?.count ?? 0;
}

/** `requested_by`/`approved_by` are NOT NULL-and-unreferenced actor columns, so a bare UUID stands in for the operator who filed the hold. */
const HOLD_ACTOR = "22222222-2222-4222-8222-222222222222";

async function placeLegalHold(descriptorKey: string): Promise<void> {
  await withTenant(
    getAdminSql(),
    TENANT_ID,
    (tx) => tx`
    INSERT INTO awcms_mini_data_lifecycle_legal_holds
      (tenant_id, descriptor_key, scope_description, reason, authority_reference,
       authority_metadata, status, requested_by, approved_by, approved_at)
    VALUES (${TENANT_ID}, ${descriptorKey}, 'integration test hold',
            'issue-932 integration test', 'TEST-932', '{}'::jsonb, 'active',
            ${HOLD_ACTOR}, ${HOLD_ACTOR}, now())
  `
  );
}

const suite = integrationEnabled ? describe : describe.skip;

suite("payment-gateway retention purge (Issue #932)", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
  });

  describe("the evidence chain can be purged, FK-safely", () => {
    test("a fully aged-out chain is deleted in child-to-parent order", async () => {
      const account = await seedProviderAccount();
      await seedChain(account, "evt_old_1", {
        inbox: OLD,
        normalized: OLD,
        attempt: OLD
      });

      const result = await purgeExpiredPaymentEvidence(
        getWorkerTestSql(),
        TENANT_ID,
        legalHoldGuardPortAdapter,
        { now: NOW }
      );

      expect(result.legalHoldBlocked).toBe(false);
      expect(result.purgedProcessingAttempts).toBe(1);
      expect(result.purgedNormalizedEvents).toBe(1);
      expect(result.purgedWebhookInbox).toBe(1);

      expect(
        await countRows("awcms_mini_payment_gateway_processing_attempts")
      ).toBe(0);
      expect(
        await countRows("awcms_mini_payment_gateway_normalized_events")
      ).toBe(0);
      expect(await countRows("awcms_mini_payment_gateway_webhook_inbox")).toBe(
        0
      );
    });

    test("a parent whose child is still inside the window SURVIVES (no fragmented evidence)", async () => {
      const account = await seedProviderAccount();
      // Inbox + normalized are ancient; the attempt is recent — which is the
      // realistic shape, since a chain's rows are written in that order.
      await seedChain(account, "evt_partial_1", {
        inbox: OLD,
        normalized: OLD,
        attempt: RECENT
      });

      const result = await purgeExpiredPaymentEvidence(
        getWorkerTestSql(),
        TENANT_ID,
        legalHoldGuardPortAdapter,
        { now: NOW }
      );

      expect(result.purgedProcessingAttempts).toBe(0);
      expect(result.purgedNormalizedEvents).toBe(0);
      expect(result.purgedWebhookInbox).toBe(0);

      // All three still readable: the surviving attempt keeps its provenance.
      expect(
        await countRows("awcms_mini_payment_gateway_processing_attempts")
      ).toBe(1);
      expect(
        await countRows("awcms_mini_payment_gateway_normalized_events")
      ).toBe(1);
      expect(await countRows("awcms_mini_payment_gateway_webhook_inbox")).toBe(
        1
      );
    });

    test("a chain with no attempt at all still ages out completely", async () => {
      const account = await seedProviderAccount();
      await seedChain(account, "evt_no_attempt", {
        inbox: OLD,
        normalized: OLD,
        attempt: null
      });

      const result = await purgeExpiredPaymentEvidence(
        getWorkerTestSql(),
        TENANT_ID,
        legalHoldGuardPortAdapter,
        { now: NOW }
      );

      expect(result.purgedNormalizedEvents).toBe(1);
      expect(result.purgedWebhookInbox).toBe(1);
      expect(await countRows("awcms_mini_payment_gateway_webhook_inbox")).toBe(
        0
      );
    });

    test("the batch limit bounds a single pass, and re-running drains the rest", async () => {
      const account = await seedProviderAccount();
      for (let i = 0; i < 3; i += 1) {
        await seedChain(account, `evt_batch_${i}`, {
          inbox: new Date(OLD.getTime() + i * 1000),
          normalized: new Date(OLD.getTime() + i * 1000),
          attempt: new Date(OLD.getTime() + i * 1000)
        });
      }

      const first = await purgeExpiredPaymentEvidence(
        getWorkerTestSql(),
        TENANT_ID,
        legalHoldGuardPortAdapter,
        { now: NOW, batchLimit: 2 }
      );
      expect(first.purgedProcessingAttempts).toBe(2);

      const second = await purgeExpiredPaymentEvidence(
        getWorkerTestSql(),
        TENANT_ID,
        legalHoldGuardPortAdapter,
        { now: NOW, batchLimit: 2 }
      );
      expect(second.purgedProcessingAttempts).toBe(1);

      expect(
        await countRows("awcms_mini_payment_gateway_processing_attempts")
      ).toBe(0);
      expect(await countRows("awcms_mini_payment_gateway_webhook_inbox")).toBe(
        0
      );
    });

    test("a non-empty run writes exactly one audit row", async () => {
      const account = await seedProviderAccount();
      await seedChain(account, "evt_audit_1", {
        inbox: OLD,
        normalized: OLD,
        attempt: OLD
      });

      await purgeExpiredPaymentEvidence(
        getWorkerTestSql(),
        TENANT_ID,
        legalHoldGuardPortAdapter,
        { now: NOW }
      );

      const audits = (await withTenant(
        getAdminSql(),
        TENANT_ID,
        (tx) => tx`
        SELECT action, resource_type FROM awcms_mini_audit_events
        WHERE tenant_id = ${TENANT_ID} AND module_key = 'payment_gateway'
          AND resource_type = 'payment_webhook_evidence'
      `
      )) as { action: string; resource_type: string }[];

      expect(audits).toHaveLength(1);
      expect(audits[0]!.action).toBe("purge");
    });
  });

  describe("legal holds", () => {
    test("a hold on ANY link blocks the WHOLE chain", async () => {
      const account = await seedProviderAccount();
      await seedChain(account, "evt_held_1", {
        inbox: OLD,
        normalized: OLD,
        attempt: OLD
      });

      // Held on the LEAF — the link that would otherwise be purged first and
      // is furthest from the inbox, so this proves the grouping, not an
      // accident of ordering.
      await placeLegalHold(PAYMENT_GATEWAY_PROCESSING_ATTEMPTS_LIFECYCLE_KEY);

      const result = await purgeExpiredPaymentEvidence(
        getWorkerTestSql(),
        TENANT_ID,
        legalHoldGuardPortAdapter,
        { now: NOW }
      );

      expect(result.legalHoldBlocked).toBe(true);
      expect(result.purgedProcessingAttempts).toBe(0);
      expect(result.purgedNormalizedEvents).toBe(0);
      expect(result.purgedWebhookInbox).toBe(0);
      expect(await countRows("awcms_mini_payment_gateway_webhook_inbox")).toBe(
        1
      );
    });

    test("a hold on the inbox link also blocks the leaf", async () => {
      const account = await seedProviderAccount();
      await seedChain(account, "evt_held_2", {
        inbox: OLD,
        normalized: OLD,
        attempt: OLD
      });
      await placeLegalHold(PAYMENT_GATEWAY_WEBHOOK_INBOX_LIFECYCLE_KEY);

      const result = await purgeExpiredPaymentEvidence(
        getWorkerTestSql(),
        TENANT_ID,
        legalHoldGuardPortAdapter,
        { now: NOW }
      );

      expect(result.legalHoldBlocked).toBe(true);
      expect(
        await countRows("awcms_mini_payment_gateway_processing_attempts")
      ).toBe(1);
    });

    test("releasing the hold lets the next run proceed", async () => {
      const account = await seedProviderAccount();
      await seedChain(account, "evt_released_1", {
        inbox: OLD,
        normalized: OLD,
        attempt: OLD
      });
      await placeLegalHold(PAYMENT_GATEWAY_NORMALIZED_EVENTS_LIFECYCLE_KEY);

      const blocked = await purgeExpiredPaymentEvidence(
        getWorkerTestSql(),
        TENANT_ID,
        legalHoldGuardPortAdapter,
        { now: NOW }
      );
      expect(blocked.legalHoldBlocked).toBe(true);

      await withTenant(
        getAdminSql(),
        TENANT_ID,
        (tx) => tx`
        UPDATE awcms_mini_data_lifecycle_legal_holds
        SET status = 'released', released_at = now(), released_by = ${HOLD_ACTOR},
            release_reason = 'test'
        WHERE tenant_id = ${TENANT_ID}
      `
      );

      const allowed = await purgeExpiredPaymentEvidence(
        getWorkerTestSql(),
        TENANT_ID,
        legalHoldGuardPortAdapter,
        { now: NOW }
      );
      expect(allowed.legalHoldBlocked).toBe(false);
      expect(allowed.purgedWebhookInbox).toBe(1);
    });

    test("a hold on the reconciliation log does NOT block the evidence chain, and vice versa", async () => {
      const account = await seedProviderAccount();
      await seedChain(account, "evt_indep_1", {
        inbox: OLD,
        normalized: OLD,
        attempt: OLD
      });
      const intentId = await seedIntent(account);
      await withTenant(
        getAdminSql(),
        TENANT_ID,
        (tx) => tx`
        INSERT INTO awcms_mini_payment_gateway_reconciliations
          (tenant_id, intent_id, provider_status, local_status, outcome,
           reconciled_at, created_at)
        VALUES (${TENANT_ID}, ${intentId}, 'succeeded', 'pending',
                'mismatch_flagged', ${OLD}, ${OLD})
      `
      );

      await placeLegalHold(PAYMENT_GATEWAY_RECONCILIATIONS_LIFECYCLE_KEY);

      const result = await purgeExpiredPaymentEvidence(
        getWorkerTestSql(),
        TENANT_ID,
        legalHoldGuardPortAdapter,
        { now: NOW }
      );

      // Reconciliations held; the chain is untouched by that hold.
      expect(result.reconciliationLegalHoldBlocked).toBe(true);
      expect(result.legalHoldBlocked).toBe(false);
      expect(result.purgedReconciliations).toBe(0);
      expect(result.purgedWebhookInbox).toBe(1);
      expect(
        await countRows("awcms_mini_payment_gateway_reconciliations")
      ).toBe(1);
    });
  });

  describe("the DELETE boundary is grants, and the UPDATE boundary is unchanged", () => {
    test("the request-path role awcms_mini_app still cannot delete evidence", async () => {
      const account = await seedProviderAccount();
      await seedChain(account, "evt_app_role_1", {
        inbox: OLD,
        normalized: OLD,
        attempt: OLD
      });

      // The app role is what every HTTP request runs as. Migration 102 moved
      // the delete boundary from a trigger to grants — this asserts the grant
      // half actually holds, which is the whole safety argument.
      //
      // The SQLSTATE matters, and a bare "it threw" assertion is NOT enough
      // here: a seeded chain means an unprivileged-looking DELETE on a parent
      // also fails with 23503 (foreign_key_violation) because a child still
      // references it. That passes while proving nothing about grants — a
      // mutation run that wrongly `GRANT DELETE ... TO awcms_mini_app` stayed
      // green under the weaker assertion. Postgres checks table privileges
      // before any row constraint, so 42501 (insufficient_privilege) is the
      // signal that discriminates, and only it.
      for (const table of [
        "awcms_mini_payment_gateway_webhook_inbox",
        "awcms_mini_payment_gateway_normalized_events",
        "awcms_mini_payment_gateway_processing_attempts",
        "awcms_mini_payment_gateway_reconciliations"
      ]) {
        let sqlstate: string | undefined;
        try {
          await withTenant(getTestSql(), TENANT_ID, (tx) =>
            tx.unsafe(`DELETE FROM ${table} WHERE tenant_id = $1`, [TENANT_ID])
          );
        } catch (error) {
          sqlstate = (error as { errno?: string }).errno;
        }
        expect(`${table}:${sqlstate}`).toBe(`${table}:42501`);
      }

      // And nothing was removed by the attempt.
      expect(await countRows("awcms_mini_payment_gateway_webhook_inbox")).toBe(
        1
      );
      expect(
        await countRows("awcms_mini_payment_gateway_processing_attempts")
      ).toBe(1);
    });

    test("every table still rejects an in-place UPDATE", async () => {
      const account = await seedProviderAccount();
      const { normalizedId } = await seedChain(account, "evt_update_1", {
        inbox: OLD,
        normalized: OLD,
        attempt: OLD
      });

      // Attempted as the ADMIN (table owner) role: this must fail on the
      // TRIGGER, not on a grant — narrowing the trigger to BEFORE UPDATE must
      // not have weakened what it rejects.
      let normalizedRejected = false;
      try {
        await withTenant(
          getAdminSql(),
          TENANT_ID,
          (tx) => tx`
          UPDATE awcms_mini_payment_gateway_normalized_events
          SET normalized_status = 'failed' WHERE id = ${normalizedId}
        `
        );
      } catch {
        normalizedRejected = true;
      }
      expect(normalizedRejected).toBe(true);

      let attemptsRejected = false;
      try {
        await withTenant(
          getAdminSql(),
          TENANT_ID,
          (tx) => tx`
          UPDATE awcms_mini_payment_gateway_processing_attempts
          SET outcome = 'applied' WHERE tenant_id = ${TENANT_ID}
        `
        );
      } catch {
        attemptsRejected = true;
      }
      expect(attemptsRejected).toBe(true);
    });

    test("the webhook inbox still rejects a forbidden edit but still permits its one forward advance", async () => {
      const account = await seedProviderAccount();
      const { inboxId, normalizedId } = await seedChain(
        account,
        "evt_forward_1",
        { inbox: OLD, normalized: OLD, attempt: OLD }
      );

      // Forbidden: any other column change.
      let tamperRejected = false;
      try {
        await withTenant(
          getAdminSql(),
          TENANT_ID,
          (tx) => tx`
          UPDATE awcms_mini_payment_gateway_webhook_inbox
          SET signature_valid = false WHERE id = ${inboxId}
        `
        );
      } catch {
        tamperRejected = true;
      }
      expect(tamperRejected).toBe(true);

      // Permitted: the single received -> normalized advance the module needs.
      await withTenant(
        getAdminSql(),
        TENANT_ID,
        (tx) => tx`
        UPDATE awcms_mini_payment_gateway_webhook_inbox
        SET status = 'normalized', normalized_event_id = ${normalizedId}
        WHERE id = ${inboxId}
      `
      );

      const rows = (await withTenant(
        getAdminSql(),
        TENANT_ID,
        (tx) => tx`
        SELECT status FROM awcms_mini_payment_gateway_webhook_inbox
        WHERE id = ${inboxId}
      `
      )) as { status: string }[];
      expect(rows[0]!.status).toBe("normalized");
    });
  });
});
