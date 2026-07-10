import type { APIContext } from "astro";
import { defineMiddleware } from "astro:middleware";

import { resolveSsrContext } from "./lib/auth/ssr-session";
import { resolveRequestLocale } from "./lib/i18n/request-locale";
import { LOCALE_COOKIE_NAME, resolveLocale } from "./lib/i18n/locale";
import { buildSecurityHeaders } from "./lib/security/security-headers";
import {
  isApiJsonResponseCandidate,
  mergeCorrelationIdIntoApiPayload
} from "./lib/logging/correlation-response";
import { getDatabaseClient } from "./lib/database/client";
import { resolvePublicTenantFromRequest } from "./lib/tenant/public-host-tenant-resolver";
import { log } from "./lib/logging/logger";
import { resolveVisitorAnalyticsConfig } from "./modules/visitor-analytics/domain/visitor-analytics-config";
import { determineArea } from "./modules/visitor-analytics/domain/request-area";
import { resolveVisitorKey } from "./modules/visitor-analytics/domain/visitor-key";
import { resolveAnalyticsClientIp } from "./modules/visitor-analytics/domain/client-ip";
import {
  collectVisitorTelemetry,
  shouldCollectRequest
} from "./modules/visitor-analytics/application/collector";

const PROTECTED_PREFIX = "/admin";
const CORRELATION_ID_HEADER = "X-Correlation-ID";
const VISITOR_KEY_COOKIE_NAME = "awcms_mini_visitor_key";
/** 2 years — a conventional analytics cookie lifetime, same order of magnitude as `VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS`'s default. */
const VISITOR_KEY_COOKIE_MAX_AGE_SECONDS = 63_072_000;

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
 * Full `ApiMeta.correlationId` propagation (Issue #447 — see
 * `src/lib/logging/correlation-response.ts` for why this lives here as one
 * choke point instead of 30+ individual handler edits). Only touches
 * `/api/*` JSON responses, and only when `meta.correlationId` isn't already
 * set by the handler itself. Reads the body via `.clone()` so the original
 * response is never consumed out from under a caller that doesn't need the
 * rewritten one.
 */
async function applyCorrelationIdToApiBody(
  response: Response,
  pathname: string,
  correlationId: string
): Promise<Response> {
  if (
    !isApiJsonResponseCandidate(pathname, response.headers.get("content-type"))
  ) {
    return response;
  }

  let payload: unknown;

  try {
    payload = await response.clone().json();
  } catch {
    // Not actually valid JSON despite the content-type — leave untouched.
    return response;
  }

  const merged = mergeCorrelationIdIntoApiPayload(payload, correlationId);

  if (!merged.changed) {
    return response;
  }

  return new Response(JSON.stringify(merged.payload), {
    status: response.status,
    headers: response.headers
  });
}

/**
 * Visitor telemetry hook (Issue #620, epic: visitor analytics
 * #617-#624). Called after `next()` resolves, on both the pre-admin and
 * `/admin/*` branches below, so `response.status` is already known.
 *
 * BINDING (fail-open, acceptance criterion): this function never throws
 * and never delays the response beyond its own `await` — every failure
 * (cheap config/cookie logic here, or the DB write inside
 * `collectVisitorTelemetry` itself) is caught and logged as a `warning`
 * with `correlationId`, never surfaced to the caller. Tenant resolution
 * and the actual write happen only when `shouldCollectRequest` says so,
 * so most requests (assets, disabled areas, disabled module) pay only
 * the cost of that one cheap pure check.
 *
 * `identityId`/`isAuthenticated` are always server-derived here — `null`/
 * `false` for every non-`/admin` request (public routes never resolve a
 * session in this middleware, see the pre-admin branch below), or
 * `ssrContext`'s own values for `/admin/*` (only reachable after the
 * redirect-to-`/login` guard above has already confirmed a valid
 * session) — never a client-supplied value, closing the cross-tenant
 * existence-oracle risk the Issue #618 security audit flagged ahead of
 * time (recorded in `.claude/skills/awcms-mini-visitor-analytics/SKILL.md`).
 */
async function collectRequestAnalytics(
  context: APIContext,
  response: Response,
  identityId: string | null,
  isAuthenticated: boolean
): Promise<void> {
  try {
    const config = resolveVisitorAnalyticsConfig();
    const pathname = context.url.pathname;
    const area = determineArea(pathname);

    if (!shouldCollectRequest({ pathname, area, config })) {
      return;
    }

    const sql = getDatabaseClient();
    let tenantId: string | null = null;

    if (area === "admin") {
      tenantId = context.locals.ssrContext?.tenantId ?? null;
    } else {
      // Same env vars the tenant-domain-routing epic documents
      // (`PUBLIC_TENANT_RESOLUTION_MODE`/`PUBLIC_TRUST_PROXY`, Issue #556)
      // — best-effort: a request whose tenant cannot be resolved (unknown
      // host, offline/LAN deployment with no public routing configured,
      // etc.) is simply not collected, never a hard failure.
      const resolution = await resolvePublicTenantFromRequest(
        sql,
        context.request,
        {
          mode: process.env.PUBLIC_TENANT_RESOLUTION_MODE,
          trustProxy: process.env.PUBLIC_TRUST_PROXY === "true"
        }
      );
      tenantId = resolution?.tenantId ?? null;
    }

    if (!tenantId) return;

    const existingVisitorKey = context.cookies.get(
      VISITOR_KEY_COOKIE_NAME
    )?.value;
    const visitorKey = resolveVisitorKey(existingVisitorKey);

    if (visitorKey !== existingVisitorKey) {
      context.cookies.set(VISITOR_KEY_COOKIE_NAME, visitorKey, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: VISITOR_KEY_COOKIE_MAX_AGE_SECONDS,
        secure: process.env.AUTH_COOKIE_SECURE === "true"
      });
    }

    let clientAddress: string | undefined;
    try {
      clientAddress = context.clientAddress;
    } catch {
      // Some adapters/dev contexts don't support clientAddress at all —
      // resolveAnalyticsClientIp still falls back to a forwarded header
      // (if trusted) or null.
      clientAddress = undefined;
    }

    const ipAddress = resolveAnalyticsClientIp(context.request, clientAddress, {
      trustProxy: config.trustProxy,
      trustCloudflare: config.trustCloudflare
    });

    await collectVisitorTelemetry({
      sql,
      tenantId,
      correlationId: context.locals.correlationId,
      config,
      method: context.request.method,
      rawPath: `${pathname}${context.url.search}`,
      statusCode: response.status,
      visitorKey,
      ipAddress,
      userAgent: context.request.headers.get("user-agent"),
      referrerHeader: context.request.headers.get("referer"),
      isAuthenticated,
      identityId
    });
  } catch (error) {
    log("warning", "visitor_analytics.middleware.failed", {
      correlationId: context.locals.correlationId,
      moduleKey: "visitor_analytics",
      error: error instanceof Error ? error.message : "unknown error"
    });
  }
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
    const response = await applyCorrelationIdToApiBody(
      await next(),
      context.url.pathname,
      context.locals.correlationId
    );

    await collectRequestAnalytics(context, response, null, false);

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

  await collectRequestAnalytics(context, response, ssrContext.identityId, true);

  return applyResponseHeaders(response, context.locals.correlationId);
});
