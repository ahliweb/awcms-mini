/**
 * Auth sub-router — /api/v1/auth
 *
 * Placeholder stubs for auth endpoints. Full implementation in #251.
 * Endpoints declared here so the route tree is complete and testable.
 */

import { Hono } from "hono";

/**
 * @param {object} [options]
 * @returns {Hono}
 */
export function routeApiV1Auth(options = {}) {
  const app = new Hono();

  // POST /api/v1/auth/login
  app.post("/login", (c) => {
    return c.json({ error: { code: "NOT_IMPLEMENTED", message: "Not yet implemented." } }, 501);
  });

  // POST /api/v1/auth/logout
  app.post("/logout", (c) => {
    return c.json({ error: { code: "NOT_IMPLEMENTED", message: "Not yet implemented." } }, 501);
  });

  // GET /api/v1/auth/me
  app.get("/me", (c) => {
    const user = c.get("authUser");
    const activeSession = c.get("activeSession");

    if (!user?.id) {
      return c.json(
        { error: { code: "NOT_AUTHENTICATED", message: "Not authenticated." } },
        401,
      );
    }

    return c.json({
      data: {
        user: {
          id: user.id,
          email: user.email ?? null,
          name: user.name ?? user.display_name ?? null,
          avatarUrl: user.avatar_url ?? null,
          status: user.status ?? null,
        },
        session: activeSession
          ? {
              id: activeSession.id,
              trustedDevice: activeSession.trusted_device === true,
              expiresAt: activeSession.expires_at ?? null,
              lastSeenAt: activeSession.last_seen_at ?? null,
            }
          : null,
      },
    });
  });

  return app;
}
