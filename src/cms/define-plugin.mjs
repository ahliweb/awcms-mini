/**
 * `definePlugin` native (decoupling EmDash, ADR-020 Fase 3).
 *
 * Pengganti `definePlugin` dari paket `emdash`. Memvalidasi & menormalkan
 * deskriptor plugin format native AWCMS (`id` + `version` + `routes`/`hooks`).
 * Field ekstensi AWCMS (`permissions`, `adminPages`, `adminWidgets`) di-passthrough
 * — tidak dibuang seperti pada EmDash — agar kontrak plugin native (manifest +
 * registry + loader, #316–#318) menerima deskriptor utuh.
 *
 * Tidak ada dependency `emdash`; implementasi milik AWCMS-Mini sendiri.
 */

const SIMPLE_ID = /^[a-z0-9-]+$/;
const SCOPED_ID = /^@[a-z0-9-]+\/[a-z0-9-]+$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+/;

const DEFAULT_PRIORITY = 100;
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_ERROR_POLICY = "abort";

// Nama kapabilitas lama → kanonik (selaras EmDash agar plugin lama tetap valid).
const CAPABILITY_RENAMES = Object.freeze({
  "network:fetch": "network:request",
  "network:fetch:any": "network:request:unrestricted",
  "read:content": "content:read",
  "write:content": "content:write",
  "read:media": "media:read",
  "write:media": "media:write",
  "read:users": "users:read",
  "email:provide": "hooks.email-transport:register",
  "email:intercept": "hooks.email-events:register",
  "page:inject": "hooks.page-fragments:register",
});

const VALID_CAPABILITIES = new Set([
  "network:request",
  "network:request:unrestricted",
  "content:read",
  "content:write",
  "media:read",
  "media:write",
  "users:read",
  "email:send",
  "hooks.email-transport:register",
  "hooks.email-events:register",
  "hooks.page-fragments:register",
  ...Object.keys(CAPABILITY_RENAMES),
]);

function normalizeCapability(cap) {
  return Object.hasOwn(CAPABILITY_RENAMES, cap) ? CAPABILITY_RENAMES[cap] : cap;
}

function normalizeCapabilities(caps) {
  const seen = new Set();
  const out = [];
  for (const cap of caps) {
    const normalized = normalizeCapability(cap);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function isHookConfig(hook) {
  return typeof hook === "object" && hook !== null && "handler" in hook;
}

function resolveHook(hook, pluginId) {
  if (isHookConfig(hook)) {
    if (hook.exclusive !== undefined && typeof hook.exclusive !== "boolean") {
      throw new Error(
        `Invalid "exclusive" value in hook config for plugin "${pluginId}". Must be boolean.`,
      );
    }
    return {
      priority: hook.priority ?? DEFAULT_PRIORITY,
      timeout: hook.timeout ?? DEFAULT_TIMEOUT,
      dependencies: hook.dependencies ?? [],
      errorPolicy: hook.errorPolicy ?? DEFAULT_ERROR_POLICY,
      exclusive: hook.exclusive ?? false,
      handler: hook.handler,
      pluginId,
    };
  }
  return {
    priority: DEFAULT_PRIORITY,
    timeout: DEFAULT_TIMEOUT,
    dependencies: [],
    errorPolicy: DEFAULT_ERROR_POLICY,
    exclusive: false,
    handler: hook,
    pluginId,
  };
}

function resolveHooks(hooks, pluginId) {
  const resolved = {};
  for (const key of Object.keys(hooks)) {
    const hook = hooks[key];
    if (hook) resolved[key] = resolveHook(hook, pluginId);
  }
  return resolved;
}

/**
 * Definisikan plugin native AWCMS. Memvalidasi id/version/capabilities,
 * menormalkan kapabilitas (alias + implikasi), dan mengembalikan deskriptor
 * yang siap dipakai registry/loader native.
 *
 * @param {object} definition deskriptor plugin (`id`, `version`, dst.)
 * @returns {object} deskriptor ternormalkan
 */
export function definePlugin(definition) {
  const {
    id,
    version,
    capabilities = [],
    allowedHosts = [],
    hooks = {},
    routes = {},
    admin = {},
  } = definition;

  if (!SIMPLE_ID.test(id) && !SCOPED_ID.test(id)) {
    throw new Error(
      `Invalid plugin id "${id}". Must be lowercase alphanumeric with dashes (e.g., "my-plugin" or "@scope/my-plugin").`,
    );
  }
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(
      `Invalid plugin version "${version}". Must be semver format (e.g., "1.0.0").`,
    );
  }

  for (const cap of capabilities) {
    if (!VALID_CAPABILITIES.has(cap)) {
      throw new Error(`Invalid capability "${cap}" in plugin "${id}".`);
    }
  }

  const canonical = normalizeCapabilities(capabilities);
  const normalizedCapabilities = [...canonical];
  // Implikasi kapabilitas: yang luas mengimplikasikan yang sempit.
  if (canonical.includes("content:write") && !canonical.includes("content:read")) {
    normalizedCapabilities.push("content:read");
  }
  if (canonical.includes("media:write") && !canonical.includes("media:read")) {
    normalizedCapabilities.push("media:read");
  }
  if (
    canonical.includes("network:request:unrestricted") &&
    !canonical.includes("network:request")
  ) {
    normalizedCapabilities.push("network:request");
  }

  const descriptor = {
    id,
    version,
    capabilities: normalizedCapabilities,
    allowedHosts,
    storage: definition.storage ?? {},
    hooks: resolveHooks(hooks, id),
    routes,
    admin,
  };

  // Ekstensi native AWCMS (di-passthrough; EmDash membuangnya).
  if (definition.permissions !== undefined) descriptor.permissions = definition.permissions;
  if (definition.adminPages !== undefined) descriptor.adminPages = definition.adminPages;
  if (definition.adminWidgets !== undefined) descriptor.adminWidgets = definition.adminWidgets;

  return descriptor;
}
