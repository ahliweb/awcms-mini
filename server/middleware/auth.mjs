import {
  createEdgeAuthService,
  EdgeAuthError,
} from "../../src/services/edge-auth/service.mjs";

function getBearerToken(c) {
  const authorization = c.req.header("authorization") ?? "";

  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = authorization.slice(7).trim();
  return token.length > 0 ? token : null;
}

function buildActorFromAuthenticated(authenticated) {
  const user = authenticated?.user;

  if (!user?.id) {
    return null;
  }

  return {
    id: user.id,
    user_id: user.id,
    status: user.status ?? "active",
    staff_level: Number(user.staff_level ?? user.active_role_staff_level ?? 0),
    is_protected: user.is_protected === true,
    two_factor_enabled:
      authenticated?.tokenClaims?.two_factor_satisfied === true ||
      authenticated?.activeSession?.two_factor_satisfied === true,
  };
}

export function middlewareOptionalAuth(options = {}) {
  const edgeAuth =
    options.edgeAuthService ??
    createEdgeAuthService({
      database: options.database,
      runtimeConfig: options.runtimeConfig,
    });

  return async (c, next) => {
    const bearerToken = getBearerToken(c);

    if (!bearerToken) {
      await next();
      return;
    }

    try {
      const authenticated = await edgeAuth.authenticateAccessToken(bearerToken);
      const actor = buildActorFromAuthenticated(authenticated);

      if (!actor) {
        return c.json(
          { error: { code: "NOT_AUTHENTICATED", message: "Not authenticated." } },
          401,
        );
      }

      c.set("actor", actor);
      c.set("authUser", authenticated.user);
      c.set("activeSession", authenticated.activeSession ?? null);
      c.set("tokenClaims", authenticated.tokenClaims ?? null);

      await next();
    } catch (error) {
      if (error instanceof EdgeAuthError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }

      throw error;
    }
  };
}
