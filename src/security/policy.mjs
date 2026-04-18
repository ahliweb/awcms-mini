import { getDatabase } from "../db/index.mjs";

const SECURITY_POLICY_OPTION_NAME = "awcms.security.policy";

const DEFAULT_SECURITY_POLICY = Object.freeze({
  mandatoryTwoFactorRolloutMode: "none",
  customMandatoryTwoFactorRoleIds: [],
});

function normalizeRoleIds(values) {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
    : [];
}

function normalizeRolloutMode(value) {
  return ["none", "protected_roles", "custom"].includes(value) ? value : "none";
}

function normalizePersistedPolicy(policy = {}) {
  return {
    mandatoryTwoFactorRolloutMode: normalizeRolloutMode(policy.mandatoryTwoFactorRolloutMode),
    customMandatoryTwoFactorRoleIds: normalizeRoleIds(policy.customMandatoryTwoFactorRoleIds),
  };
}

function formatResolvedPolicy(policy = {}, roles = []) {
  const normalized = normalizePersistedPolicy(policy);

  return {
    ...normalized,
    mandatoryTwoFactorRoleIds: resolveMandatoryTwoFactorRoleIds(normalized, roles),
  };
}

function parseStoredPolicy(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return DEFAULT_SECURITY_POLICY;
  }

  try {
    return normalizePersistedPolicy(JSON.parse(value));
  } catch {
    return DEFAULT_SECURITY_POLICY;
  }
}

async function readStoredPolicy(executor) {
  const row = await executor
    .selectFrom("options")
    .select(["name", "value"])
    .where("name", "=", SECURITY_POLICY_OPTION_NAME)
    .executeTakeFirst();

  return parseStoredPolicy(row?.value);
}

async function writeStoredPolicy(executor, policy) {
  const value = JSON.stringify(normalizePersistedPolicy(policy));
  const existing = await executor
    .selectFrom("options")
    .select(["name"])
    .where("name", "=", SECURITY_POLICY_OPTION_NAME)
    .executeTakeFirst();

  if (existing) {
    await executor
      .updateTable("options")
      .set({ value })
      .where("name", "=", SECURITY_POLICY_OPTION_NAME)
      .execute();

    return;
  }

  await executor
    .insertInto("options")
    .values({
      name: SECURITY_POLICY_OPTION_NAME,
      value,
    })
    .execute();
}

export function resolveMandatoryTwoFactorRoleIds(policy = {}, roles = []) {
  const rolloutMode = normalizeRolloutMode(policy.mandatoryTwoFactorRolloutMode);

  if (rolloutMode === "protected_roles") {
    return normalizeRoleIds(roles.filter((role) => role?.isProtected === true).map((role) => role.id));
  }

  if (rolloutMode === "custom") {
    return normalizeRoleIds(policy.customMandatoryTwoFactorRoleIds);
  }

  return [];
}

export async function getSecurityPolicy(options = {}) {
  const database = options.database ?? getDatabase();
  const stored = await readStoredPolicy(database);
  return formatResolvedPolicy(stored, options.roles ?? []);
}

export async function updateSecurityPolicy(input = {}, options = {}) {
  const database = options.database ?? getDatabase();
  const policy = {
    mandatoryTwoFactorRolloutMode: normalizeRolloutMode(
      input.mandatoryTwoFactorRolloutMode ?? (Array.isArray(input.mandatoryTwoFactorRoleIds) && input.mandatoryTwoFactorRoleIds.length > 0 ? "custom" : "none"),
    ),
    customMandatoryTwoFactorRoleIds: normalizeRoleIds(input.customMandatoryTwoFactorRoleIds ?? input.mandatoryTwoFactorRoleIds),
  };

  await writeStoredPolicy(database, policy);
  return formatResolvedPolicy(policy, options.roles ?? []);
}

export async function resetSecurityPolicy(options = {}) {
  const database = options.database ?? getDatabase();
  await writeStoredPolicy(database, DEFAULT_SECURITY_POLICY);
}

export { DEFAULT_SECURITY_POLICY, SECURITY_POLICY_OPTION_NAME, formatResolvedPolicy, normalizePersistedPolicy, parseStoredPolicy };
