function createPermissionIndex(permissions) {
  return new Set((permissions ?? []).map((entry) => entry.code));
}

function normalizePermissionRequest(pluginId, permissionIndex, input) {
  if (!input || typeof input !== "object") {
    throw new TypeError(`Plugin ${pluginId} authorization input must be an object.`);
  }

  if (typeof input.permissionCode !== "string" || input.permissionCode.trim() === "") {
    throw new TypeError(`Plugin ${pluginId} authorization input must declare permissionCode.`);
  }

  if (!permissionIndex.has(input.permissionCode)) {
    throw new Error(`Plugin ${pluginId} authorization references undeclared permission ${input.permissionCode}.`);
  }

  return {
    permissionCode: input.permissionCode,
    action: typeof input.action === "string" && input.action.trim() ? input.action.trim() : "read",
    resource: input.resource,
    sessionId: typeof input.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : null,
  };
}

function normalizeActor(pluginId, actor) {
  if (!actor || typeof actor !== "object") {
    throw new TypeError(`Plugin ${pluginId} authorization requires actor context.`);
  }

  if (typeof actor.id !== "string" || actor.id.trim() === "") {
    throw new TypeError(`Plugin ${pluginId} authorization actor must include id.`);
  }

  return {
    id: actor.id,
    status: actor.status ?? "active",
    isProtected: actor.isProtected === true,
    activeRoleStaffLevel: Number.isFinite(actor.activeRoleStaffLevel) ? actor.activeRoleStaffLevel : 0,
  };
}

export function createPluginServiceAuthorizationHelper(options) {
  const pluginId = options?.pluginId;

  if (typeof pluginId !== "string" || pluginId.trim() === "") {
    throw new TypeError("Plugin service authorization helper requires pluginId.");
  }

  if (typeof options?.getAuthorizationService !== "function") {
    throw new TypeError(`Plugin ${pluginId} service authorization helper requires getAuthorizationService.`);
  }

  const permissionIndex = createPermissionIndex(options.permissions);

  return {
    async authorize(input) {
      const actor = normalizeActor(pluginId, input?.actor);
      const request = normalizePermissionRequest(pluginId, permissionIndex, input);
      const authorization = options.getAuthorizationService(input?.database);

      return authorization.evaluate({
        subject: {
          kind: "user",
          user_id: actor.id,
          status: actor.status,
          is_protected: actor.isProtected,
          staff_level: actor.activeRoleStaffLevel,
        },
        resource: request.resource,
        context: {
          permission_code: request.permissionCode,
          action: request.action,
          session_id: request.sessionId,
        },
      });
    },
  };
}
