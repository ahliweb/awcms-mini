import { defineMiddleware } from "astro:middleware";

import { resolveSsrContext } from "./lib/auth/ssr-session";

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

  if (!context.url.pathname.startsWith(PROTECTED_PREFIX)) {
    const response = await next();

    response.headers.set(CORRELATION_ID_HEADER, context.locals.correlationId);

    return response;
  }

  const ssrContext = await resolveSsrContext(context.cookies, new Date());

  if (!ssrContext) {
    return context.redirect("/login");
  }

  context.locals.ssrContext = ssrContext;

  const response = await next();

  response.headers.set(CORRELATION_ID_HEADER, context.locals.correlationId);

  return response;
});
