/**
 * Auth sub-router — /api/v1/auth
 *
 * Placeholder stubs for auth endpoints. Full implementation in #251.
 * Endpoints declared here so the route tree is complete and testable.
 */

import { Hono } from "hono";

import { validateTurnstileToken, TurnstileValidationError } from "../../src/security/turnstile.mjs";
import { createEdgeAuthService, EdgeAuthError } from "../../src/services/edge-auth/service.mjs";
import { createSessionService } from "../../src/services/sessions/service.mjs";

/**
 * @param {object} [options]
 * @returns {Hono}
 */
export function routeApiV1Auth(options = {}) {
  const app = new Hono();
  const edgeAuth =
    options.edgeAuthService ??
    createEdgeAuthService({
      database: options.database,
      runtimeConfig: options.runtimeConfig,
    });
  const sessions =
    options.sessionService ??
    createSessionService({
      database: options.database,
    });

  // POST /api/v1/auth/login
  app.post("/login", async (c) => {
    let body;

    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "INVALID_BODY", message: "Expected JSON body." } },
        400,
      );
    }

    try {
      await validateTurnstileToken(
        {
          token: body?.turnstileToken,
          expectedAction: "login",
          remoteIp: c.get("clientIp") ?? null,
        },
        {
          runtimeConfig: options.runtimeConfig,
          fetchImpl: options.turnstileFetchImpl,
        },
      );
    } catch (error) {
      if (error instanceof TurnstileValidationError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          403,
        );
      }

      throw error;
    }

    try {
      const result = await edgeAuth.issueTokenPairFromPassword({
        request: c.req.raw,
        email: body?.email,
        password: body?.password,
        code: body?.code,
        recoveryCode: body?.recoveryCode,
      });

      return c.json({ data: result });
    } catch (error) {
      if (error instanceof EdgeAuthError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }

      throw error;
    }
  });

  // POST /api/v1/auth/logout
  app.post("/logout", async (c) => {
    const activeSession = c.get("activeSession");

    if (!activeSession?.id) {
      return c.json(
        { error: { code: "NOT_AUTHENTICATED", message: "Not authenticated." } },
        401,
      );
    }

    const revoked = await sessions.revokeSession(activeSession.id);
    await edgeAuth.revokeSessionTokens(
      activeSession.id,
      revoked?.revoked_at ?? undefined,
    );

    return c.json({
      data: {
        success: true,
        session: {
          id: revoked?.id ?? activeSession.id,
          revokedAt: revoked?.revoked_at ?? null,
        },
      },
    });
  });

  // POST /api/v1/auth/refresh
  app.post("/refresh", async (c) => {
    let body;

    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "INVALID_BODY", message: "Expected JSON body." } },
        400,
      );
    }

    try {
      const result = await edgeAuth.refreshTokenPair({
        refreshToken: body?.refreshToken,
        request: c.req.raw,
      });

      return c.json({ data: result });
    } catch (error) {
      if (error instanceof EdgeAuthError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }

      throw error;
    }
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
