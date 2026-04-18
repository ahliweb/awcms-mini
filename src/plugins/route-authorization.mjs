import { PluginRouteError } from "emdash";

function createPermissionIndex(permissions) {
  return new Set((permissions ?? []).map((entry) => entry.code));
}

function normalizeGuard(guard, permissionIndex, pluginId) {
  if (!guard || typeof guard !== "object") {
    throw new TypeError(`Plugin ${pluginId} route guard must be an object.`);
  }

  if (typeof guard.permissionCode !== "string" || guard.permissionCode.trim() === "") {
    throw new TypeError(`Plugin ${pluginId} route guard must declare permissionCode.`);
  }

  if (!permissionIndex.has(guard.permissionCode)) {
    throw new Error(`Plugin ${pluginId} route guard references undeclared permission ${guard.permissionCode}.`);
  }

  return {
    permissionCode: guard.permissionCode,
    action: typeof guard.action === "string" && guard.action.trim() ? guard.action.trim() : "read",
    resource: guard.resource,
  };
}

async function resolveRouteResource(resource, input) {
  if (typeof resource === "function") {
    return resource(input);
  }

  return resource;
}

export function createAuthorizedPluginRoute(options) {
  const pluginId = options?.pluginId;

  if (typeof pluginId !== "string" || pluginId.trim() === "") {
    throw new TypeError("Plugin route authorization helper requires pluginId.");
  }

  if (typeof options?.handler !== "function") {
    throw new TypeError(`Plugin ${pluginId} route authorization helper requires a handler.`);
  }

  if (typeof options?.getDatabase !== "function") {
    throw new TypeError(`Plugin ${pluginId} route authorization helper requires getDatabase.`);
  }

  if (typeof options?.resolveActor !== "function") {
    throw new TypeError(`Plugin ${pluginId} route authorization helper requires resolveActor.`);
  }

  if (typeof options?.getAuthorizationService !== "function") {
    throw new TypeError(`Plugin ${pluginId} route authorization helper requires getAuthorizationService.`);
  }

  const permissionIndex = createPermissionIndex(options.permissions);
  const guard = normalizeGuard(options.guard, permissionIndex, pluginId);

  return {
    async handler(ctx) {
      const db = options.getDatabase();
      const actor = await options.resolveActor(db, ctx.request);
      const authorization = options.getAuthorizationService(db);
      const resource = await resolveRouteResource(guard.resource, {
        ctx,
        db,
        actor,
      });
      const result = await authorization.evaluate({
        subject: {
          kind: "user",
          user_id: actor.id,
          status: actor.status,
          is_protected: actor.isProtected,
          staff_level: actor.activeRoleStaffLevel,
        },
        resource,
        context: {
          permission_code: guard.permissionCode,
          action: guard.action,
          session_id: ctx.request.headers.get("x-session-id")?.trim() ?? null,
        },
      });

      if (!result.allowed) {
        throw PluginRouteError.forbidden(result.reason?.code ?? "Forbidden");
      }

      return options.handler({
        ...ctx,
        pluginDb: db,
        pluginActor: actor,
        authorizationResult: result,
      });
    },
  };
}
