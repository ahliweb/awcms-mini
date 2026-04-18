export const DEFAULT_DATABASE_URL = "postgres://localhost:5432/awcms_mini_dev";
export const DEFAULT_RUNTIME_TARGET = "cloudflare";
export const DEFAULT_TRUSTED_PROXY_MODE = "direct";

function normalizeSiteUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function normalizeRuntimeTarget(value) {
  return ["cloudflare", "node"].includes(value) ? value : DEFAULT_RUNTIME_TARGET;
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function normalizeTurnstileExpectedHostname(value, siteUrl) {
  const explicit = normalizeOptionalString(value);

  if (explicit) {
    return explicit;
  }

  if (!siteUrl) {
    return null;
  }

  try {
    return new URL(siteUrl).hostname || null;
  } catch {
    return null;
  }
}

export function getRuntimeConfig() {
  const siteUrl = normalizeSiteUrl(process.env.SITE_URL);
  const turnstileSecretKey = normalizeOptionalString(process.env.TURNSTILE_SECRET_KEY);
  const turnstileSiteKey = normalizeOptionalString(process.env.TURNSTILE_SITE_KEY);

  return {
    databaseUrl: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
    runtimeTarget: normalizeRuntimeTarget(process.env.MINI_RUNTIME_TARGET),
    siteUrl,
    appSecret: process.env.APP_SECRET || null,
    miniTotpEncryptionKey: process.env.MINI_TOTP_ENCRYPTION_KEY || null,
    trustedProxyMode: process.env.TRUSTED_PROXY_MODE || DEFAULT_TRUSTED_PROXY_MODE,
    turnstile: {
      siteKey: turnstileSiteKey,
      secretKey: turnstileSecretKey,
      enabled: Boolean(turnstileSecretKey),
      expectedHostname: normalizeTurnstileExpectedHostname(process.env.TURNSTILE_EXPECTED_HOSTNAME, siteUrl),
    },
  };
}
