import test from "node:test";
import assert from "node:assert/strict";

import { applyLocalCloudflareRuntimeEnv } from "../../scripts/_local-env.mjs";

test("applyLocalCloudflareRuntimeEnv derives the local Hyperdrive connection string from DATABASE_URL", async () => {
  const env = {
    DATABASE_URL: "postgres://postgres:postgres@localhost:55432/awcms_mini_dev",
  };

  applyLocalCloudflareRuntimeEnv(env);

  assert.equal(
    env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,
    "postgres://postgres:postgres@localhost:55432/awcms_mini_dev",
  );
});

test("applyLocalCloudflareRuntimeEnv preserves an explicit local Hyperdrive override", async () => {
  const env = {
    DATABASE_URL: "postgres://postgres:postgres@localhost:55432/awcms_mini_dev",
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: "postgres://override:override@localhost:55432/override",
  };

  applyLocalCloudflareRuntimeEnv(env);

  assert.equal(
    env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,
    "postgres://override:override@localhost:55432/override",
  );
});
