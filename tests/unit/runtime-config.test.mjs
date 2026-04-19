import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_DATABASE_CONNECT_TIMEOUT_MS, getRuntimeConfig } from "../../src/config/runtime.mjs";

test("getRuntimeConfig defaults databaseConnectTimeoutMs to the reviewed fail-fast value", async () => {
  const previous = process.env.DATABASE_CONNECT_TIMEOUT_MS;
  delete process.env.DATABASE_CONNECT_TIMEOUT_MS;

  try {
    const config = getRuntimeConfig();
    assert.equal(config.databaseConnectTimeoutMs, DEFAULT_DATABASE_CONNECT_TIMEOUT_MS);
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_CONNECT_TIMEOUT_MS;
    } else {
      process.env.DATABASE_CONNECT_TIMEOUT_MS = previous;
    }
  }
});

test("getRuntimeConfig accepts an explicit positive DATABASE_CONNECT_TIMEOUT_MS", async () => {
  const previous = process.env.DATABASE_CONNECT_TIMEOUT_MS;
  process.env.DATABASE_CONNECT_TIMEOUT_MS = "4500";

  try {
    const config = getRuntimeConfig();
    assert.equal(config.databaseConnectTimeoutMs, 4500);
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_CONNECT_TIMEOUT_MS;
    } else {
      process.env.DATABASE_CONNECT_TIMEOUT_MS = previous;
    }
  }
});
