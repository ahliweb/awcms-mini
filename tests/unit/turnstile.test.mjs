import test from "node:test";
import assert from "node:assert/strict";

import { getRuntimeConfig } from "../../src/config/runtime.mjs";
import { TurnstileValidationError, validateTurnstileToken } from "../../src/security/turnstile.mjs";

test("validateTurnstileToken skips validation when Turnstile is disabled", async () => {
  const result = await validateTurnstileToken(
    { token: "" },
    {
      runtimeConfig: {
        turnstile: {
          enabled: false,
          secretKey: null,
          expectedHostnames: [],
          expectedHostname: null,
        },
      },
    },
  );

  assert.deepEqual(result, { enabled: false, success: true });
});

test("validateTurnstileToken enforces action and multi-hostname checks", async () => {
  const result = await validateTurnstileToken(
    { token: "token-value", expectedAction: "login", remoteIp: "203.0.113.10" },
    {
      runtimeConfig: {
        turnstile: {
          enabled: true,
          secretKey: "secret",
          expectedHostnames: ["example.test", "admin.example.test"],
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
              expectedHostnames: ["example.test", "admin.example.test"],
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
              expectedHostnames: ["example.test", "admin.example.test"],
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

test("getRuntimeConfig derives expected Turnstile hostnames from public and admin site URLs", async () => {
  const previousSiteUrl = process.env.SITE_URL;
  const previousAdminSiteUrl = process.env.ADMIN_SITE_URL;
  const previousExpectedHostname = process.env.TURNSTILE_EXPECTED_HOSTNAME;
  const previousExpectedHostnames = process.env.TURNSTILE_EXPECTED_HOSTNAMES;

  process.env.SITE_URL = "https://awcms-mini.ahlikoding.com";
  process.env.ADMIN_SITE_URL = "https://awcms-mini-admin.ahlikoding.com";
  delete process.env.TURNSTILE_EXPECTED_HOSTNAME;
  delete process.env.TURNSTILE_EXPECTED_HOSTNAMES;

  try {
    const runtimeConfig = getRuntimeConfig();

    assert.deepEqual(runtimeConfig.turnstile.expectedHostnames, [
      "awcms-mini.ahlikoding.com",
      "awcms-mini-admin.ahlikoding.com",
    ]);
    assert.equal(runtimeConfig.turnstile.expectedHostname, null);
  } finally {
    if (previousSiteUrl === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = previousSiteUrl;

    if (previousAdminSiteUrl === undefined) delete process.env.ADMIN_SITE_URL;
    else process.env.ADMIN_SITE_URL = previousAdminSiteUrl;

    if (previousExpectedHostname === undefined) delete process.env.TURNSTILE_EXPECTED_HOSTNAME;
    else process.env.TURNSTILE_EXPECTED_HOSTNAME = previousExpectedHostname;

    if (previousExpectedHostnames === undefined) delete process.env.TURNSTILE_EXPECTED_HOSTNAMES;
    else process.env.TURNSTILE_EXPECTED_HOSTNAMES = previousExpectedHostnames;
  }
});

test("getRuntimeConfig derives a single expected Turnstile hostname when only SITE_URL is configured", async () => {
  const previousSiteUrl = process.env.SITE_URL;
  const previousAdminSiteUrl = process.env.ADMIN_SITE_URL;
  const previousExpectedHostname = process.env.TURNSTILE_EXPECTED_HOSTNAME;
  const previousExpectedHostnames = process.env.TURNSTILE_EXPECTED_HOSTNAMES;

  process.env.SITE_URL = "https://awcms-mini.ahlikoding.com";
  delete process.env.ADMIN_SITE_URL;
  delete process.env.TURNSTILE_EXPECTED_HOSTNAME;
  delete process.env.TURNSTILE_EXPECTED_HOSTNAMES;

  try {
    const runtimeConfig = getRuntimeConfig();

    assert.deepEqual(runtimeConfig.turnstile.expectedHostnames, ["awcms-mini.ahlikoding.com"]);
    assert.equal(runtimeConfig.turnstile.expectedHostname, null);
  } finally {
    if (previousSiteUrl === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = previousSiteUrl;

    if (previousAdminSiteUrl === undefined) delete process.env.ADMIN_SITE_URL;
    else process.env.ADMIN_SITE_URL = previousAdminSiteUrl;

    if (previousExpectedHostname === undefined) delete process.env.TURNSTILE_EXPECTED_HOSTNAME;
    else process.env.TURNSTILE_EXPECTED_HOSTNAME = previousExpectedHostname;

    if (previousExpectedHostnames === undefined) delete process.env.TURNSTILE_EXPECTED_HOSTNAMES;
    else process.env.TURNSTILE_EXPECTED_HOSTNAMES = previousExpectedHostnames;
  }
});

test("getRuntimeConfig honors explicit multi-hostname Turnstile configuration", async () => {
  const previousExpectedHostnames = process.env.TURNSTILE_EXPECTED_HOSTNAMES;

  process.env.TURNSTILE_EXPECTED_HOSTNAMES = "awcms-mini.ahlikoding.com, awcms-mini-admin.ahlikoding.com";

  try {
    const runtimeConfig = getRuntimeConfig();

    assert.deepEqual(runtimeConfig.turnstile.expectedHostnames, [
      "awcms-mini.ahlikoding.com",
      "awcms-mini-admin.ahlikoding.com",
    ]);
  } finally {
    if (previousExpectedHostnames === undefined) delete process.env.TURNSTILE_EXPECTED_HOSTNAMES;
    else process.env.TURNSTILE_EXPECTED_HOSTNAMES = previousExpectedHostnames;
  }
});
