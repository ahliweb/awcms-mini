/**
 * HTTP cache policy — the application half of the Varnish edge cache.
 *
 * ## Why the policy lives here and not only in VCL
 *
 * Before this module the app emitted NO `Cache-Control` header on any
 * response. That is safe only for as long as nothing sits in front of it: put
 * any shared cache — Varnish, a CDN, a corporate proxy — in the path and it
 * falls back to its own heuristics, which for a 200 GET generally means "cache
 * it". In a tenant-isolated app whose tenant is resolved from the request Host
 * and whose authorization is per-session, that is precisely how one tenant's
 * page ends up served to another.
 *
 * So the cacheability decision is made HERE, by the code that knows whether a
 * response contains tenant- or user-scoped data, and the edge merely obeys.
 * `deploy/varnish/default.vcl` caches nothing this module has not marked.
 *
 * ## Default deny
 *
 * `ensureDefaultCachePolicy` runs in the one middleware chokepoint every
 * response passes through, and stamps `no-store` on anything that did not
 * explicitly opt in. A route author who knows nothing about caching gets the
 * safe behaviour by omission; making a response cacheable is a deliberate act.
 * This mirrors the RLS/ABAC posture the rest of the codebase already takes.
 *
 * ## Two cacheable classes, and why `private` is not enough for the second
 *
 * - `public` — anonymous, tenant-scoped, identical for every visitor of that
 *   host. Blog and news pages. Emitted as a normal
 *   `Cache-Control: public, max-age=N`, so browsers and any CDN may also store
 *   it. The Host is part of the edge cache key, so one tenant's page can never
 *   satisfy another tenant's request.
 *
 * - `session` — depends on WHO is asking (an admin list, a dashboard). The
 *   request was authenticated and the response is user-scoped, so it must
 *   never enter a cache we do not control. Expressing that as
 *   `Cache-Control: private, max-age=N` would be wrong in a specific and
 *   dangerous way: `private` permits a *browser* cache, and some intermediaries
 *   treat it loosely, yet it gives our own edge no instruction at all.
 *
 *   Instead these responses carry `Cache-Control: private, no-store` — the
 *   strictest thing every generic cache understands — plus a separate
 *   `X-AWCMS-Edge-Cache` header that ONLY our Varnish reads, and which Varnish
 *   strips before delivering. Every cache except ours is told "do not store";
 *   ours is told "store, keyed by session". This is the same shape as
 *   `Surrogate-Control`.
 *
 * The session cache key includes the session token, so two users of the same
 * tenant never share an entry. That does mean a logged-in visitor gets their
 * own copy of an otherwise-public page; the duplication is the price of the
 * isolation, and it is deliberate.
 */

/** Read by `deploy/varnish/default.vcl`, stripped there before delivery. */
export const EDGE_CACHE_HEADER = "X-AWCMS-Edge-Cache";

/**
 * Ceiling on any edge TTL. Session-scoped responses reflect authorization
 * state — role changes, suspensions, entitlement expiry — and a stale
 * authorized page is a security problem, not a freshness annoyance. Short
 * enough that revocation takes effect within a minute even if invalidation is
 * missed entirely.
 */
export const MAX_EDGE_MAX_AGE_SECONDS = 60;

/** Ceiling on `public` responses, which carry no authorization state. */
export const MAX_PUBLIC_MAX_AGE_SECONDS = 300;

export type CachePolicy =
  | { kind: "no-store" }
  | { kind: "public"; maxAgeSeconds: number }
  | { kind: "session"; maxAgeSeconds: number };

export const NO_STORE_POLICY: CachePolicy = { kind: "no-store" };

/**
 * Clamp rather than reject: a caller asking for a longer TTL than the class
 * allows gets the safe value. Throwing would turn a caching mistake into an
 * outage, and silently honouring it would turn a typo into a stale-authz bug.
 */
function clampMaxAge(requested: number, ceiling: number): number {
  if (!Number.isFinite(requested) || requested <= 0) {
    return 0;
  }
  return Math.min(Math.floor(requested), ceiling);
}

export type CachePolicyHeaders = {
  cacheControl: string;
  /** Absent for `no-store` and `public` — only our own edge caches by session. */
  edgeCache?: string;
};

export function cachePolicyHeaders(policy: CachePolicy): CachePolicyHeaders {
  if (policy.kind === "public") {
    const maxAge = clampMaxAge(
      policy.maxAgeSeconds,
      MAX_PUBLIC_MAX_AGE_SECONDS
    );
    if (maxAge === 0) {
      return { cacheControl: "private, no-store" };
    }
    return { cacheControl: `public, max-age=${maxAge}` };
  }

  if (policy.kind === "session") {
    const maxAge = clampMaxAge(policy.maxAgeSeconds, MAX_EDGE_MAX_AGE_SECONDS);
    if (maxAge === 0) {
      return { cacheControl: "private, no-store" };
    }
    // Note the deliberate combination: every generic cache is told no-store,
    // and only our edge is told otherwise.
    return {
      cacheControl: "private, no-store",
      edgeCache: `session; max-age=${maxAge}`
    };
  }

  return { cacheControl: "private, no-store" };
}

/**
 * Mark a response with an explicit policy. Overwrites whatever was there, so
 * a route can always tighten or loosen its own response.
 */
export function applyCachePolicy(
  response: Response,
  policy: CachePolicy
): Response {
  const headers = cachePolicyHeaders(policy);
  response.headers.set("Cache-Control", headers.cacheControl);

  if (headers.edgeCache === undefined) {
    response.headers.delete(EDGE_CACHE_HEADER);
  } else {
    response.headers.set(EDGE_CACHE_HEADER, headers.edgeCache);
  }

  return response;
}

/**
 * The default-deny half, called from the middleware chokepoint for every
 * response. Leaves an explicit policy alone and stamps `no-store` on
 * everything else.
 *
 * A response that carries `Set-Cookie` is forced back to `no-store` even if it
 * asked to be cached: a cached `Set-Cookie` hands one visitor's session,
 * locale, or tenant selection to the next. This is the one case where a
 * route's explicit request is overridden, because there is no legitimate
 * reason to cache a response that establishes identity.
 */
export function ensureDefaultCachePolicy(response: Response): Response {
  if (response.headers.has("Set-Cookie")) {
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.delete(EDGE_CACHE_HEADER);
    return response;
  }

  if (!response.headers.has("Cache-Control")) {
    response.headers.set("Cache-Control", "private, no-store");
  }

  return response;
}
