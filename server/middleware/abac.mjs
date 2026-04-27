import { createAuthorizationService } from "../../src/services/authorization/service.mjs";
import { createAuditService } from "../../src/services/audit/service.mjs";

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== "object") {
    return null;
  }

  const userId = normalizeOptionalString(actor.user_id ?? actor.id);

  if (!userId) {
    return null;
  }

  return {
    kind: "user",
    user_id: userId,
    role_ids: Array.isArray(actor.role_ids) ? actor.role_ids : [],
    permission_codes: Array.isArray(actor.permission_codes)
      ? actor.permission_codes
      : [],
    staff_level: Number(actor.staff_level ?? actor.activeRoleStaffLevel ?? 0),
    job_level_rank: Number(actor.job_level_rank ?? 0),
    logical_region_ids: Array.isArray(actor.logical_region_ids)
      ? actor.logical_region_ids
      : [],
    administrative_region_ids: Array.isArray(actor.administrative_region_ids)
      ? actor.administrative_region_ids
      : [],
    status: normalizeOptionalString(actor.status) ?? "active",
    is_protected: actor.is_protected === true || actor.isProtected === true,
    is_owner: actor.is_owner === true,
    two_factor_enabled: actor.two_factor_enabled === true,
  };
}

function getRequestOrigin(c) {
  const origin = normalizeOptionalString(c.req.header("origin"));
  const host = normalizeOptionalString(c.req.header("host"));
  return origin ?? host;
}

function createDefaultResource(resource) {
  if (typeof resource === "function") {
    return resource;
  }

  return () => ({
    kind: "system",
    ...(resource && typeof resource === "object" ? resource : {}),
  });
}

async function resolveActor(c, options) {
  if (typeof options.resolveActor === "function") {
    return normalizeActor(await options.resolveActor(c));
  }

  return normalizeActor(c.get("actor"));
}

async function reportDeniedAuthorization(c, options, details) {
  const audit =
    options.auditService ??
    (options.database ? createAuditService({ database: options.database }) : null);

  if (audit) {
    try {
      await audit.append({
        actor_user_id: details.actorUserId ?? null,
        action: "authorization.deny",
        entity_type: "route",
        entity_id: c.req.path,
        target_user_id: details.actorUserId ?? null,
        request_id: c.get("requestId") ?? null,
        ip_address: c.get("clientIp") ?? null,
        user_agent: c.req.header("user-agent") ?? null,
        summary: "Rejected API request due to authorization denial.",
        metadata: {
          method: c.req.method,
          path: c.req.path,
          permission_code: details.permissionCode ?? null,
          request_origin: details.requestOrigin ?? null,
          authorization_reason: details.authorizationResult?.reason?.code ?? details.reason ?? null,
          matched_rule: details.authorizationResult?.matched_rule ?? null,
        },
      });
    } catch {
      // Best-effort audit logging must not mask the authorization result.
    }
  }

  if (typeof options.auditAuthorizationDenied !== "function") {
    return;
  }

  try {
    await options.auditAuthorizationDenied({
      requestId: c.get("requestId") ?? null,
      path: c.req.path,
      method: c.req.method,
      ...details,
    });
  } catch {
    // Authorization-denial audit must not mask the original authorization result.
  }
}

export function middlewareAbacGuard(guard, options = {}) {
  const permissionCode = normalizeOptionalString(guard?.permissionCode);

  if (!permissionCode) {
    throw new TypeError("ABAC guard requires permissionCode.");
  }

  const action = normalizeOptionalString(guard?.action) ?? "read";
  const resourceResolver = createDefaultResource(guard?.resource);
  const authorization =
    options.authorizationService ?? createAuthorizationService(options.authorizationOptions);

  return async (c, next) => {
    const actor = await resolveActor(c, options);

    if (!actor) {
      await reportDeniedAuthorization(c, options, {
        permissionCode,
        reason: "DENY_UNAUTHENTICATED",
      });

      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication is required.",
          },
        },
        401,
      );
    }

    const resource = await resourceResolver(c);
    const result = await authorization.evaluate({
      subject: actor,
      resource,
      context: {
        permission_code: permissionCode,
        action,
        session_id: c.get("activeSession")?.id ?? null,
        request_type: `${c.req.method} ${c.req.path}`,
        ip_address: c.get("clientIp") ?? null,
        occurred_at: new Date().toISOString(),
      },
    });

    if (!result.allowed) {
      await reportDeniedAuthorization(c, options, {
        actorUserId: actor.user_id,
        permissionCode,
        authorizationResult: result,
        requestOrigin: getRequestOrigin(c),
      });

      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "You do not have permission to access this resource.",
            details: {
              permissionCode,
              reason: result.reason?.code ?? null,
            },
          },
        },
        403,
      );
    }

    c.set("authorization", result);
    await next();
  };
}
