const AUTHORIZATION_CACHE_TTL_MS = 5 * 60 * 1000;

const AUTHORIZATION_INVALIDATION_EVENTS = [
  "role_changed",
  "permission_changed",
  "job_assignment_changed",
  "region_assignment_changed",
  "user_status_changed",
  "two_factor_changed",
];

function createAuthorizationCacheKey(input = {}) {
  return [
    "authorization",
    input.scope ?? "evaluation",
    input.user_id ?? "anonymous",
    input.session_id ?? "none",
    input.permission_code ?? "none",
  ].join(":");
}

function createAuthorizationInvalidationEvent(input = {}) {
  const type = String(input.type ?? "");

  if (!AUTHORIZATION_INVALIDATION_EVENTS.includes(type)) {
    throw new TypeError(`Unknown authorization invalidation event: ${type}`);
  }

  return {
    type,
    user_id: input.user_id ? String(input.user_id) : null,
    session_id: input.session_id ? String(input.session_id) : null,
    role_id: input.role_id ? String(input.role_id) : null,
    permission_id: input.permission_id ? String(input.permission_id) : null,
    occurred_at: input.occurred_at ? String(input.occurred_at) : new Date().toISOString(),
    details: input.details && typeof input.details === "object" && !Array.isArray(input.details) ? input.details : {},
  };
}

function createAuthorizationCacheEntry(value, options = {}) {
  const createdAt = options.created_at ? String(options.created_at) : new Date().toISOString();
  const ttlMs = Number(options.ttl_ms ?? AUTHORIZATION_CACHE_TTL_MS);
  const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();

  return {
    value,
    created_at: createdAt,
    ttl_ms: ttlMs,
    expires_at: expiresAt,
  };
}

function isAuthorizationCacheEntryFresh(entry, now = Date.now()) {
  if (!entry || !entry.expires_at) {
    return false;
  }

  return Date.parse(entry.expires_at) > now;
}

function createNoopAuthorizationCache() {
  return {
    async get() {
      return null;
    },
    async set() {},
    async invalidate() {},
  };
}

export {
  AUTHORIZATION_CACHE_TTL_MS,
  AUTHORIZATION_INVALIDATION_EVENTS,
  createAuthorizationCacheEntry,
  createAuthorizationCacheKey,
  createAuthorizationInvalidationEvent,
  createNoopAuthorizationCache,
  isAuthorizationCacheEntryFresh,
};
