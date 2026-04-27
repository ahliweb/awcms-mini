/**
 * Trusted proxy middleware — extracts the real client IP from the appropriate
 * header based on `TRUSTED_PROXY_MODE`.
 *
 * Supported modes:
 * - `cloudflare` — reads `CF-Connecting-IP` (set by Cloudflare edge for all proxied requests)
 * - `direct`     — uses the socket remote address directly
 *
 * The resolved IP is stored as `c.get('clientIp')`.
 */

import { createMiddleware } from "hono/factory";

/**
 * @param {{ runtimeConfig?: import('../types.mjs').RuntimeConfig }} [options]
 */
export function middlewareTrustedProxy(options = {}) {
  return createMiddleware(async (c, next) => {
    const mode = options.runtimeConfig?.trustedProxyMode ?? process.env.TRUSTED_PROXY_MODE ?? "direct";

    let clientIp = null;

    if (mode === "cloudflare") {
      clientIp = c.req.header("cf-connecting-ip") ?? null;
    }

    if (!clientIp) {
      // Fall back to the raw socket address via the standard header set by @hono/node-server
      clientIp = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    }

    c.set("clientIp", clientIp);
    await next();
  });
}
