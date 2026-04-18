import { resolveTrustedClientIp } from "../security/client-ip.mjs";

function normalizeNullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const next = String(value).trim();
  return next.length > 0 ? next : null;
}

function normalizeMetadata(pluginId, metadata) {
  return {
    plugin_id: pluginId,
    ...(metadata && typeof metadata === "object" ? metadata : {}),
  };
}

export function createPluginAuditHelper(options) {
  const pluginId = options?.pluginId;

  if (typeof pluginId !== "string" || pluginId.trim() === "") {
    throw new TypeError("Plugin audit helper requires pluginId.");
  }

  if (typeof options?.getAuditService !== "function") {
    throw new TypeError(`Plugin ${pluginId} audit helper requires getAuditService.`);
  }

  return {
    async append(input) {
      const audit = options.getAuditService(input?.database);

      return audit.append({
        actor_user_id: normalizeNullableString(input?.actorUserId),
        action: normalizeNullableString(input?.action),
        entity_type: normalizeNullableString(input?.entityType),
        entity_id: normalizeNullableString(input?.entityId),
        target_user_id: normalizeNullableString(input?.targetUserId),
        request_id: normalizeNullableString(input?.requestId ?? input?.request?.headers?.get?.("x-request-id")),
        ip_address: normalizeNullableString(input?.ipAddress ?? resolveTrustedClientIp(input?.request)),
        user_agent: normalizeNullableString(input?.userAgent ?? input?.request?.headers?.get?.("user-agent")),
        summary: normalizeNullableString(input?.summary),
        before_payload: input?.beforePayload ?? null,
        after_payload: input?.afterPayload ?? null,
        metadata: normalizeMetadata(pluginId, input?.metadata),
      });
    },
  };
}
