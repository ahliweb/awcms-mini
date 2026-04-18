import { getRuntimeConfig } from "../../config/runtime.mjs";
import { createEdgeAuthService, EdgeAuthError } from "../../services/edge-auth/service.mjs";
import { createSessionService } from "../../services/sessions/service.mjs";
import { createAuthorizationService } from "../../services/authorization/service.mjs";
import { createUserRepository } from "../../db/repositories/users.mjs";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function buildSecurityHeaders() {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    Vary: "Origin",
  };
}

function isOriginAllowed(origin, requestUrl, runtimeConfig) {
  if (!origin) {
    return true;
  }

  if (origin === requestUrl.origin) {
    return true;
  }

  return runtimeConfig.edgeApi.allowedOrigins.includes(origin);
}

export function createEdgeApiJsonResponse(request, body, status = 200, runtimeConfig = getRuntimeConfig()) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const headers = {
    ...buildSecurityHeaders(),
    "Content-Type": JSON_CONTENT_TYPE,
  };

  if (origin && isOriginAllowed(origin, url, runtimeConfig)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

export function createEdgeApiErrorResponse(request, code, message, status, runtimeConfig = getRuntimeConfig()) {
  return createEdgeApiJsonResponse(request, { error: { code, message } }, status, runtimeConfig);
}

export function handleEdgeApiCorsPreflight(request, options = {}, runtimeConfig = getRuntimeConfig()) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);

  if (!isOriginAllowed(origin, url, runtimeConfig)) {
    return createEdgeApiErrorResponse(request, "EDGE_API_ORIGIN_NOT_ALLOWED", "Origin is not allowed.", 403, runtimeConfig);
  }

  return new Response(null, {
    status: 204,
    headers: {
      ...buildSecurityHeaders(),
      ...(origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" } : {}),
      "Access-Control-Allow-Methods": options.methods?.join(", ") ?? "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": options.headers?.join(", ") ?? "Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}

export function enforceEdgeApiMethod(request, methods, runtimeConfig = getRuntimeConfig()) {
  if (!methods.includes(request.method)) {
    return createEdgeApiErrorResponse(request, "METHOD_NOT_ALLOWED", "Method not allowed.", 405, runtimeConfig);
  }

  return null;
}

export function enforceEdgeApiOrigin(request, runtimeConfig = getRuntimeConfig()) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);

  if (!isOriginAllowed(origin, url, runtimeConfig)) {
    return createEdgeApiErrorResponse(request, "EDGE_API_ORIGIN_NOT_ALLOWED", "Origin is not allowed.", 403, runtimeConfig);
  }

  return null;
}

export function enforceEdgeApiAccept(request, runtimeConfig = getRuntimeConfig()) {
  const accept = request.headers.get("accept");

  if (accept && !accept.includes("application/json") && !accept.includes("*/*")) {
    return createEdgeApiErrorResponse(request, "NOT_ACCEPTABLE", "Only application/json responses are supported.", 406, runtimeConfig);
  }

  return null;
}

export function enforceEdgeApiJsonBody(request, runtimeConfig = getRuntimeConfig()) {
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);

  if (Number.isFinite(contentLength) && contentLength > runtimeConfig.edgeApi.maxBodyBytes) {
    return createEdgeApiErrorResponse(request, "PAYLOAD_TOO_LARGE", "Request body exceeds the allowed size.", 413, runtimeConfig);
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().startsWith("application/json")) {
    return createEdgeApiErrorResponse(request, "UNSUPPORTED_MEDIA_TYPE", "Expected application/json body.", 415, runtimeConfig);
  }

  return null;
}

function getBearerToken(request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = authorization.slice(7).trim();
  return token.length > 0 ? token : null;
}

export async function requireEdgeApiAuthentication({ request, session, db, runtimeConfig = getRuntimeConfig() }) {
  const bearerToken = getBearerToken(request);

  if (bearerToken) {
    const edgeAuth = createEdgeAuthService({ database: db, runtimeConfig });

    try {
      const authenticated = await edgeAuth.authenticateAccessToken(bearerToken);
      return {
        ok: true,
        ...authenticated,
        authMethod: "bearer",
      };
    } catch (error) {
      if (error instanceof EdgeAuthError) {
        return {
          ok: false,
          response: createEdgeApiErrorResponse(request, error.code, error.message, error.status, runtimeConfig),
        };
      }

      throw error;
    }
  }

  return requireEdgeApiIdentitySession({ request, session, db, runtimeConfig });
}

export async function requireEdgeApiIdentitySession({ request, session, db, runtimeConfig = getRuntimeConfig() }) {
  const sessionUser = await session?.get?.("user");
  const identitySession = await session?.get?.("identitySession");

  if (!sessionUser?.id || !identitySession?.id) {
    return {
      ok: false,
      response: createEdgeApiErrorResponse(request, "NOT_AUTHENTICATED", "Not authenticated.", 401, runtimeConfig),
    };
  }

  const sessions = createSessionService({ database: db });
  const activeSession = await sessions.getSession(identitySession.id);

  if (!activeSession || activeSession.revoked_at) {
    session?.destroy?.();
    return {
      ok: false,
      response: createEdgeApiErrorResponse(request, "NOT_AUTHENTICATED", "Not authenticated.", 401, runtimeConfig),
    };
  }

  const users = createUserRepository(db);
  const user = await users.getUserById(sessionUser.id);

  if (!user) {
    session?.destroy?.();
    return {
      ok: false,
      response: createEdgeApiErrorResponse(request, "NOT_AUTHENTICATED", "Not authenticated.", 401, runtimeConfig),
    };
  }

  return {
    ok: true,
    user,
    activeSession,
    authMethod: "session",
  };
}

export async function requireEdgeApiPermission({
  request,
  db,
  user,
  activeSession,
  permissionCode,
  action,
  resource,
  runtimeConfig = getRuntimeConfig(),
}) {
  const authorization = createAuthorizationService({ database: db });
  const result = await authorization.evaluate({
    subject: {
      kind: "user",
      user_id: user.id,
      status: user.status ?? "active",
      is_protected: user.is_protected === true,
    },
    resource,
    context: {
      permission_code: permissionCode,
      action,
      session_id: activeSession.id,
    },
  });

  if (!result.allowed) {
    return {
      ok: false,
      result,
      response: createEdgeApiErrorResponse(request, "FORBIDDEN", "Forbidden.", 403, runtimeConfig),
    };
  }

  return {
    ok: true,
    result,
  };
}
