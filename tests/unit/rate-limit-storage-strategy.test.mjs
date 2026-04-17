import test from "node:test";
import assert from "node:assert/strict";

import {
  getRateLimitStorageStrategy,
  RATE_LIMIT_STORAGE_STRATEGY,
} from "../../src/security/rate-limit-storage-strategy.mjs";

test("rate-limit storage strategy explicitly delegates counters to runtime storage", () => {
  assert.equal(RATE_LIMIT_STORAGE_STRATEGY.kind, "runtime-middleware");
  assert.equal(RATE_LIMIT_STORAGE_STRATEGY.durable_table_required, false);
  assert.deepEqual(RATE_LIMIT_STORAGE_STRATEGY.scope_dimensions, ["ip", "account", "route"]);
  assert.deepEqual(RATE_LIMIT_STORAGE_STRATEGY.required_capabilities, ["increment", "read", "reset", "ttl"]);
  assert.equal(RATE_LIMIT_STORAGE_STRATEGY.fallback_behavior, "fail-closed-on-security-sensitive-routes");
});

test("getRateLimitStorageStrategy returns the shared immutable contract", () => {
  assert.equal(getRateLimitStorageStrategy(), RATE_LIMIT_STORAGE_STRATEGY);
  assert.equal(Object.isFrozen(RATE_LIMIT_STORAGE_STRATEGY), true);
});
