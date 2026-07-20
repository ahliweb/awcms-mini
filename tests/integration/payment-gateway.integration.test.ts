/**
 * Integration tests for `payment_gateway` against real PostgreSQL (Issue #877,
 * epic #868, ADR-0022). Covers, per AC:
 *   - PROVIDER CALL IS OUTSIDE THE TRANSACTION: initiate commits the local intent
 *     + outbox row FIRST (status initiated / outbox pending) with NO provider
 *     call; the sandbox dispatch (a separate step) advances it to pending;
 *   - a VALID signed webhook settles a payment EXACTLY ONCE (a replay of the same
 *     provider event id is a durable no-op);
 *   - MUTATION: an invalid signature is rejected and NEVER settles; a browser
 *     "return" (no webhook) never settles an intent;
 *   - cross-tenant event SUBSTITUTION (a webhook whose payload account_ref is
 *     another account) is rejected;
 *   - an out-of-order event produces deterministic safe state + reconciliation
 *     evidence (never a regression);
 *   - a provider timeout/outage yields retry/DLQ without holding a transaction;
 *   - reconciliation resolves a lost-webhook settlement idempotently;
 *   - the expire sweep produces deterministic safe state;
 *   - a refund flows request -> dispatch -> succeeded (write-once) -> intent refunded;
 *   - tenant-scoped RLS cross-tenant isolation (tenant A never sees B);
 *   - LAN/offline: a provider with NO registered adapter dead-letters gracefully.
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
  provisionWorkerRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { withTenant } from "../../src/lib/database/tenant-context";
import {
  insertProviderAccount,
  resolveProviderAccountLookup
} from "../../src/modules/payment-gateway/application/payment-directory";
import {
  cancelSession,
  initiateCheckout
} from "../../src/modules/payment-gateway/application/payment-engine";
import { processInboundPaymentWebhook } from "../../src/modules/payment-gateway/application/webhook-intake";
import { runOutboxDispatch } from "../../src/modules/payment-gateway/application/outbox-dispatch";
import {
  runExpireSweep,
  runReconciliation
} from "../../src/modules/payment-gateway/application/reconciliation-engine";
import { requestRefund } from "../../src/modules/payment-gateway/application/refund-engine";
import {
  sandboxControl,
  signSandboxWebhook
} from "../../src/modules/payment-gateway/infrastructure/sandbox-adapter";

const OWNER_PASSWORD = "integration-test-payment-owner-password";
const SECRET = "whsec_payment_integration_secret";
const SECRET_ENV = "PAYMENT_GW_INTEGRATION_SECRET";

type Owner = { tenantId: string; tenantUserId: string };
let codeSeq = 0;

async function bootstrapOwner(): Promise<Owner> {
  codeSeq += 1;
  const loginIdentifier = `pay-owner-${codeSeq}@example.com`;
  const code = `pay${codeSeq}`;
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

async function seedAccount(
  tenantId: string,
  providerKey: string,
  accountRef: string
): Promise<string> {
  const sql = getTestSql();
  return withTenant(sql, tenantId, async (tx) => {
    const row = await insertProviderAccount(tx, {
      tenantId,
      providerKey,
      providerAccountRef: accountRef,
      displayName: "Sandbox",
      status: "active",
      signingSecretRef: `env:${SECRET_ENV}`,
      endpointHost: "api.provider.com",
      callbackHost: "return.provider.com",
      webhookToleranceSeconds: 300,
      maxWebhookBodyBytes: 65536,
      reason: "test",
      actor: null
    });
    return row.id;
  });
}

/** Create an intent (no billing dep) and return its id + amount. */
async function seedIntent(
  owner: Owner,
  accountId: string,
  invoiceId: string,
  amountMinor = 500000,
  expiresAt: string | null = null
): Promise<string> {
  const sql = getTestSql();
  return withTenant(sql, owner.tenantId, async (tx) => {
    const res = await initiateCheckout(
      tx,
      owner.tenantId,
      {
        providerAccountId: accountId,
        invoiceId,
        subscriptionId: null,
        amountMinor,
        currency: "IDR",
        expiresAt,
        reason: "test checkout"
      },
      {},
      {
        actorTenantUserId: owner.tenantUserId,
        correlationId: crypto.randomUUID()
      }
    );
    if (!res.ok) throw new Error("seedIntent: " + JSON.stringify(res));
    return res.intent.id;
  });
}

