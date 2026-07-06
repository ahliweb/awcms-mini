/**
 * Generic in-process rate limiter (Issue #437 — security hardening, OWASP
 * A04/A07, ASVS V2/V11, doc 20 §Kontrol keamanan berlapis "Ketersediaan").
 *
 * `awcms_mini_identities.failed_login_count` (see
 * `src/modules/identity-access/domain/login-policy.ts`) already locks out a
 * *single identity* after N consecutive bad passwords — but it does nothing
 * against an attacker who rotates `loginIdentifier` values from the same
 * source (username enumeration / credential-stuffing across many accounts),
 * since each identity's own counter never crosses the threshold. This is a
 * complementary, source-scoped backstop for that gap: a fixed-window counter
 * keyed by whatever the caller considers "the same source" (typically
 * `${clientIp}:${tenantId}` for the login endpoint — see
 * `src/pages/api/v1/auth/login.ts`).
 *
 * Deliberately simple (fixed window, not sliding log/token bucket) to match
 * this repo's existing style (`login-policy.ts`'s lockout is equally
 * simple) and because doc 20 §Batasan already assigns WAF/edge rate
 * limiting to the deployment layer — this is app-level defense-in-depth on
 * top of that, not a replacement for it.
 *
 * Known limitation (documented, not hidden): the counter is an in-process
 * `Map`, so it is per-instance. A horizontally-scaled deployment (multiple
 * app processes/containers behind a load balancer) would not share state
 * across instances — each instance enforces its own window independently.
 * Acceptable for this repo's default LAN-first single-instance topology
 * (doc 18 §Topologi deployment); a multi-instance deployment wanting a
 * shared limit should front the app with an edge/proxy rate limiter instead
 * (doc 20 §Batasan already scopes that to the deployment layer).
 */

export type RateLimitConfig = {
  /** Max attempts allowed within the window (the (maxAttempts + 1)th is denied). */
  maxAttempts: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export type RateLimitResult =
  { allowed: true } | { allowed: false; retryAfterSec: number };

type Bucket = {
  count: number;
  windowStart: number;
};

const buckets = new Map<string, Bucket>();

/**
 * Fixed-window counter: the first call for a key starts a new window; every
 * subsequent call within `windowMs` increments the count; once the count
 * exceeds `maxAttempts` the call is denied until the window rolls over.
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig,
  now: number = Date.now()
): RateLimitResult {
  const existing = buckets.get(key);

  if (!existing || now - existing.windowStart >= config.windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }

  existing.count += 1;

  if (existing.count > config.maxAttempts) {
    const remainingMs = config.windowMs - (now - existing.windowStart);
    const retryAfterSec = Math.max(1, Math.ceil(remainingMs / 1000));
    return { allowed: false, retryAfterSec };
  }

  return { allowed: true };
}

/** Test-only: clears all bucket state so test files don't bleed into each other. */
export function resetRateLimitStoreForTests(): void {
  buckets.clear();
}

/**
 * Best-effort client IP resolution for the rate-limit key. Prefers the
 * standard `X-Forwarded-For` header (set by the optional nginx reverse proxy
 * template, `deploy/nginx/awcms-mini.conf.example`) — first entry is the
 * original client — falling back to Astro's `clientAddress` (direct
 * connection, no proxy in front), then a fixed placeholder when neither is
 * available (e.g. a synthetic test context with no socket/proxy info at
 * all). The placeholder intentionally still varies per rate-limit key
 * because callers combine it with other context (e.g. tenant ID) — see
 * `src/pages/api/v1/auth/login.ts`.
 */
export function resolveClientIp(
  request: Request,
  clientAddress: string | undefined
): string {
  const forwardedFor = request.headers.get("x-forwarded-for");

  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();

    if (first) {
      return first;
    }
  }

  if (clientAddress) {
    return clientAddress;
  }

  return "unknown";
}
