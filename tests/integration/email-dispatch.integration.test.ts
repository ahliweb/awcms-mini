/**
 * Integration tests for the email dispatcher (Issue #495, epic #492)
 * against a real PostgreSQL — the full claim/send/finalize cycle
 * (`src/modules/email/application/email-dispatch.ts`), the real Mailketing
 * adapter talking to a local fake HTTP server standing in for
 * `api.mailketing.co.id` (same technique
 * `object-dispatch.integration.test.ts` uses for R2 — there is no real
 * Mailketing account in this environment; a real HTTP round trip against
 * our own local server genuinely exercises the adapter's request/response
 * handling, not a mock of it), and the log/fake provider path.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { getDatabaseClient } from "../../src/lib/database/client";
import {
  getProviderCircuitBreaker,
  resetProviderCircuitBreakersForTests
} from "../../src/lib/database/circuit-breaker";
import { dispatchEmailQueue } from "../../src/modules/email/application/email-dispatch";
import { createMailketingEmailProvider } from "../../src/modules/email/infrastructure/mailketing-provider";
import { createLogEmailProvider } from "../../src/modules/email/infrastructure/log-email-provider";

const TENANT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const BASE_ENV = {
  EMAIL_ENABLED: "true",
  EMAIL_FROM_ADDRESS: "no-reply@example.com",
  EMAIL_FROM_NAME: "AWCMS-Mini"
} as NodeJS.ProcessEnv;

type MessageRow = {
  status: string;
  retry_count: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  sent_at: Date | null;
  provider_message_id: string | null;
};

async function fetchMessageRow(id: string): Promise<MessageRow> {
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT status, retry_count, next_attempt_at, last_error, sent_at, provider_message_id
    FROM awcms_mini_email_messages
    WHERE tenant_id = ${TENANT_ID} AND id = ${id}
  `) as MessageRow[];

  return rows[0]!;
}

async function countDeliveryAttempts(id: string): Promise<number> {
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT count(*)::int AS count
    FROM awcms_mini_email_delivery_attempts
    WHERE tenant_id = ${TENANT_ID} AND message_id = ${id}
  `) as { count: number }[];

  return rows[0]?.count ?? 0;
}

async function seedTemplate(templateKey: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_email_templates
      (tenant_id, template_key, name, subject_template, text_body_template, created_by, updated_by)
    VALUES (
      ${TENANT_ID}, ${templateKey}, 'Test template',
      ${{ en: "Reset for {{userName}}" }}, ${{ en: "Click {{resetUrl}} to reset." }},
      gen_random_uuid(), gen_random_uuid()
    )
  `;
}

async function seedMessage(input: {
  templateKey: string | null;
  toAddress?: string;
}): Promise<string> {
  const admin = getAdminSql();
  const rows = (await admin`
    INSERT INTO awcms_mini_email_messages
      (tenant_id, category, template_key, to_address, to_address_hash, to_address_masked, subject, variables)
    VALUES (
      ${TENANT_ID}, 'auth.password_reset', ${input.templateKey},
      ${input.toAddress ?? "user@example.com"}, 'sha256:fixture', 'u***@example.com',
      'Reset your password',
      ${{ userName: "Alice", resetUrl: "https://example.com/reset?token=abc" }}
    )
    RETURNING id
  `) as { id: string }[];

  return rows[0]!.id;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("email dispatcher", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetProviderCircuitBreakersForTests();

    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_tenants
        (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${TENANT_ID}, 'tenant-c', 'Tenant C', 'Tenant C Legal', 'active', 'en', 'light')
    `;
  });

  test("EMAIL_ENABLED not true: claims nothing", async () => {
    await seedTemplate("auth.password_reset");
    await seedMessage({ templateKey: "auth.password_reset" });

    const sql = getDatabaseClient();
    const result = await dispatchEmailQueue(sql, TENANT_ID, {
      env: { ...BASE_ENV, EMAIL_ENABLED: "false" }
    });

    expect(result).toMatchObject({
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0
    });
  });

  test("log provider: renders template, marks sent, records a success delivery attempt", async () => {
    await seedTemplate("auth.password_reset");
    const id = await seedMessage({ templateKey: "auth.password_reset" });

    const sql = getDatabaseClient();
    const result = await dispatchEmailQueue(sql, TENANT_ID, {
      env: { ...BASE_ENV, EMAIL_PROVIDER: "log" },
      resolveProvider: () => createLogEmailProvider()
    });

    expect(result).toMatchObject({
      claimed: 1,
      sent: 1,
      retried: 0,
      failed: 0
    });

    const row = await fetchMessageRow(id);
    expect(row.status).toBe("sent");
    expect(row.sent_at).not.toBeNull();
    expect(row.provider_message_id).toMatch(/^log:/);
    expect(await countDeliveryAttempts(id)).toBe(1);
  });

  test("mailketing provider success: real POST to a fake Mailketing endpoint marks sent", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          status: "success",
          response: "Mail Sent",
          message_id: "fake-message-id-123"
        });
      }
    });

    try {
      await seedTemplate("auth.password_reset");
      const id = await seedMessage({ templateKey: "auth.password_reset" });

      const sql = getDatabaseClient();
      const result = await dispatchEmailQueue(sql, TENANT_ID, {
        env: { ...BASE_ENV, EMAIL_PROVIDER: "mailketing" },
        resolveProvider: () =>
          createMailketingEmailProvider({
            apiToken: "test-token",
            baseUrl: `http://127.0.0.1:${server.port}`
          })
      });

      expect(result).toMatchObject({
        claimed: 1,
        sent: 1,
        retried: 0,
        failed: 0
      });

      const row = await fetchMessageRow(id);
      expect(row.status).toBe("sent");
      expect(row.provider_message_id).toBe("fake-message-id-123");
    } finally {
      server.stop(true);
    }
  });

  test("mailketing business failure (status=failed) is non-retryable: fails immediately", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          status: "failed",
          response: "Invalid Recipient"
        });
      }
    });

    try {
      await seedTemplate("auth.password_reset");
      const id = await seedMessage({ templateKey: "auth.password_reset" });

      const sql = getDatabaseClient();
      const result = await dispatchEmailQueue(sql, TENANT_ID, {
        env: {
          ...BASE_ENV,
          EMAIL_PROVIDER: "mailketing",
          EMAIL_SEND_MAX_RETRIES: "5"
        },
        resolveProvider: () =>
          createMailketingEmailProvider({
            apiToken: "test-token",
            baseUrl: `http://127.0.0.1:${server.port}`
          })
      });

      expect(result).toMatchObject({
        claimed: 1,
        sent: 0,
        retried: 0,
        failed: 1
      });

      const row = await fetchMessageRow(id);
      expect(row.status).toBe("failed");
      expect(row.retry_count).toBe(1);
      expect(row.last_error).toContain("Invalid Recipient");
    } finally {
      server.stop(true);
    }
  });

  test("mailketing 5xx failures back off, then exhaust to failed after max retries", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount += 1;
        return new Response("simulated outage", { status: 500 });
      }
    });

    try {
      await seedTemplate("auth.password_reset");
      const id = await seedMessage({ templateKey: "auth.password_reset" });

      const sql = getDatabaseClient();
      const resolveProvider = () =>
        createMailketingEmailProvider({
          apiToken: "test-token",
          baseUrl: `http://127.0.0.1:${server.port}`
        });
      const env = {
        ...BASE_ENV,
        EMAIL_PROVIDER: "mailketing",
        EMAIL_SEND_MAX_RETRIES: "2"
      } as NodeJS.ProcessEnv;

      const first = await dispatchEmailQueue(sql, TENANT_ID, {
        env,
        resolveProvider,
        now: new Date()
      });
      expect(first).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
      expect((await fetchMessageRow(id)).status).toBe("retry_wait");

      const farFuture = new Date(Date.now() + 60 * 60_000);
      const second = await dispatchEmailQueue(sql, TENANT_ID, {
        env,
        resolveProvider,
        now: farFuture
      });
      expect(second).toMatchObject({ claimed: 1, retried: 1, failed: 0 });

      const third = await dispatchEmailQueue(sql, TENANT_ID, {
        env,
        resolveProvider,
        now: new Date(farFuture.getTime() + 60 * 60_000)
      });
      expect(third).toMatchObject({ claimed: 1, retried: 0, failed: 1 });

      const row = await fetchMessageRow(id);
      expect(row.status).toBe("failed");
      expect(row.retry_count).toBe(3);
      expect(requestCount).toBe(3);
      expect(await countDeliveryAttempts(id)).toBe(3);
    } finally {
      server.stop(true);
    }
  });

  test("missing/inactive template: fails immediately without calling the provider", async () => {
    const id = await seedMessage({ templateKey: "does.not_exist" });
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        calls += 1;
        return Response.json({ status: "success", response: "Mail Sent" });
      }
    });

    try {
      const sql = getDatabaseClient();
      const result = await dispatchEmailQueue(sql, TENANT_ID, {
        env: { ...BASE_ENV, EMAIL_PROVIDER: "mailketing" },
        resolveProvider: () =>
          createMailketingEmailProvider({
            apiToken: "test-token",
            baseUrl: `http://127.0.0.1:${server.port}`
          })
      });

      expect(result).toMatchObject({
        claimed: 1,
        sent: 0,
        retried: 0,
        failed: 1
      });
      expect(calls).toBe(0);

      const row = await fetchMessageRow(id);
      expect(row.status).toBe("failed");
      expect(row.last_error).toContain("does.not_exist");
    } finally {
      server.stop(true);
    }
  });

  test("a recipient suppressed after enqueue is skipped at dispatch time, without calling the provider", async () => {
    await seedTemplate("auth.password_reset");
    const id = await seedMessage({
      templateKey: "auth.password_reset",
      toAddress: "suppressed@example.com"
    });

    const admin = getAdminSql();
    const hash = `sha256:${new Bun.CryptoHasher("sha256").update("suppressed@example.com").digest("hex")}`;
    await admin`
      UPDATE awcms_mini_email_messages SET to_address_hash = ${hash}
      WHERE id = ${id}
    `;
    await admin`
      INSERT INTO awcms_mini_email_suppression_list
        (tenant_id, recipient_hash, recipient_masked, reason)
      VALUES (${TENANT_ID}, ${hash}, 's***@example.com', 'bounced')
    `;

    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        calls += 1;
        return Response.json({ status: "success", response: "Mail Sent" });
      }
    });

    try {
      const sql = getDatabaseClient();
      const result = await dispatchEmailQueue(sql, TENANT_ID, {
        env: { ...BASE_ENV, EMAIL_PROVIDER: "mailketing" },
        resolveProvider: () =>
          createMailketingEmailProvider({
            apiToken: "test-token",
            baseUrl: `http://127.0.0.1:${server.port}`
          })
      });

      expect(result).toMatchObject({
        claimed: 1,
        sent: 0,
        retried: 0,
        failed: 0,
        suppressed: 1
      });
      expect(calls).toBe(0);

      const row = await fetchMessageRow(id);
      expect(row.status).toBe("suppressed");
      expect(await countDeliveryAttempts(id)).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("open circuit breaker: skips the pass entirely without claiming anything", async () => {
    await seedTemplate("auth.password_reset");
    await seedMessage({ templateKey: "auth.password_reset" });

    const breaker = getProviderCircuitBreaker("email-mailketing");
    const now = new Date();
    breaker.recordFailure(now);
    breaker.recordFailure(now);
    breaker.recordFailure(now);
    breaker.recordFailure(now);
    breaker.recordFailure(now);

    const sql = getDatabaseClient();
    const result = await dispatchEmailQueue(sql, TENANT_ID, {
      env: { ...BASE_ENV, EMAIL_PROVIDER: "mailketing" },
      now
    });

    expect(result.breakerOpen).toBe(true);
    expect(result.claimed).toBe(0);
  });

  afterEach(() => {
    resetProviderCircuitBreakersForTests();
  });
});