async function deliverWebhook(
  accountId: string,
  accountRef: string,
  body: Record<string, unknown>,
  now = new Date()
): Promise<{ outcome: string }> {
  const sql = getTestSql();
  const account = await resolveProviderAccountLookup(sql, accountId);
  if (!account) throw new Error("deliverWebhook: account not resolved");
  const rawBody = JSON.stringify({ account_ref: accountRef, ...body });
  const { timestamp, signature } = signSandboxWebhook(
    SECRET,
    rawBody,
    String(Math.floor(now.getTime() / 1000))
  );
  return withTenant(sql, account.tenant_id, (tx) =>
    processInboundPaymentWebhook(tx, {
      account,
      rawBody,
      headers: {
        "x-sandbox-timestamp": timestamp,
        "x-sandbox-signature": signature
      },
      contentType: "application/json",
      now,
      correlationId: crypto.randomUUID()
    })
  );
}

async function intentStatus(
  tenantId: string,
  intentId: string
): Promise<string | null> {
  const sql = getTestSql();
  return withTenant(sql, tenantId, async (tx) => {
    const rows = (await tx`
      SELECT status FROM awcms_mini_payment_gateway_payment_intents
      WHERE tenant_id = ${tenantId} AND id = ${intentId}
    `) as { status: string }[];
    return rows[0]?.status ?? null;
  });
}

async function countAppliedAttempts(
  tenantId: string,
  intentId: string
): Promise<number> {
  const sql = getTestSql();
  return withTenant(sql, tenantId, async (tx) => {
    const rows = (await tx`
      SELECT count(*)::int AS n
      FROM awcms_mini_payment_gateway_processing_attempts
      WHERE tenant_id = ${tenantId} AND intent_id = ${intentId} AND outcome = 'applied'
    `) as { n: number }[];
    return rows[0]?.n ?? 0;
  });
}

const ACCOUNT_REF = "acct_sandbox_merchant";

