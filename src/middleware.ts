import { defineMiddleware } from "astro:middleware";

import { resolveSsrContext } from "./lib/auth/ssr-session";
import { resolveRequestLocale } from "./lib/i18n/request-locale";
import { LOCALE_COOKIE_NAME, resolveLocale } from "./lib/i18n/locale";
import { buildSecurityHeaders } from "./lib/security/security-headers";

const PROTECTED_PREFIX = "/admin";
const CORRELATION_ID_HEADER = "X-Correlation-ID";

/**
 * Correlation ID propagation (Issue 10.1 — Add Structured Logging and Audit
 * Trail, doc 10 §Domain event envelope / §Audit helper). Runs for *every*
 * request, additive to the `/admin/*` guard below: reads an incoming
 * `X-Correlation-ID` request header if present, otherwise generates one, and
 * stashes it on `context.locals.correlationId` (typed in `src/env.d.ts`) so
 * downstream handlers can thread it into audit events, log lines, and the
 * `ApiMeta.correlationId` response field without re-deriving it. Also set on
 * the outgoing response so a caller that didn't send one can still capture
 * it for later trace lookups.
 */
function resolveCorrelationId(request: Request): string {
  const incoming = request.headers.get(CORRELATION_ID_HEADER);

  return incoming && incoming.trim().length > 0
    ? incoming
    : crypto.randomUUID();
}

/**
 * Applies the response headers that must be present on *every* response
 * (Issue 10.1's correlation ID, Issue #437's security headers) — factored
 * out so both the pre-auth and `/admin/*` branches below apply them
 * identically instead of duplicating the header-setting calls. The security
 * headers (CSP/X-Frame-Options/etc., `src/lib/security/security-headers.ts`)
 * need no per-request input — the CSP's one inline-script allowance is a
 * build-time SHA-256 hash of a static string, not a per-request nonce (see
 * that module's doc comment for why a nonce was tried and abandoned).
 */
function applyResponseHeaders(
  response: Response,
  correlationId: string
): Response {
  response.headers.set(CORRELATION_ID_HEADER, correlationId);

  for (const [name, value] of buildSecurityHeaders({
    isProduction: process.env.APP_ENV === "production"
  })) {
    response.headers.set(name, value);
  }

  return response;
}

/**
 * Guards `/admin/*` (Issue 8.1 — Build Admin Layout Shell).
 *
 * Found during live verification: returning `Astro.redirect(...)` from
 * inside `AdminLayout.astro` (a nested component rendered *within* a page,
 * not the page itself) throws `ResponseSentError` — Astro's SSR streaming
 * has already started flushing the page's own output by the time a nested
 * component's frontmatter resolves, so the render pipeline cannot swap in
 * a redirect response at that point. Middleware runs *before* any
 * rendering starts, so redirecting here is the officially-supported,
 * stream-safe place to do it. The resolved context is stashed on
 * `context.locals.ssrContext` (typed in `src/env.d.ts`) so `AdminLayout`
 * doesn't need to re-run the session lookup.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.correlationId = resolveCorrelationId(context.request);
  // Cookie-only resolution (no DB call) for every request — good enough for
  // pre-auth pages (`/`, `/login`) where no tenant is known yet. Re-resolved
  // with the tenant's `default_locale` as an additional fallback below, once
  // `ssrContext` is available for `/admin/*` routes (doc 14
  // §Internationalization precedence: cookie -> tenant default -> `en`).
  context.locals.locale = resolveRequestLocale(context.cookies);

  if (!context.url.pathname.startsWith(PROTECTED_PREFIX)) {
    const response = await next();

    return applyResponseHeaders(response, context.locals.correlationId);
  }

  const ssrContext = await resolveSsrContext(context.cookies, new Date());

  if (!ssrContext) {
    return context.redirect("/login");
  }

  context.locals.ssrContext = ssrContext;
  // Must happen here, before `next()` renders any /admin/* page: a page's own
  // frontmatter (and its own `t()` calls) runs before the AdminLayout
  // component it's nested in, so resolving the tenant fallback inside the
  // layout would be too late for the page's own translations (found during
  // live verification — a legacy tenant with default_locale='id' rendered
  // its shell in Indonesian but its dashboard content in English).
  context.locals.locale = resolveLocale({
    cookieLocale: context.cookies.get(LOCALE_COOKIE_NAME)?.value ?? null,
    tenantDefaultLocale: ssrContext.tenantDefaultLocale
  });

  const response = await next();

  return applyResponseHeaders(response, context.locals.correlationId);
});
