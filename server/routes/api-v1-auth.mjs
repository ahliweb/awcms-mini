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
import { createUserService, UserInviteError } from "../../src/services/users/service.mjs";
import {
  createTwoFactorService,
  TwoFactorChallengeError,
} from "../../src/services/security/two-factor.mjs";

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
  const twoFactor =
    options.twoFactorService ??
    createTwoFactorService({
      database: options.database,
      encryptionKey: options.runtimeConfig?.miniTotpEncryptionKey,
    });
  const users = options.userService ?? createUserService({ database: options.database });

  function activationRedirectUrl(requestUrl, params) {
    const url = new URL("/activate", requestUrl);

    for (const [key, value] of Object.entries(params)) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }

    return url.toString();
  }

  function redirect(location, status = 302) {
    return new Response(null, {
      status,
      headers: {
        Location: location,
      },
    });
  }

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

    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!email || !password) {
      return c.json(
        {
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Email and password are required.",
          },
        },
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
        email,
        password,
        code: body?.code,
        recoveryCode: body?.recoveryCode,
      });

      return c.json({ data: result });
    } catch (error) {
      if (error instanceof EdgeAuthError) {
        if (error.code === "TWO_FACTOR_REQUIRED") {
          return c.json(
            {
              error: { code: error.code, message: error.message },
              data: {
                requiresTwoFactor: true,
                challenge: {
                  type: "totp_or_recovery_code",
                },
              },
            },
            error.status,
          );
        }

        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }

      throw error;
    }
  });

  // POST /api/v1/auth/login/verify-2fa
  app.post("/login/verify-2fa", async (c) => {
    let body;

    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "INVALID_BODY", message: "Expected JSON body." } },
        400,
      );
    }

    const email = typeof body?.email === "string" ? body.email : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const recoveryCode =
      typeof body?.recoveryCode === "string" ? body.recoveryCode.trim() : "";

    if (!email.trim() || !password) {
      return c.json(
        {
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Email and password are required.",
          },
        },
        400,
      );
    }

    if (!code && !recoveryCode) {
      return c.json(
        {
          error: {
            code: "INVALID_CODE",
            message: "TOTP code or recovery code is required.",
          },
        },
        400,
      );
    }

    try {
      const result = await edgeAuth.issueTokenPairFromPassword({
        request: c.req.raw,
        email,
        password,
        code,
        recoveryCode,
      });

      return c.json({ data: result });
    } catch (error) {
      if (error instanceof TwoFactorChallengeError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          400,
        );
      }

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

    const refreshToken = typeof body?.refreshToken === "string" ? body.refreshToken.trim() : "";

    if (!refreshToken) {
      return c.json(
        {
          error: {
            code: "INVALID_REFRESH_TOKEN",
            message: "Refresh token is required.",
          },
        },
        400,
      );
    }

    try {
      const result = await edgeAuth.refreshTokenPair({
        refreshToken,
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

  // GET /api/v1/auth/activate
  app.get("/activate", async (c) => {
    const token = String(c.req.query("token") ?? "").trim();

    if (!token) {
      return c.json(
        {
          error: {
            code: "INVALID_TOKEN",
            message: "Activation token is required.",
          },
        },
        400,
      );
    }

    try {
      const activation = await users.getInviteActivation(token);
      return c.json({ data: activation });
    } catch (error) {
      if (error instanceof UserInviteError) {
        return c.json(
          {
            error: {
              code: error.code,
              message: error.message,
            },
          },
          400,
        );
      }

      throw error;
    }
  });

  // POST /api/v1/auth/activate
  app.post("/activate", async (c) => {
    const formData = await c.req.raw.formData();
    const token = typeof formData.get("token") === "string" ? formData.get("token").trim() : "";
    const displayName = typeof formData.get("display_name") === "string" ? formData.get("display_name") : "";
    const password = typeof formData.get("password") === "string" ? formData.get("password") : "";
    const turnstileToken = typeof formData.get("cf-turnstile-response") === "string" ? formData.get("cf-turnstile-response") : "";

    try {
      await validateTurnstileToken(
        {
          token: turnstileToken,
          expectedAction: "invite_activation",
          remoteIp: c.get("clientIp") ?? null,
        },
        {
          runtimeConfig: options.runtimeConfig,
          fetchImpl: options.turnstileFetchImpl,
        },
      );
    } catch (error) {
      if (error instanceof TurnstileValidationError) {
        return redirect(
          activationRedirectUrl(c.req.url, {
            token,
            error: "REQUEST_VERIFICATION_FAILED",
          }),
        );
      }

      throw error;
    }

    try {
      await users.activateInvite({
        token,
        display_name: displayName,
        password,
      });

      return redirect(activationRedirectUrl(c.req.url, { status: "success" }));
    } catch (error) {
      if (error instanceof UserInviteError) {
        return redirect(
          activationRedirectUrl(c.req.url, {
            token,
            error: error.code,
          }),
        );
      }

      throw error;
    }
  });

  return app;
}