describe.skipIf(!integrationEnabled)("payment_gateway (integration)", () => {
  beforeAll(async () => {
    process.env[SECRET_ENV] = SECRET;
    await applyMigrations();
    await provisionAppRole();
    await provisionWorkerRole();
  });

  beforeEach(async () => {
    sandboxControl.reset();
    await resetDatabase();
  });

  test("provider call is OUTSIDE the transaction: initiate commits intent + outbox first, dispatch advances to pending", async () => {
    const owner = await bootstrapOwner();
    const accountId = await seedAccount(owner.tenantId, "sandbox", ACCOUNT_REF);
    const invoiceId = crypto.randomUUID();
    const intentId = await seedIntent(owner, accountId, invoiceId);

    // Immediately after initiate (before any dispatch), the intent is 'initiated'
    // and an outbox row is 'pending' — NO provider call has happened.
    expect(await intentStatus(owner.tenantId, intentId)).toBe("initiated");
    const sql = getTestSql();
    const outbox = await withTenant(sql, owner.tenantId, async (tx) => {
      return (await tx`
        SELECT status, kind FROM awcms_mini_payment_gateway_outbox
        WHERE tenant_id = ${owner.tenantId} AND intent_id = ${intentId}
      `) as { status: string; kind: string }[];
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      status: "pending",
      kind: "create_checkout"
    });

    // The worker dispatches the provider call outside any transaction.
    const result = await runOutboxDispatch(sql, {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });
    expect(result.succeeded).toBeGreaterThanOrEqual(1);
    expect(await intentStatus(owner.tenantId, intentId)).toBe("pending");
  });

  test("a VALID signed webhook settles a payment EXACTLY ONCE (replay is a durable no-op)", async () => {
    const owner = await bootstrapOwner();
    const accountId = await seedAccount(owner.tenantId, "sandbox", ACCOUNT_REF);
    const invoiceId = crypto.randomUUID();
    const intentId = await seedIntent(owner, accountId, invoiceId);
    const sql = getTestSql();
    await runOutboxDispatch(sql, {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });
    const sessionRef = `sbx_sess_${intentId}`;

    const first = await deliverWebhook(accountId, ACCOUNT_REF, {
      event_id: "evt_settle_1",
      session_ref: sessionRef,
      status: "settled",
      sequence: 2,
      amount_minor: 500000,
      currency: "IDR"
    });
    expect(first.outcome).toBe("accepted_new");
    expect(await intentStatus(owner.tenantId, intentId)).toBe("settled");
    expect(await countAppliedAttempts(owner.tenantId, intentId)).toBe(1);

    // Replay the SAME provider event id -> durable dedup, no second apply.
    const replay = await deliverWebhook(accountId, ACCOUNT_REF, {
      event_id: "evt_settle_1",
      session_ref: sessionRef,
      status: "settled",
      sequence: 2,
      amount_minor: 500000,
      currency: "IDR"
    });
    expect(replay.outcome).toBe("accepted_duplicate");
    expect(await countAppliedAttempts(owner.tenantId, intentId)).toBe(1);
  });

  test("MUTATION: an invalid signature is rejected and NEVER settles; a browser return (no webhook) never settles", async () => {
    const owner = await bootstrapOwner();
    const accountId = await seedAccount(owner.tenantId, "sandbox", ACCOUNT_REF);
    const invoiceId = crypto.randomUUID();
    const intentId = await seedIntent(owner, accountId, invoiceId);
    const sql = getTestSql();
    await runOutboxDispatch(sql, {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });

    // Forged signature (a browser posting a fake "paid" body).
    const account = await resolveProviderAccountLookup(sql, accountId);
    const rawBody = JSON.stringify({
      account_ref: ACCOUNT_REF,
      event_id: "evt_forged",
      session_ref: `sbx_sess_${intentId}`,
      status: "settled",
      sequence: 2
    });
    const rejected = await withTenant(sql, owner.tenantId, (tx) =>
      processInboundPaymentWebhook(tx, {
        account: account!,
        rawBody,
        headers: {
          "x-sandbox-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-sandbox-signature": "deadbeefcafe"
        },
        contentType: "application/json",
        now: new Date(),
        correlationId: crypto.randomUUID()
      })
    );
    expect(rejected.outcome).toBe("rejected");
    // The intent is STILL pending — a browser redirect / forged body never settles.
    expect(await intentStatus(owner.tenantId, intentId)).toBe("pending");
    // A rejected delivery is recorded fail-closed.
    const rejectedRows = await withTenant(
      sql,
      owner.tenantId,
      async (tx) =>
        (await tx`
        SELECT signature_valid, status FROM awcms_mini_payment_gateway_webhook_inbox
        WHERE tenant_id = ${owner.tenantId} AND signature_valid = false
      `) as { signature_valid: boolean; status: string }[]
    );
    expect(rejectedRows.length).toBeGreaterThanOrEqual(1);
  });

  test("MUTATION: cross-tenant event substitution (wrong payload account_ref) is rejected", async () => {
    const owner = await bootstrapOwner();
    const accountId = await seedAccount(owner.tenantId, "sandbox", ACCOUNT_REF);
    const invoiceId = crypto.randomUUID();
    const intentId = await seedIntent(owner, accountId, invoiceId);
    const sql = getTestSql();
    await runOutboxDispatch(sql, {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });

    const result = await deliverWebhook(accountId, "acct_SOME_OTHER_MERCHANT", {
      event_id: "evt_sub",
      session_ref: `sbx_sess_${intentId}`,
      status: "settled",
      sequence: 2
    });
    expect(result.outcome).toBe("rejected");
    expect(await intentStatus(owner.tenantId, intentId)).toBe("pending");
  });

  test("an out-of-order event produces deterministic safe state + reconciliation evidence (never a regression)", async () => {
    const owner = await bootstrapOwner();
    const accountId = await seedAccount(owner.tenantId, "sandbox", ACCOUNT_REF);
    const invoiceId = crypto.randomUUID();
    const intentId = await seedIntent(owner, accountId, invoiceId);
    const sql = getTestSql();
    await runOutboxDispatch(sql, {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });
    const sessionRef = `sbx_sess_${intentId}`;

    await deliverWebhook(accountId, ACCOUNT_REF, {
      event_id: "e_settle",
      session_ref: sessionRef,
      status: "settled",
      sequence: 5
    });
    expect(await intentStatus(owner.tenantId, intentId)).toBe("settled");

    // A LATE 'failed' event with a lower sequence must NOT regress the settled intent.
    await deliverWebhook(accountId, ACCOUNT_REF, {
      event_id: "e_late_fail",
      session_ref: sessionRef,
      status: "failed",
      sequence: 3
    });
    expect(await intentStatus(owner.tenantId, intentId)).toBe("settled");
    const recon = await withTenant(
      sql,
      owner.tenantId,
      async (tx) =>
        (await tx`
        SELECT count(*)::int AS n FROM awcms_mini_payment_gateway_reconciliations
        WHERE tenant_id = ${owner.tenantId} AND intent_id = ${intentId}
      `) as { n: number }[]
    );
    expect(recon[0]!.n).toBeGreaterThanOrEqual(1);
  });

  test("a provider timeout yields retry then DLQ without holding a transaction", async () => {
    const owner = await bootstrapOwner();
    const accountId = await seedAccount(owner.tenantId, "sandbox", ACCOUNT_REF);
    const intentId = await seedIntent(owner, accountId, crypto.randomUUID());
    const sql = getTestSql();

    // Force the provider to time out on every dispatch, then drive enough passes
    // to exhaust the outbox row's attempts (default max 5) -> dead (DLQ).
    sandboxControl.checkoutFault = "timeout";
    for (let i = 0; i < 6; i += 1) {
      await runOutboxDispatch(
        sql,
        {
          dryRun: false,
          correlationId: crypto.randomUUID()
        },
        { now: new Date(Date.now() + i * 7_200_000) }
      );
    }
    const outbox = await withTenant(
      sql,
      owner.tenantId,
      async (tx) =>
        (await tx`
        SELECT status, attempts FROM awcms_mini_payment_gateway_outbox
        WHERE tenant_id = ${owner.tenantId} AND intent_id = ${intentId}
      `) as { status: string; attempts: number }[]
    );
    expect(outbox[0]!.status).toBe("dead");
    // The intent never advanced past 'initiated' (the provider never succeeded).
    expect(await intentStatus(owner.tenantId, intentId)).toBe("initiated");
  });

  test("reconciliation resolves a lost-webhook settlement idempotently", async () => {
    const owner = await bootstrapOwner();
    const accountId = await seedAccount(owner.tenantId, "sandbox", ACCOUNT_REF);
    const intentId = await seedIntent(owner, accountId, crypto.randomUUID());
    const sql = getTestSql();
    await runOutboxDispatch(sql, {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });
    const sessionRef = `sbx_sess_${intentId}`;

    // The provider says settled, but the webhook was lost -> reconciliation closes it.
    sandboxControl.statusBySession[sessionRef] = "settled";
    const r1 = await runReconciliation(sql, {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });
    expect(r1.changed).toBeGreaterThanOrEqual(1);
    expect(await intentStatus(owner.tenantId, intentId)).toBe("settled");
    // Idempotent: a second pass makes no further change (already settled).
    const r2 = await runReconciliation(sql, {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });
    expect(r2.changed).toBe(0);
  });

  test("the expire sweep produces deterministic safe state", async () => {
    const owner = await bootstrapOwner();
    const accountId = await seedAccount(owner.tenantId, "sandbox", ACCOUNT_REF);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const intentId = await seedIntent(
      owner,
      accountId,
      crypto.randomUUID(),
      500000,
      past
    );
    const sql = getTestSql();
    const result = await runExpireSweep(sql, {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });
    expect(result.changed).toBeGreaterThanOrEqual(1);
    expect(await intentStatus(owner.tenantId, intentId)).toBe("expired");
  });

  test("a refund flows request -> dispatch -> succeeded (write-once) and refunds the intent", async () => {
    const owner = await bootstrapOwner();
    const accountId = await seedAccount(owner.tenantId, "sandbox", ACCOUNT_REF);
    const intentId = await seedIntent(
      owner,
      accountId,
      crypto.randomUUID(),
      500000
    );
    const sql = getTestSql();
    await runOutboxDispatch(sql, {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });
    await deliverWebhook(accountId, ACCOUNT_REF, {
      event_id: "e_pay",
      session_ref: `sbx_sess_${intentId}`,
      status: "settled",
      sequence: 2
    });
    expect(await intentStatus(owner.tenantId, intentId)).toBe("settled");

    const refundId = await withTenant(sql, owner.tenantId, async (tx) => {
      const res = await requestRefund(
        tx,
        owner.tenantId,
        intentId,
        { amountMinor: 500000, reason: "duplicate charge" },
        {
          actorTenantUserId: owner.tenantUserId,
          correlationId: crypto.randomUUID()
        }
      );
      if (!res.ok) throw new Error("refund: " + JSON.stringify(res));
      return res.refund.id;
    });

    await runOutboxDispatch(sql, {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });
    const refund = await withTenant(
      sql,
      owner.tenantId,
      async (tx) =>
        (await tx`
        SELECT status, provider_refund_ref FROM awcms_mini_payment_gateway_refunds
        WHERE tenant_id = ${owner.tenantId} AND id = ${refundId}
      `) as { status: string; provider_refund_ref: string | null }[]
    );
    expect(refund[0]!.status).toBe("succeeded");
    expect(refund[0]!.provider_refund_ref).not.toBeNull();
    expect(await intentStatus(owner.tenantId, intentId)).toBe("refunded");
  });

  test("tenant-scoped RLS: tenant A's intent is invisible to tenant B", async () => {
    const a = await bootstrapOwner();
    // `setup/initialize` is a singleton, so tenant B is a distinct tenant id
    // used only to assert RLS isolation on the READ path (the intent's tenant_id
    // != B, so B's RLS context returns nothing — the predicate is
    // current_setting, not the passed filter).
    const tenantB = crypto.randomUUID();
    const accountId = await seedAccount(a.tenantId, "sandbox", ACCOUNT_REF);
    const intentId = await seedIntent(a, accountId, crypto.randomUUID());
    const sql = getTestSql();
    const seenByB = await withTenant(
      sql,
      tenantB,
      async (tx) =>
        (await tx`
        SELECT id FROM awcms_mini_payment_gateway_payment_intents
        WHERE id = ${intentId}
      `) as { id: string }[]
    );
    expect(seenByB).toHaveLength(0);
  });

  test("LAN/offline: a provider with NO registered adapter dead-letters gracefully (no crash, no held tx)", async () => {
    const owner = await bootstrapOwner();
    // A provider_key with no registered adapter (a derived app would register one).
    const accountId = await seedAccount(
      owner.tenantId,
      "unconfigured",
      "acct_unconfigured"
    );
    const intentId = await seedIntent(owner, accountId, crypto.randomUUID());
    const sql = getTestSql();
    await runOutboxDispatch(sql, {
      dryRun: false,
      correlationId: crypto.randomUUID()
    });
    const outbox = await withTenant(
      sql,
      owner.tenantId,
      async (tx) =>
        (await tx`
        SELECT status FROM awcms_mini_payment_gateway_outbox
        WHERE tenant_id = ${owner.tenantId} AND intent_id = ${intentId}
      `) as { status: string }[]
    );
    expect(outbox[0]!.status).toBe("dead");
    expect(await intentStatus(owner.tenantId, intentId)).toBe("initiated");
  });

  test("a session can be canceled to expired (operator)", async () => {
    const owner = await bootstrapOwner();
    const accountId = await seedAccount(owner.tenantId, "sandbox", ACCOUNT_REF);
    const intentId = await seedIntent(owner, accountId, crypto.randomUUID());
    const sql = getTestSql();
    const res = await withTenant(sql, owner.tenantId, (tx) =>
      cancelSession(
        tx,
        owner.tenantId,
        intentId,
        { reason: "operator canceled", expectedVersion: null },
        {
          actorTenantUserId: owner.tenantUserId,
          correlationId: crypto.randomUUID()
        }
      )
    );
    expect(res.ok).toBe(true);
    expect(await intentStatus(owner.tenantId, intentId)).toBe("expired");
  });
});
