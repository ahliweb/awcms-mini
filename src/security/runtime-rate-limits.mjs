import { getDatabase } from "../db/index.mjs";
import { createRateLimitCounterRepository } from "../db/repositories/rate-limit-counters.mjs";

const DEFAULT_POLICY = Object.freeze({
  maxFailuresPerAccount: 5,
  maxFailuresPerIp: 10,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
});

function currentNow(now) {
  return typeof now === "number" ? now : Date.now();
}

function toIsoString(value) {
  return new Date(value).toISOString();
}

function createFreshEntry(scopeKey, now) {
  return {
    scopeKey,
    counter: 0,
    windowStartsAt: currentNow(now),
    lockedUntil: null,
  };
}

function normalizeStoredEntry(scopeKey, row) {
  if (!row) {
    return undefined;
  }

  return {
    scopeKey,
    counter: Number(row.counter ?? 0),
    windowStartsAt: Date.parse(row.window_starts_at),
    lockedUntil: row.locked_until ? Date.parse(row.locked_until) : null,
    expiresAt: Date.parse(row.expires_at),
  };
}

function advanceWindowIfExpired(entry, policy, now) {
  if (currentNow(now) - entry.windowStartsAt >= policy.windowMs) {
    entry.counter = 0;
    entry.windowStartsAt = currentNow(now);
    entry.lockedUntil = null;
  }

  return entry;
}

function serializeEntry(entry, now, policy) {
  const expiresAt = Math.max(entry.lockedUntil ?? 0, entry.windowStartsAt + policy.windowMs, currentNow(now));

  return {
    scope_key: entry.scopeKey,
    counter: entry.counter,
    window_starts_at: toIsoString(entry.windowStartsAt),
    locked_until: entry.lockedUntil ? toIsoString(entry.lockedUntil) : null,
    expires_at: toIsoString(expiresAt),
    updated_at: toIsoString(currentNow(now)),
  };
}

function formatInspection(scopeKey, entry, now) {
  return {
    scopeKey,
    counter: entry.counter,
    windowStartsAt: entry.windowStartsAt,
    lockedUntil: entry.lockedUntil,
    locked: entry.lockedUntil !== null && entry.lockedUntil > currentNow(now),
  };
}

export function createRuntimeRateLimitStore(options = {}) {
  const policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
  const repository = options.repository ?? createRateLimitCounterRepository(options.database ?? getDatabase());

  return {
    getPolicy() {
      return { ...policy };
    },

    async inspect(scopeKey, now = Date.now()) {
      await repository.deleteExpiredCounters(toIsoString(currentNow(now)));
      const existing = normalizeStoredEntry(scopeKey, await repository.getCounter(scopeKey));
      const entry = advanceWindowIfExpired(existing ?? createFreshEntry(scopeKey, now), policy, now);

      if (existing && (entry.counter !== existing.counter || entry.windowStartsAt !== existing.windowStartsAt || entry.lockedUntil !== existing.lockedUntil)) {
        await repository.upsertCounter(serializeEntry(entry, now, policy));
      }

      return formatInspection(scopeKey, entry, now);
    },

    async increment(scopeKey, threshold, now = Date.now()) {
      await repository.deleteExpiredCounters(toIsoString(currentNow(now)));
      const entry = advanceWindowIfExpired(
        normalizeStoredEntry(scopeKey, await repository.getCounter(scopeKey)) ?? createFreshEntry(scopeKey, now),
        policy,
        now,
      );

      entry.counter += 1;

      if (entry.counter >= threshold) {
        entry.lockedUntil = currentNow(now) + policy.lockoutMs;
      }

      await repository.upsertCounter(serializeEntry(entry, now, policy));
      return formatInspection(scopeKey, entry, now);
    },

    async reset(scopeKey) {
      await repository.deleteCounter(scopeKey);
    },

    async clearAll(now = Date.now()) {
      await repository.deleteExpiredCounters(toIsoString(currentNow(now) + 365 * 24 * 60 * 60 * 1000));
    },
  };
}

export const runtimeRateLimitStore = createRuntimeRateLimitStore();
export { DEFAULT_POLICY, normalizeStoredEntry, serializeEntry };
