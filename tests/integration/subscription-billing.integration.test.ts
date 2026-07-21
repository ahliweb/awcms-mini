/**
 * Integration tests for `subscription_billing` against real PostgreSQL (Issue
 * #876, epic #868, ADR-0022). Covers, per AC:
 *   - a subscription binds to an IMMUTABLE published offer version;
 *   - invoice generation is IDEMPOTENT per (subscription, period) even under
 *     CONCURRENT workers (at most one invoice per period);
 *   - an ISSUED invoice is immutable (DB trigger rejects amount edit + delete);
 *   - correction uses credit-note/void (over-credit rejected);
 *   - usage-based lines reconcile to a usage aggregate and record their source;
 *   - issue writes the invoice + status history + versioned event SAME-COMMIT;
 *   - tenant-scoped RLS cross-tenant isolation (tenant A never sees B);
 *   - dunning REQUESTS a lifecycle transition FAIL-CLOSED (a throwing port ->
 *     `refused`, never assumed applied; no port -> `not_available`);
 *   - the per-tenant job lease is exclusive and expiry-reclaimable.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  getTestSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { withTenant } from "../../src/lib/database/tenant-context";
import { listModules } from "../../src/modules";
import { resolveServiceCatalogKeyRegistry } from "../../src/modules/service-catalog/domain/key-registry";
import {
  approveOfferVersion,
  createPlan,
  publishVersion
} from "../../src/modules/service-catalog/application/plan-directory";
import type { VersionContentInput } from "../../src/modules/service-catalog/domain/plan";
import { createServiceCatalogReadPort } from "../../src/modules/service-catalog/application/service-catalog-read-port-adapter";
import type { UsageAggregatePort } from "../../src/modules/_shared/ports/usage-aggregate-port";
import type {
  LifecycleTransitionPort,
  LifecycleTransitionResult
} from "../../src/modules/_shared/ports/tenant-lifecycle-port";
import { createSubscriptionForOffer } from "../../src/modules/subscription-billing/application/subscription-engine";
import {
  approveCredit,
  creditInvoice,
  generateInvoiceDraft,
  issueInvoice,
  voidInvoice,
  type InvoiceEngineDeps
} from "../../src/modules/subscription-billing/application/invoice-engine";
import { runDunningAttempt } from "../../src/modules/subscription-billing/application/dunning-engine";
import {
  getInvoice,
  listInvoiceLines
} from "../../src/modules/subscription-billing/application/billing-directory";
import {
  claimLease,
  releaseLease
} from "../../src/modules/subscription-billing/application/billing-lease";

const OWNER_PASSWORD = "integration-test-billing-owner-password";
const scRegistry = resolveServiceCatalogKeyRegistry(listModules());
const CATALOG_ACTOR = "00000000-0000-0000-0000-0000000000ab";

function offerContent(withUsage: boolean): VersionContentInput {
  const prices: VersionContentInput["prices"] = [
    {
      componentKey: "base",
      amountMinor: 9900000,
      currency: "IDR",
      interval: "monthly",
      visibility: "public",
      metadata: {}
    }
  ];
  if (withUsage) {
    prices.push({
      componentKey: "overage",
      amountMinor: 100,
      currency: "IDR",
      interval: "monthly",
      visibility: "public",
      metadata: { meterKey: "platform.api_calls" }
    });
  }
  return {
    currency: "IDR",
    market: null,
    trialEnabled: false,
    trialDays: null,
    availableFrom: null,
    availableTo: null,
    notes: null,
    features: [
      {
        featureKind: "feature",
        featureKey: "platform.api_access",
        enabled: true,
        metadata: {}
      }
    ],
    quotas: [
      {
        meterKey: "platform.api_calls",
        isUnlimited: false,
        limitValue: 1000,
        unit: "requests",
        resetPolicy: "monthly",
        metadata: {}
      }
    ],
    prices
  };
}

async function seedOffer(
  sql: Bun.SQL,
  tenantId: string,
  planKey: string,
  withUsage = false
): Promise<void> {
  await withTenant(sql, tenantId, async (tx) => {
    const created = await createPlan(
      tx,
      tenantId,
      CATALOG_ACTOR,
      {
        planKey,
        name: planKey,
        description: null,
        planType: "subscription",
        content: offerContent(withUsage)
      },
      scRegistry
    );
    if (!created.ok)
      throw new Error("seedOffer createPlan: " + JSON.stringify(created));
    // Issue #879 — publish requires a prior commercial approval by a DISTINCT actor.
    await approveOfferVersion(tx, tenantId, crypto.randomUUID(), planKey, 1);
    const pub = await publishVersion(
      tx,
      tenantId,
      CATALOG_ACTOR,
      planKey,
      1,
      scRegistry
    );
    if (!pub.ok)
      throw new Error("seedOffer publishVersion: " + JSON.stringify(pub));
  });
}

type Owner = { tenantId: string; tenantUserId: string };
let codeSeq = 0;
async function bootstrapOwner(): Promise<Owner> {
  codeSeq += 1;
  const loginIdentifier = `billing-owner-${codeSeq}@example.com`;
  const code = `bill${codeSeq}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme",
      tenantCode: code,
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: loginIdentifier,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  expect(setup.status).toBe(200);
  await invoke(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": setup.body.data.tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT tu.id FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${setup.body.data.tenantId}
      AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];
  return { tenantId: setup.body.data.tenantId, tenantUserId: rows[0]!.id };
}

function invoiceDeps(
  tx: Bun.SQL,
  usage?: UsageAggregatePort
): InvoiceEngineDeps {
  return { catalog: createServiceCatalogReadPort(tx), usage };
}

/** A stub usage aggregate port returning a fixed monthly window total. */
function stubUsage(value: number): UsageAggregatePort {
  return {
    async getWindowTotal(meterKey, windowType) {
      return {
        meterKey,
        windowType,
        windowStart: "2026-01-01T00:00:00.000Z",
        windowEnd: "2026-02-01T00:00:00.000Z",
        value,
        eventCount: value,
        correctionCount: 0,
        distinctCount: null,
        lastEventTime: null,
        freshness: "current",
        computedAt: "2026-01-15T00:00:00.000Z",
        contentHash: "hash-" + value,
        windowClosed: false
      };
    },
    async getQuotaDecision(meterKey) {
      return {
        meterKey,
        allowed: true,
        isUnlimited: false,
        limit: 1000,
        used: value,
        remaining: 1000 - value,
        unit: "requests",
        enforcement: "hard",
        status: "within",
        freshness: "current"
      };
    }
  };
}

