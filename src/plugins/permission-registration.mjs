function sanitizeIdentifierPart(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildPluginPermissionId(pluginId, code) {
  const pluginPart = sanitizeIdentifierPart(pluginId);
  const codePart = sanitizeIdentifierPart(code);
  return `plugin_perm_${pluginPart}_${codePart}`;
}

function assertRequiredString(value, fieldName, pluginId) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`Plugin ${pluginId} must declare non-empty permission field ${fieldName}`);
  }

  return value.trim();
}

export function normalizePluginPermissionDeclaration(pluginId, permission) {
  const resolvedPluginId = assertRequiredString(pluginId, "pluginId", pluginId || "unknown");
  const code = assertRequiredString(permission?.code, "code", resolvedPluginId);
  const domain = assertRequiredString(permission?.domain, "domain", resolvedPluginId);
  const resource = assertRequiredString(permission?.resource, "resource", resolvedPluginId);
  const action = assertRequiredString(permission?.action, "action", resolvedPluginId);

  return {
    id: typeof permission?.id === "string" && permission.id.trim() ? permission.id.trim() : buildPluginPermissionId(resolvedPluginId, code),
    code,
    domain,
    resource,
    action,
    description: typeof permission?.description === "string" && permission.description.trim() ? permission.description.trim() : null,
    is_protected: permission?.is_protected === true,
    created_at: null,
    plugin_id: resolvedPluginId,
  };
}

export function collectRegisteredPluginPermissions(plugins) {
  const entries = [];
  const codes = new Set();

  for (const plugin of plugins ?? []) {
    const pluginId = assertRequiredString(plugin?.id, "id", plugin?.id || "unknown");
    const declarations = Array.isArray(plugin?.permissions) ? plugin.permissions : [];

    for (const declaration of declarations) {
      const normalized = normalizePluginPermissionDeclaration(pluginId, declaration);

      if (codes.has(normalized.code)) {
        throw new Error(`Duplicate plugin permission code registered: ${normalized.code}`);
      }

      codes.add(normalized.code);
      entries.push(normalized);
    }
  }

  return entries.sort((left, right) => left.code.localeCompare(right.code));
}
