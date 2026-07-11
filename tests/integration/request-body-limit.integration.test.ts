/**
 * Integration tests for the shared capped request-body reader (Issue #686,
 * epic #679, platform-hardening) — proves real end-to-end wiring (route
 * handler -> `readJsonBody` -> `413` response) at a `default`-tier and a
 * `large`-tier endpoint, against the real Astro route handlers. The reader
 * itself (JSON/text/form parsing, the streamed-byte-count path for a
 * chunked/no-`Content-Length` body, the malformed-vs-oversized distinction)
 * is already thoroughly unit-tested in
 * `tests/unit/request-body-limit.test.ts` — this file only needs to prove
 * that real handlers actually call it and actually return `413`, not
 * re-prove the reader's own internals.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as updateSettings } from "../../src/pages/api/v1/settings/index";
import { PATCH as updateBlogTheme } from "../../src/pages/api/v1/blog/theme/index";
import { BODY_SIZE_TIER_BYTES } from "../../src/lib/security/request-body-limit";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-owner-password";

type Bootstrap = { tenantId: string; token: string };

async function bootstrap(): Promise<Bootstrap> {
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme",
      tenantCode: "acme",
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: OWNER_LOGIN,
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
    body: { loginIdentifier: OWNER_LOGIN, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId: setup.body.data.tenantId, token: login.body.data.token };
}

function authHeaders(b: Bootstrap): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": b.tenantId,
    authorization: `Bearer ${b.token}`
  };
}

const suite = integrationEnabled ? describe : describe.skip;

suite(
  "Request body size limits (Issue #686, epic #679) — real endpoints",
  () => {
    beforeAll(async () => {
      await applyMigrations();
      await provisionAppRole();
    });

    beforeEach(async () => {
      await resetDatabase();
    });

    test("PATCH /api/v1/settings (default tier): a body declaring more than 128 KiB is rejected 413, never reaches the handler's own validation", async () => {
      const b = await bootstrap();
      const oversizedPayload = "a".repeat(BODY_SIZE_TIER_BYTES.default + 1);

      const response = await invoke<{ error: { code: string } }>(
        updateSettings,
        {
          method: "PATCH",
          path: "/api/v1/settings",
          headers: authHeaders(b),
          body: { defaultLocale: oversizedPayload }
        }
      );

      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    });

    test("PATCH /api/v1/settings (default tier): a boundary-size-safe valid body still reaches the handler and is validated normally", async () => {
      const b = await bootstrap();

      // Deliberately NOT close to the 128 KiB boundary here — asserting the
      // exact boundary byte-for-byte is the unit suite's job
      // (tests/unit/request-body-limit.test.ts); this only proves an
      // ordinary small valid PATCH still reaches real validation and isn't
      // accidentally caught by the new size check.
      const response = await invoke<{ error: { code: string } }>(
        updateSettings,
        {
          method: "PATCH",
          path: "/api/v1/settings",
          headers: authHeaders(b),
          body: { defaultLocale: "not-a-real-locale-code" }
        }
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    test("PATCH /api/v1/blog/theme (large tier): a body within the default tier but under the large tier is NOT rejected as too-large", async () => {
      const b = await bootstrap();
      // Bigger than the default tier (128 KiB) but well under the large tier
      // (5 MiB) — proves this endpoint is actually wired to the "large" tier,
      // not silently defaulting to "default".
      const midSizedValue = "a".repeat(BODY_SIZE_TIER_BYTES.default + 1024);

      const response = await invoke<{ error: { code: string } }>(
        updateBlogTheme,
        {
          method: "PATCH",
          path: "/api/v1/blog/theme",
          headers: authHeaders(b),
          body: { mode: midSizedValue }
        }
      );

      expect(response.status).not.toBe(413);
    });

    test("PATCH /api/v1/blog/theme (large tier): a body declaring more than 5 MiB is still rejected 413", async () => {
      const b = await bootstrap();
      const oversizedPayload = "a".repeat(BODY_SIZE_TIER_BYTES.large + 1);

      const response = await invoke<{ error: { code: string } }>(
        updateBlogTheme,
        {
          method: "PATCH",
          path: "/api/v1/blog/theme",
          headers: authHeaders(b),
          body: { mode: oversizedPayload }
        }
      );

      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  }
);
