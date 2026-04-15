import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTHORIZATION_CACHE_TTL_MS,
  AUTHORIZATION_INVALIDATION_EVENTS,
  createAuthorizationCacheEntry,
  createAuthorizationCacheKey,
  createAuthorizationInvalidationEvent,
  isAuthorizationCacheEntryFresh,
} from "../../src/services/authorization/cache.mjs";
import { createAuthorizationService } from "../../src/services/authorization/service.mjs";
import { createPermissionResolutionService } from "../../src/services/permissions/service.mjs";

function createMemoryCache() {
  const store = new Map();
  const invalidations = [];

  return {
    store,
    invalidations,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async invalidate(event) {
      invalidations.push(event);
    },
  };
}

test("authorization cache entries use a bounded safety TTL", () => {
  const entry = createAuthorizationCacheEntry({ ok: true }, { created_at: "2026-04-15T00:00:00.000Z" });

  assert.equal(entry.ttl_ms, AUTHORIZATION_CACHE_TTL_MS);
  assert.equal(entry.expires_at, "2026-04-15T00:05:00.000Z");
  assert.equal(isAuthorizationCacheEntryFresh(entry, Date.parse("2026-04-15T00:04:59.000Z")), true);
  assert.equal(isAuthorizationCacheEntryFresh(entry, Date.parse("2026-04-15T00:05:00.000Z")), false);
});

test("authorization invalidation events cover role, job, region, status, and 2fa changes", () => {
  assert.deepEqual(AUTHORIZATION_INVALIDATION_EVENTS, [
    "role_changed",
    "permission_changed",
    "job_assignment_changed",
    "region_assignment_changed",
    "user_status_changed",
    "two_factor_changed",
  ]);

  const event = createAuthorizationInvalidationEvent({
    type: "job_assignment_changed",
    user_id: "user_1",
    details: { supervisor_id: "user_2" },
    occurred_at: "2026-04-15T06:00:00.000Z",
  });

  assert.equal(event.type, "job_assignment_changed");
  assert.equal(event.user_id, "user_1");
  assert.equal(event.details.supervisor_id, "user_2");
});

test("permission resolution service stores and reuses fresh cache entries", async () => {
  const cache = createMemoryCache();
  const service = createPermissionResolutionService({
    cache,
    hooks: {
      async getCachedPermissions() {
        return undefined;
      },
    },
    database: {
      startTransaction() {
        return {
          execute: async () => ({
            selectFrom() {
              throw new Error("database should not be used for cached reads in this test");
            },
            commit() {
              return { execute: async () => {} };
            },
            rollback() {
              return { execute: async () => {} };
            },
            savepoint() {
              return {
                execute: async () => ({
                  releaseSavepoint() {
                    return { execute: async () => {} };
                  },
                  rollbackToSavepoint() {
                    return { execute: async () => {} };
                  },
                }),
              };
            },
          }),
        };
      },
    },
  });

  const cacheKey = createAuthorizationCacheKey({ scope: "effective_permissions", user_id: "user_1" });
  await cache.set(
    cacheKey,
    createAuthorizationCacheEntry({ user_id: "user_1", permission_codes: ["content.posts.read"], cache_hit: false }),
  );

  const resolved = await service.getEffectivePermissions("user_1");
  assert.deepEqual(resolved.permission_codes, ["content.posts.read"]);
  assert.equal(resolved.cache_hit, true);
});

test("authorization service reuses fresh evaluation cache entries", async () => {
  const cache = createMemoryCache();
  const service = createAuthorizationService({
    cache,
    permissionResolver: {
      async getEffectivePermissions() {
        throw new Error("permission resolver should not be used for cached reads in this test");
      },
    },
  });

  const cacheKey = createAuthorizationCacheKey({
    scope: "evaluation",
    user_id: "user_1",
    session_id: "none",
    permission_code: "content.posts.read",
  });
  await cache.set(
    cacheKey,
    createAuthorizationCacheEntry({
      allowed: true,
      permission_code: "content.posts.read",
      matched_rule: "rbac-baseline",
      reason: { code: "ALLOW_RBAC_PERMISSION", message: "cached" },
    }),
  );

  const result = await service.evaluate({
    subject: { kind: "user", user_id: "user_1" },
    context: { permission_code: "content.posts.read", action: "read", session_id: "none" },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason.message, "cached");
});
