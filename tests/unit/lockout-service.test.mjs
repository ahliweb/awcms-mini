import test from "node:test";
import assert from "node:assert/strict";

import { createLockoutService } from "../../src/services/security/lockout.mjs";
import { createRuntimeRateLimitStore } from "../../src/security/runtime-rate-limits.mjs";

function createFakeRateLimitRepository() {
  const rows = new Map();

  return {
    async getCounter(scopeKey) {
      return rows.get(scopeKey);
    },
    async upsertCounter(input) {
      rows.set(input.scope_key, {
        scope_key: input.scope_key,
        counter: input.counter,
        window_starts_at: input.window_starts_at,
        locked_until: input.locked_until,
        expires_at: input.expires_at,
        updated_at: input.updated_at,
      });
      return rows.get(input.scope_key);
    },
    async deleteCounter(scopeKey) {
      rows.delete(scopeKey);
    },
    async deleteExpiredCounters(expiresBefore) {
      for (const [scopeKey, row] of rows.entries()) {
        if (String(row.expires_at) <= String(expiresBefore)) {
          rows.delete(scopeKey);
        }
      }
    },
  };
}

test("lockout service escalates repeated failures and resets counters", async () => {
  const events = [];
  const audits = [];
  const rateLimitStore = createRuntimeRateLimitStore({
    repository: createFakeRateLimitRepository(),
    policy: {
      maxFailuresPerAccount: 3,
      maxFailuresPerIp: 5,
      windowMs: 60_000,
      lockoutMs: 120_000,
    },
  });
  let currentNow = Date.parse("2026-01-01T00:00:00.000Z");
  const service = createLockoutService({
    database: {},
    rateLimitStore,
    now: () => currentNow,
    securityEvents: {
      async appendEvent(event) {
        events.push(event);
      },
    },
    audit: {
      async append(entry) {
        audits.push(entry);
      },
    },
  });

  assert.equal(await service.assertLoginAllowed({ email: "user@example.com", ipAddress: "127.0.0.1" }), null);
  await service.registerLoginFailure({ email: "user@example.com", ipAddress: "127.0.0.1", reason: "invalid_password" });
  await service.registerLoginFailure({ email: "user@example.com", ipAddress: "127.0.0.1", reason: "invalid_password" });
  const third = await service.registerLoginFailure({ email: "user@example.com", ipAddress: "127.0.0.1", reason: "invalid_password" });

  assert.equal(Boolean(third.lockedUntil), true);
  const lock = await service.assertLoginAllowed({ email: "user@example.com", ipAddress: "127.0.0.1" });
  assert.equal(lock.code, "AUTH_LOCKED");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "auth.lockout");
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "auth.lockout");

  await service.resetLoginCounters({ email: "user@example.com", ipAddress: "127.0.0.1" });
  assert.equal(await service.assertLoginAllowed({ email: "user@example.com", ipAddress: "127.0.0.1" }), null);
});
