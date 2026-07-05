/// <reference types="astro/client" />

import type { SsrContext } from "./lib/auth/ssr-session";

declare global {
  namespace App {
    interface Locals {
      /**
       * Populated by `src/middleware.ts` for `/admin/*` routes once
       * `resolveSsrContext` (`src/lib/auth/ssr-session.ts`) confirms a valid
       * cookie session. `AdminLayout.astro` reads this instead of calling
       * `resolveSsrContext` a second time and instead of redirecting itself
       * — see `src/middleware.ts` for why the redirect must happen in
       * middleware, not in a nested layout component (Issue 8.1).
       */
      ssrContext?: SsrContext;

      /**
       * Correlation ID for this request (Issue 10.1 — Add Structured
       * Logging and Audit Trail). Populated by `src/middleware.ts` for
       * *every* request: echoes the incoming `X-Correlation-ID` header if
       * present, otherwise a freshly generated `crypto.randomUUID()`.
       * Handlers thread this into audit events, `log()` calls, and
       * `ApiMeta.correlationId` instead of re-deriving it.
       */
      correlationId: string;
    }
  }
}
