import test from "node:test";
import assert from "node:assert/strict";

import { TurnstileValidationError, validateTurnstileToken } from "../../src/security/turnstile.mjs";

test("validateTurnstileToken skips validation when Turnstile is disabled", async () => {
  const result = await validateTurnstileToken(
    { token: "" },
    {
      runtimeConfig: {
        turnstile: {
          enabled: false,
          secretKey: null,
          expectedHostname: null,
        },
      },
    },
  );

  assert.deepEqual(result, { enabled: false, success: true });
});

test("validateTurnstileToken enforces action and hostname checks", async () => {
  const result = await validateTurnstileToken(
    { token: "token-value", expectedAction: "login", remoteIp: "203.0.113.10" },
    {
      runtimeConfig: {
        turnstile: {
          enabled: true,
          secretKey: "secret",
          expectedHostname: "example.test",
        },
      },
      fetchImpl: async () => ({
        async json() {
          return {
            success: true,
            action: "login",
            hostname: "example.test",
            challenge_ts: "2026-04-18T00:00:00.000Z",
          };
        },
      }),
      idempotencyKey: "idem-key",
    },
  );

  assert.equal(result.enabled, true);
  assert.equal(result.success, true);
  assert.equal(result.action, "login");
  assert.equal(result.hostname, "example.test");
});

test("validateTurnstileToken rejects duplicate or mismatched tokens", async () => {
  await assert.rejects(
    () =>
      validateTurnstileToken(
        { token: "token-value", expectedAction: "login" },
        {
          runtimeConfig: {
            turnstile: {
              enabled: true,
              secretKey: "secret",
              expectedHostname: "example.test",
            },
          },
          fetchImpl: async () => ({
            async json() {
              return {
                success: false,
                "error-codes": ["timeout-or-duplicate"],
              };
            },
          }),
        },
      ),
    (error) => error instanceof TurnstileValidationError && error.code === "TURNSTILE_INVALID",
  );

  await assert.rejects(
    () =>
      validateTurnstileToken(
        { token: "token-value", expectedAction: "login" },
        {
          runtimeConfig: {
            turnstile: {
              enabled: true,
              secretKey: "secret",
              expectedHostname: "example.test",
            },
          },
          fetchImpl: async () => ({
            async json() {
              return {
                success: true,
                action: "login",
                hostname: "other.example.com",
              };
            },
          }),
        },
      ),
    (error) => error instanceof TurnstileValidationError && error.code === "TURNSTILE_HOSTNAME_MISMATCH",
  );
});
