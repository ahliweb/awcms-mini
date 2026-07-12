/**
 * Anonymous visitor-key cookie lifecycle policy (Issue #624 repository
 * audit addendum, 2026-07-11). Pure — no actual cookie/request I/O here;
 * `src/middleware.ts` is the sole caller and translates these decisions
 * into real `context.cookies.set`/`.delete` calls. Separated out from
 * `application/collector.ts` and the middleware itself so this decision
 * is independently unit-testable without Astro's `astro:middleware`
 * virtual module (which `bun test` cannot resolve — see
 * `src/middleware.ts`'s own doc comment on why it isn't directly
 * testable).
 *
 * Two separate functions, matching the two call sites in
 * `src/middleware.ts`:
 *
 * 1. `shouldRevokeVisitorKeyCookie` — called BEFORE the
 *    `shouldCollectRequest` path/area gate, on every request, regardless
 *    of module state. True only when the module's master switch is off
 *    AND a (previously valid) cookie is still present — this is the
 *    "no cookie when disabled" + "revocation" rule from the audit
 *    addendum: a browser that already carries the old persistent
 *    identifier (e.g. from before the module was disabled, or from
 *    before an upgrade that changed the default, see
 *    `docs/awcms-mini/visitor-analytics.md` §Default opt-in dan upgrade
 *    path) has it actively cleared rather than left to linger
 *    indefinitely just because nothing renews it.
 * 2. `planVisitorKeyCookie` — called AFTER that gate has already
 *    confirmed the module is enabled and this specific request will be
 *    collected. Always resolves a usable visitor key (reusing a valid
 *    existing one, minting a fresh one otherwise) and reports whether a
 *    `Set-Cookie` is actually needed, preserving the pre-existing
 *    invariant that the cookie is only ever set on a request that is
 *    actually collected, never on every request. The `maxAgeSeconds` is
 *    operator-configurable (`VISITOR_ANALYTICS_VISITOR_KEY_COOKIE_TTL_DAYS`,
 *    30 days by default) rather than the previous hardcoded 2-year
 *    constant. Once the browser expires the cookie, the next request
 *    has no existing value, so a fresh key is minted — natural rotation
 *    without any additional server-side bookkeeping.
 */
import { resolveVisitorKey, isValidVisitorKey } from "./visitor-key";
import {
  resolveVisitorKeyCookieMaxAgeSeconds,
  type VisitorAnalyticsConfig
} from "./visitor-analytics-config";

export function shouldRevokeVisitorKeyCookie(input: {
  config: Pick<VisitorAnalyticsConfig, "enabled">;
  existingValue: string | undefined;
}): boolean {
  return !input.config.enabled && isValidVisitorKey(input.existingValue);
}

export type VisitorKeyCookiePlan = {
  value: string;
  shouldSetCookie: boolean;
  maxAgeSeconds: number;
};

/**
 * Only meaningful (and only ever called) when the module is enabled and
 * this request is being collected — callers must check
 * `shouldRevokeVisitorKeyCookie` and `shouldCollectRequest` first.
 */
export function planVisitorKeyCookie(input: {
  config: Pick<VisitorAnalyticsConfig, "visitorKeyCookieTtlDays">;
  existingValue: string | undefined;
}): VisitorKeyCookiePlan {
  const { config, existingValue } = input;
  const value = resolveVisitorKey(existingValue);

  return {
    value,
    shouldSetCookie: value !== existingValue,
    maxAgeSeconds: resolveVisitorKeyCookieMaxAgeSeconds(config)
  };
}
