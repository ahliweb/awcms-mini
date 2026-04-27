/**
 * CORS middleware — applies cross-origin policy based on `CORS_ALLOWED_ORIGINS`
 * (comma-separated) or the value from runtimeConfig.edgeApi.allowedOrigins.
 *
 * Same-origin requests are always allowed. Requests from unlisted origins
 * receive no CORS headers, which browsers treat as a CORS failure.
 */

import { createMiddleware } from "hono/factory";

function parseAllowedOrigins(options) {
  const fromConfig = options.runtimeConfig?.edgeApi?.allowedOrigins;
  if (Array.isArray(fromConfig) && fromConfig.length > 0) {
    return fromConfig;
  }

  const fromEnv = process.env.CORS_ALLOWED_ORIGINS ?? "";
  return fromEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {{ runtimeConfig?: import('../types.mjs').RuntimeConfig }} [options]
 */
export function middlewareCors(options = {}) {
  return createMiddleware(async (c, next) => {
    const allowedOrigins = parseAllowedOrigins(options);
    const origin = c.req.header("origin");

    // Preflight
    if (c.req.method === "OPTIONS" && origin) {
      if (allowedOrigins.includes(origin)) {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id",
            "Access-Control-Max-Age": "600",
            Vary: "Origin",
          },
        });
      }

      return new Response(null, { status: 204 });
    }

    await next();

    // Append CORS headers for allowed cross-origin requests
    if (origin && allowedOrigins.includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
    }
  });
}