async function makeSubscription(
  sql: Bun.SQL,
  owner: Owner,
  planKey: string
): Promise<string> {
  return withTenant(sql, owner.tenantId, async (tx) => {
    const result = await createSubscriptionForOffer(
      tx,
      owner.tenantId,
      {
        offerPlanKey: planKey,
        offerVersion: 1,
        billingInterval: "month",
        billingAnchorDay: null,
        prorationPolicy: "daily",
        roundingMode: "half_up",
        collectionMode: "manual",
        trialEndsAt: null,
        billingContactRef: null,
        reason: "go live",
        source: "operator"
      },
      { catalog: createServiceCatalogReadPort(tx) },
      { actorTenantUserId: owner.tenantUserId }
    );
    if (!result.ok)
      throw new Error("makeSubscription: " + JSON.stringify(result));
    return result.subscription.id;
  });
}

const suite = integrationEnabled ? describe : describe.skip;

suite("subscription_billing — engine + integrity", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  test("subscription binds to an immutable published offer; generate is idempotent per period", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await seedOffer(sql, owner.tenantId, "growth");
    const subId = await makeSubscription(sql, owner, "growth");

    const first = await withTenant(sql, owner.tenantId, (tx) =>
      generateInvoiceDraft(
        tx,
        owner.tenantId,
        subId,
        { includeUsage: false, dueInDays: null, reason: "first" },
        invoiceDeps(tx),
        { actorTenantUserId: owner.tenantUserId }
      )
    );
    expect(first.ok && first.created).toBe(true);

    // Second generation for the same period is an idempotent no-op.
    const second = await withTenant(sql, owner.tenantId, (tx) =>
      generateInvoiceDraft(
        tx,
        owner.tenantId,
        subId,
        { includeUsage: false, dueInDays: null, reason: "second" },
        invoiceDeps(tx),
        { actorTenantUserId: owner.tenantUserId }
      )
    );
    expect(second.ok && !second.created).toBe(true);
    if (first.ok && second.ok) {
      expect(second.invoice.id).toBe(first.invoice.id);
    }

    // Only one invoice exists for the subscription.
    const admin = getAdminSql();
    const count = (await admin`
      SELECT count(*)::int AS n
      FROM awcms_mini_subscription_billing_invoices
      WHERE subscription_id = ${subId} AND status <> 'void'
    `) as { n: number }[];
    expect(count[0]!.n).toBe(1);
  });

  test("CONCURRENT generation creates AT MOST ONE invoice per period", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await seedOffer(sql, owner.tenantId, "growth");
    const subId = await makeSubscription(sql, owner, "growth");

    // Two independent transactions racing to generate the same period's invoice.
    const run = () =>
      withTenant(sql, owner.tenantId, (tx) =>
        generateInvoiceDraft(
          tx,
          owner.tenantId,
          subId,
          { includeUsage: false, dueInDays: null, reason: "race" },
          invoiceDeps(tx),
          { actorTenantUserId: owner.tenantUserId }
        )
      );
    const results = await Promise.all([run(), run(), run()]);
    const created = results.filter((r) => r.ok && r.created).length;
    expect(created).toBeLessThanOrEqual(1);

    const admin = getAdminSql();
    const count = (await admin`
      SELECT count(*)::int AS n FROM awcms_mini_subscription_billing_invoices
      WHERE subscription_id = ${subId} AND status <> 'void'
    `) as { n: number }[];
    expect(count[0]!.n).toBe(1);
  });

  test("an ISSUED invoice is immutable (DB trigger rejects amount edit + delete)", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await seedOffer(sql, owner.tenantId, "growth");
    const subId = await makeSubscription(sql, owner, "growth");

    const invoiceId = await withTenant(sql, owner.tenantId, async (tx) => {
      const gen = await generateInvoiceDraft(
        tx,
        owner.tenantId,
        subId,
        { includeUsage: false, dueInDays: null, reason: "gen" },
        invoiceDeps(tx),
        { actorTenantUserId: owner.tenantUserId }
      );
      if (!gen.ok) throw new Error("gen failed");
      const issued = await issueInvoice(
        tx,
        owner.tenantId,
        gen.invoice.id,
        {
          invoiceNumber: "INV-1",
          dueAt: null,
          reason: "issue",
          expectedVersion: null
        },
        { actorTenantUserId: owner.tenantUserId }
      );
      expect(issued.ok).toBe(true);
      return gen.invoice.id;
    });

    const admin = getAdminSql();
    // Editing an issued invoice's total is rejected by the immutability trigger.
    let editRejected = false;
    try {
      await admin`
        UPDATE awcms_mini_subscription_billing_invoices
        SET total_minor = 1 WHERE id = ${invoiceId}
      `;
    } catch {
      editRejected = true;
    }
    expect(editRejected).toBe(true);

    // Hard delete is rejected.
    let deleteRejected = false;
    try {
      await admin`
        DELETE FROM awcms_mini_subscription_billing_invoices WHERE id = ${invoiceId}
      `;
    } catch {
      deleteRejected = true;
    }
    expect(deleteRejected).toBe(true);
  });

  test("an invoice line cannot be re-parented OUT of an ISSUED invoice (money integrity, no-reparent trigger)", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    // Two distinct plans -> two distinct live subscriptions (one live per plan).
    await seedOffer(sql, owner.tenantId, "growth");
    await seedOffer(sql, owner.tenantId, "starter");
    const subA = await makeSubscription(sql, owner, "growth");
    const subB = await makeSubscription(sql, owner, "starter");

    // Issue invoice A (its line-set is FROZEN); keep invoice B as a live draft —
    // a draft is the ONLY thing a naive reparent could target.
    const { issuedInvoiceId, draftInvoiceId } = await withTenant(
      sql,
      owner.tenantId,
      async (tx) => {
        const genA = await generateInvoiceDraft(
          tx,
          owner.tenantId,
          subA,
          { includeUsage: false, dueInDays: null, reason: "A" },
          invoiceDeps(tx),
          { actorTenantUserId: owner.tenantUserId }
        );
        if (!genA.ok) throw new Error("genA failed");
        const issued = await issueInvoice(
          tx,
          owner.tenantId,
          genA.invoice.id,
          {
            invoiceNumber: "INV-A",
            dueAt: null,
            reason: "issue",
            expectedVersion: null
          },
          { actorTenantUserId: owner.tenantUserId }
        );
        if (!issued.ok) throw new Error("issue A failed");
        const genB = await generateInvoiceDraft(
          tx,
          owner.tenantId,
          subB,
          { includeUsage: false, dueInDays: null, reason: "B" },
          invoiceDeps(tx),
          { actorTenantUserId: owner.tenantUserId }
        );
        if (!genB.ok) throw new Error("genB failed");
        return {
          issuedInvoiceId: genA.invoice.id,
          draftInvoiceId: genB.invoice.id
        };
      }
    );

    const admin = getAdminSql();
    const lineRows = (await admin`
      SELECT id FROM awcms_mini_subscription_billing_invoice_lines
      WHERE invoice_id = ${issuedInvoiceId} ORDER BY line_no ASC LIMIT 1
    `) as { id: string }[];
    const lineId = lineRows[0]!.id;

    // Re-parenting a line OUT of the frozen invoice into a draft is rejected
    // (OLD parent is ISSUED) — the frozen invoice's line-set can never shrink.
    let reparentRejected = false;
    try {
      await admin`
        UPDATE awcms_mini_subscription_billing_invoice_lines
        SET invoice_id = ${draftInvoiceId} WHERE id = ${lineId}
      `;
    } catch {
      reparentRejected = true;
    }
    expect(reparentRejected).toBe(true);

    // Editing the amount of a frozen invoice's line is likewise rejected.
    let amountEditRejected = false;
    try {
      await admin`
        UPDATE awcms_mini_subscription_billing_invoice_lines
        SET amount_minor = 1 WHERE id = ${lineId}
      `;
    } catch {
      amountEditRejected = true;
    }
    expect(amountEditRejected).toBe(true);

    // The line is STILL attached to the ISSUED invoice (nothing moved).
    const still = (await admin`
      SELECT invoice_id FROM awcms_mini_subscription_billing_invoice_lines
      WHERE id = ${lineId}
    `) as { invoice_id: string }[];
    expect(still[0]!.invoice_id).toBe(issuedInvoiceId);
  });

  test("invoice generation REFUSES deterministically when the subscription has no period anchor", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await seedOffer(sql, owner.tenantId, "growth");
    const subId = await makeSubscription(sql, owner, "growth");

    // Clear the period anchors (not guarded by the immutability trigger). Without
    // an anchor, generation must REFUSE cleanly rather than fabricate a period
    // from the wall clock (which two racing generations would do differently).
    const admin = getAdminSql();
    await admin`
      UPDATE awcms_mini_subscription_billing_subscriptions
      SET current_period_start = NULL, current_period_end = NULL
      WHERE id = ${subId}
    `;

    const result = await withTenant(sql, owner.tenantId, (tx) =>
      generateInvoiceDraft(
        tx,
        owner.tenantId,
        subId,
        { includeUsage: false, dueInDays: null, reason: "no anchor" },
        invoiceDeps(tx),
        { actorTenantUserId: owner.tenantUserId }
      )
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_period_anchor");

    // No invoice (and no wall-clock period) was created.
    const count = (await admin`
      SELECT count(*)::int AS n
      FROM awcms_mini_subscription_billing_invoices WHERE subscription_id = ${subId}
    `) as { n: number }[];
    expect(count[0]!.n).toBe(0);
  });

  test("correction uses credit-note (over-credit rejected) and void", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await seedOffer(sql, owner.tenantId, "growth");
    const subId = await makeSubscription(sql, owner, "growth");

    const invoiceId = await withTenant(sql, owner.tenantId, async (tx) => {
      const gen = await generateInvoiceDraft(
        tx,
        owner.tenantId,
        subId,
        { includeUsage: false, dueInDays: null, reason: "gen" },
        invoiceDeps(tx),
        { actorTenantUserId: owner.tenantUserId }
      );
      if (!gen.ok) throw new Error("gen failed");
      await issueInvoice(
        tx,
        owner.tenantId,
        gen.invoice.id,
        {
          invoiceNumber: null,
          dueAt: null,
          reason: "issue",
          expectedVersion: null
        },
        { actorTenantUserId: owner.tenantUserId }
      );
      return gen.invoice.id;
    });

    // Issue #879 (maker/checker): a credit note is created PENDING and does NOT
    // reduce the balance until a DIFFERENT actor approves it.
    const creditNoteId = await withTenant(sql, owner.tenantId, async (tx) => {
      const credit = await creditInvoice(
        tx,
        owner.tenantId,
        invoiceId,
        { invoiceLineId: null, amountMinor: 900000, reason: "goodwill" },
        { actorTenantUserId: owner.tenantUserId }
      );
      expect(credit.ok).toBe(true);
      if (!credit.ok) throw new Error("credit failed");
      // Balance NOT yet reduced (pending approval).
      expect(credit.invoice.creditedMinor).toBe(0);
      expect(credit.invoice.outstandingMinor).toBe(9900000);

      // Over-credit guard sums OPEN (pending) credits: a second pending credit
      // beyond the remaining total is rejected before any approval.
      const over = await creditInvoice(
        tx,
        owner.tenantId,
        invoiceId,
        { invoiceLineId: null, amountMinor: 9900000, reason: "too much" },
        { actorTenantUserId: owner.tenantUserId }
      );
      expect(over.ok).toBe(false);
      if (!over.ok) expect(over.reason).toBe("over_credit");
      return credit.creditNoteId;
    });

    // A DIFFERENT actor approves — only now is the balance reduced.
    await withTenant(sql, owner.tenantId, async (tx) => {
      const applied = await approveCredit(tx, owner.tenantId, creditNoteId, {
        actorTenantUserId: crypto.randomUUID()
      });
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        expect(applied.invoice.creditedMinor).toBe(900000);
        expect(applied.invoice.outstandingMinor).toBe(9900000 - 900000);
      }
    });

    // The invoice can still be voided (correction, never edit/delete).
    await withTenant(sql, owner.tenantId, async (tx) => {
      const voided = await voidInvoice(
        tx,
        owner.tenantId,
        invoiceId,
        { reason: "billing error", expectedVersion: null },
        { actorTenantUserId: owner.tenantUserId }
      );
      expect(voided.ok).toBe(true);
      if (voided.ok) expect(voided.invoice.status).toBe("void");
    });
  });

  test("usage-based lines reconcile to the usage aggregate and record their source", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await seedOffer(sql, owner.tenantId, "metered", true);
    const subId = await makeSubscription(sql, owner, "metered");

    const invoiceId = await withTenant(sql, owner.tenantId, async (tx) => {
      const gen = await generateInvoiceDraft(
        tx,
        owner.tenantId,
        subId,
        { includeUsage: true, dueInDays: null, reason: "gen" },
        invoiceDeps(tx, stubUsage(1500)), // 1500 used, 1000 included -> 500 overage
        { actorTenantUserId: owner.tenantUserId }
      );
      if (!gen.ok) throw new Error("gen failed: " + JSON.stringify(gen));
      // base 9,900,000 + overage 500 * 100 = 50,000 -> 9,950,000
      expect(gen.invoice.totalMinor).toBe(9950000);
      return gen.invoice.id;
    });

    const lines = await withTenant(sql, owner.tenantId, (tx) =>
      listInvoiceLines(tx, owner.tenantId, invoiceId)
    );
    const usageLine = lines.find((l) => l.line_type === "usage");
    expect(usageLine).toBeDefined();
    expect(usageLine?.usage_meter_key).toBe("platform.api_calls");
    expect(usageLine?.usage_source_hash).toBe("hash-1500");
    expect(usageLine?.usage_window_start).toBeTruthy();
  });

  test("issue writes invoice + status history + versioned event SAME-COMMIT (shared xmin)", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await seedOffer(sql, owner.tenantId, "growth");
    const subId = await makeSubscription(sql, owner, "growth");

    const invoiceId = await withTenant(sql, owner.tenantId, async (tx) => {
      const gen = await generateInvoiceDraft(
        tx,
        owner.tenantId,
        subId,
        { includeUsage: false, dueInDays: null, reason: "gen" },
        invoiceDeps(tx),
        { actorTenantUserId: owner.tenantUserId }
      );
      if (!gen.ok) throw new Error("gen failed");
      await issueInvoice(
        tx,
        owner.tenantId,
        gen.invoice.id,
        {
          invoiceNumber: null,
          dueAt: null,
          reason: "issue",
          expectedVersion: null
        },
        { actorTenantUserId: owner.tenantUserId }
      );
      return gen.invoice.id;
    });

    const admin = getAdminSql();
    // The issued status-history row and the domain event share ONE transaction.
    const hist = (await admin`
      SELECT xmin::text AS x FROM awcms_mini_subscription_billing_invoice_status_history
      WHERE invoice_id = ${invoiceId} AND to_status = 'issued'
    `) as { x: string }[];
    const evt = (await admin`
      SELECT xmin::text AS x FROM awcms_mini_domain_events
      WHERE aggregate_id = ${invoiceId}
        AND event_type = 'awcms-mini.subscription-billing.invoice.issued'
    `) as { x: string }[];
    expect(hist.length).toBe(1);
    expect(evt.length).toBe(1);
    expect(hist[0]!.x).toBe(evt[0]!.x);
  });

  test("tenant-scoped RLS: another tenant never sees this tenant's invoice", async () => {
    const ownerA = await bootstrapOwner();
    // `setup/initialize` is a singleton, so tenant B is a distinct tenant id
    // used only to assert RLS isolation on the READ path (the invoice's
    // tenant_id != B, so B's RLS context returns nothing).
    const tenantB = crypto.randomUUID();
    const sql = getTestSql();
    await seedOffer(sql, ownerA.tenantId, "growth");
    const subId = await makeSubscription(sql, ownerA, "growth");
    const invoiceId = await withTenant(sql, ownerA.tenantId, async (tx) => {
      const gen = await generateInvoiceDraft(
        tx,
        ownerA.tenantId,
        subId,
        { includeUsage: false, dueInDays: null, reason: "gen" },
        invoiceDeps(tx),
        { actorTenantUserId: ownerA.tenantUserId }
      );
      if (!gen.ok) throw new Error("gen failed");
      return gen.invoice.id;
    });

    // Tenant B, in its own RLS context, cannot read A's invoice.
    const seen = await withTenant(sql, tenantB, (tx) =>
      getInvoice(tx, tenantB, invoiceId)
    );
    expect(seen).toBeNull();
    // Even asking with A's tenant id from B's context returns nothing (RLS
    // predicate is current_setting, not the passed filter).
    const seenCross = await withTenant(sql, tenantB, (tx) =>
      getInvoice(tx, ownerA.tenantId, invoiceId)
    );
    expect(seenCross).toBeNull();
  });

  test("dunning requests a lifecycle transition FAIL-CLOSED (throwing port -> refused; no port -> not_available)", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    await seedOffer(sql, owner.tenantId, "growth");
    const subId = await makeSubscription(sql, owner, "growth");

    const invoiceId = await withTenant(sql, owner.tenantId, async (tx) => {
      const gen = await generateInvoiceDraft(
        tx,
        owner.tenantId,
        subId,
        { includeUsage: false, dueInDays: null, reason: "gen" },
        invoiceDeps(tx),
        { actorTenantUserId: owner.tenantUserId }
      );
      if (!gen.ok) throw new Error("gen failed");
      await issueInvoice(
        tx,
        owner.tenantId,
        gen.invoice.id,
        {
          invoiceNumber: null,
          dueAt: null,
          reason: "issue",
          expectedVersion: null
        },
        { actorTenantUserId: owner.tenantUserId }
      );
      return gen.invoice.id;
    });

    // No lifecycle port -> not_available (billing never bypasses #873).
    await withTenant(sql, owner.tenantId, async (tx) => {
      const r = await runDunningAttempt(
        tx,
        owner.tenantId,
        invoiceId,
        { requestedLifecycleState: "past_due", reason: "overdue" },
        {},
        { actorTenantUserId: owner.tenantUserId }
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.lifecycleOutcome).toBe("not_available");
    });

    // A THROWING lifecycle port -> refused (never assumed applied).
    const throwingPort: LifecycleTransitionPort = {
      async requestTransition(): Promise<LifecycleTransitionResult> {
        throw new Error("lifecycle unavailable");
      }
    };
    await withTenant(sql, owner.tenantId, async (tx) => {
      const r = await runDunningAttempt(
        tx,
        owner.tenantId,
        invoiceId,
        { requestedLifecycleState: "suspended", reason: "overdue" },
        { lifecycle: throwingPort },
        { actorTenantUserId: owner.tenantUserId }
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.lifecycleOutcome).toBe("refused");
    });

    // An OK lifecycle port -> applied.
    const okPort: LifecycleTransitionPort = {
      async requestTransition(): Promise<LifecycleTransitionResult> {
        return { ok: true, state: "past_due", version: 2 };
      }
    };
    await withTenant(sql, owner.tenantId, async (tx) => {
      const r = await runDunningAttempt(
        tx,
        owner.tenantId,
        invoiceId,
        { requestedLifecycleState: "past_due", reason: "overdue" },
        { lifecycle: okPort },
        { actorTenantUserId: owner.tenantUserId }
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.lifecycleOutcome).toBe("applied");
    });
  });

  test("per-tenant job lease is exclusive and expiry-reclaimable", async () => {
    const owner = await bootstrapOwner();
    const sql = getTestSql();
    const now = new Date("2026-01-01T00:00:00.000Z");

    await withTenant(sql, owner.tenantId, async (tx) => {
      const a = await claimLease(
        tx,
        owner.tenantId,
        "renewal",
        "worker-a",
        now,
        60_000
      );
      expect(a.granted).toBe(true);
      // A different worker cannot take a still-valid lease.
      const b = await claimLease(
        tx,
        owner.tenantId,
        "renewal",
        "worker-b",
        now,
        60_000
      );
      expect(b.granted).toBe(false);
      // After expiry, another worker reclaims it.
      const later = new Date(now.getTime() + 120_000);
      const c = await claimLease(
        tx,
        owner.tenantId,
        "renewal",
        "worker-c",
        later,
        60_000
      );
      expect(c.granted).toBe(true);
      await releaseLease(tx, owner.tenantId, "renewal", "worker-c");
      // Once released, a fresh worker can take it immediately.
      const d = await claimLease(
        tx,
        owner.tenantId,
        "renewal",
        "worker-d",
        later,
        60_000
      );
      expect(d.granted).toBe(true);
    });
  });
});
