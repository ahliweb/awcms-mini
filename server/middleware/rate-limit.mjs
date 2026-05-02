import { createMiddleware } from "hono/factory";

const COUNTERS = new Map();

function getWindowMs() {
  const seconds = Number.parseInt(String(process.env.EDGE_API_RATE_LIMIT_WINDOW_SECONDS ?? "60"), 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000;
}

function getMaxRequests() {
  const max = Number.parseInt(String(process.env.EDGE_API_RATE_LIMIT_MAX_REQUESTS ?? "120"), 10);
  return Number.isFinite(max) && max > 0 ? max : 120;
}

function getKey(c) {
  const ip = c.get("clientIp") ?? "unknown";
  return `${ip}:${c.req.path}`;
}

export function middlewareRateLimit() {
  const windowMs = getWindowMs();
  const maxRequests = getMaxRequests();

  return createMiddleware(async (c, next) => {
    const key = getKey(c);
    const now = Date.now();
    const current = COUNTERS.get(key);

    if (!current || current.expiresAt <= now) {
      COUNTERS.set(key, { count: 1, expiresAt: now + windowMs });
      await next();
      return;
    }

    if (current.count >= maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((current.expiresAt - now) / 1000));
      c.header("Retry-After", String(retryAfter));
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests. Please retry later.",
            details: {
              retryAfterSeconds: retryAfter,
            },
          },
        },
        429,
      );
    }

    current.count += 1;
    COUNTERS.set(key, current);
    await next();
  });
}
