/**
 * Security headers middleware — adds conservative security headers to every response.
 * These headers align with the EmDash-first secure-by-default posture.
 */

import { createMiddleware } from "hono/factory";

export function middlewareSecurityHeaders() {
  return createMiddleware(async (c, next) => {
    await next();

    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

    // Cache-Control: API responses should not be cached by default.
    // Individual route handlers may override this for public read endpoints.
    if (!c.res.headers.get("Cache-Control")) {
      c.header("Cache-Control", "no-store");
    }
  });
}
