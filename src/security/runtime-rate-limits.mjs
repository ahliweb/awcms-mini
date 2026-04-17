const DEFAULT_POLICY = Object.freeze({
  maxFailuresPerAccount: 5,
  maxFailuresPerIp: 10,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
});

const store = new Map();

function currentNow(now) {
  return typeof now === "number" ? now : Date.now();
}

function getEntry(scopeKey, now) {
  const current = store.get(scopeKey);

  if (!current) {
    return {
      scopeKey,
      counter: 0,
      windowStartsAt: currentNow(now),
      lockedUntil: null,
    };
  }

  return { ...current };
}

function persistEntry(entry) {
  store.set(entry.scopeKey, entry);
  return entry;
}

function advanceWindowIfExpired(entry, policy, now) {
  if (currentNow(now) - entry.windowStartsAt >= policy.windowMs) {
    entry.counter = 0;
    entry.windowStartsAt = currentNow(now);
    entry.lockedUntil = null;
  }

  return entry;
}

export function createRuntimeRateLimitStore(options = {}) {
  const policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };

  return {
    getPolicy() {
      return { ...policy };
    },

    inspect(scopeKey, now = Date.now()) {
      const entry = advanceWindowIfExpired(getEntry(scopeKey, now), policy, now);
      return {
        scopeKey,
        counter: entry.counter,
        windowStartsAt: entry.windowStartsAt,
        lockedUntil: entry.lockedUntil,
        locked: entry.lockedUntil !== null && entry.lockedUntil > currentNow(now),
      };
    },

    increment(scopeKey, threshold, now = Date.now()) {
      const entry = advanceWindowIfExpired(getEntry(scopeKey, now), policy, now);
      entry.counter += 1;

      if (entry.counter >= threshold) {
        entry.lockedUntil = currentNow(now) + policy.lockoutMs;
      }

      persistEntry(entry);

      return {
        scopeKey,
        counter: entry.counter,
        windowStartsAt: entry.windowStartsAt,
        lockedUntil: entry.lockedUntil,
        locked: entry.lockedUntil !== null && entry.lockedUntil > currentNow(now),
      };
    },

    reset(scopeKey) {
      store.delete(scopeKey);
    },

    clearAll() {
      store.clear();
    },
  };
}

export const runtimeRateLimitStore = createRuntimeRateLimitStore();
export { DEFAULT_POLICY };
