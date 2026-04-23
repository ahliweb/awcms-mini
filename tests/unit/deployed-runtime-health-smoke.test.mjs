import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_EDGE_HEALTH_PATH,
  evaluateDeployedRuntimeHealthResponse,
  runDeployedRuntimeHealthSmokeTest,
} from "../../scripts/smoke-deployed-runtime-health.mjs";

test("evaluateDeployedRuntimeHealthResponse accepts the reviewed Hyperdrive payload", async () => {
  const response = new Response(
    JSON.stringify({
      ok: true,
      version: "v1",
      service: "awcms-mini-edge-api",
      checks: {
        database: {
          ok: true,
          posture: {
            transport: "hyperdrive",
            binding: "HYPERDRIVE",
            source: "Cloudflare Hyperdrive binding",
          },
        },
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    },
  );

  const result = await evaluateDeployedRuntimeHealthResponse(response, {
    transport: "hyperdrive",
    hostname: null,
    sslmode: null,
    binding: "HYPERDRIVE",
  });

  assert.equal(result.ok, true);
});

test("evaluateDeployedRuntimeHealthResponse rejects unexpected database posture", async () => {
  const response = new Response(
    JSON.stringify({
      ok: true,
      checks: {
        database: {
          ok: true,
          posture: {
            transport: "direct",
            hostname: "id1.ahlikoding.com",
          },
        },
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    },
  );

  const result = await evaluateDeployedRuntimeHealthResponse(response, {
    transport: "hyperdrive",
    hostname: null,
    sslmode: null,
    binding: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "unexpected_database_posture");
});

test("runDeployedRuntimeHealthSmokeTest checks the reviewed edge health endpoint", async () => {
  const result = await runDeployedRuntimeHealthSmokeTest({
    baseUrl: new URL("https://awcms-mini.ahlikoding.com"),
    env: {
      HEALTHCHECK_EXPECT_DATABASE_TRANSPORT: "hyperdrive",
      HEALTHCHECK_EXPECT_HYPERDRIVE_BINDING: "HYPERDRIVE",
    },
    fetchImpl: async (input) => {
      assert.equal(String(input), `https://awcms-mini.ahlikoding.com${DEFAULT_EDGE_HEALTH_PATH}`);

      return new Response(
        JSON.stringify({
          ok: true,
          checks: {
            database: {
              ok: true,
              posture: {
                transport: "hyperdrive",
                binding: "HYPERDRIVE",
                source: "Cloudflare Hyperdrive binding",
              },
            },
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        },
      );
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.edgeHealth.ok, true);
});
