import test from "node:test";
import assert from "node:assert/strict";

import { createLockoutService } from "../../src/services/security/lockout.mjs";
import { createRuntimeRateLimitStore } from "../../src/security/runtime-rate-limits.mjs";

test("lockout service escalates repeated failures and resets counters", async () => {
  const events = [];
  const rateLimitStore = createRuntimeRateLimitStore({
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
  });

  assert.equal(await service.assertLoginAllowed({ email: "user@example.com", ipAddress: "127.0.0.1" }), null);
  await service.registerLoginFailure({ email: "user@example.com", ipAddress: "127.0.0.1", reason: "invalid_password" });
  await service.registerLoginFailure({ email: "user@example.com", ipAddress: "127.0.0.1", reason: "invalid_password" });
  const third = await service.registerLoginFailure({ email: "user@example.com", ipAddress: "127.0.0.1", reason: "invalid_password" });

  assert.equal(Boolean(third.lockedUntil), true);
  const lock = await service.assertLoginAllowed({ email: "user@example.com", ipAddress: "127.0.0.1" });
  assert.equal(lock.code, "AUTH_LOCKED");
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "auth.lockout");

  service.resetLoginCounters({ email: "user@example.com", ipAddress: "127.0.0.1" });
  assert.equal(await service.assertLoginAllowed({ email: "user@example.com", ipAddress: "127.0.0.1" }), null);
});
