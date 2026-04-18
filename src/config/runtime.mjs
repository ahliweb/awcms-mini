export const DEFAULT_DATABASE_URL = "postgres://localhost:5432/awcms_mini_dev";
export const DEFAULT_TRUSTED_PROXY_MODE = "direct";

function normalizeSiteUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

export function getRuntimeConfig() {
  return {
    databaseUrl: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
    siteUrl: normalizeSiteUrl(process.env.SITE_URL),
    appSecret: process.env.APP_SECRET || null,
    miniTotpEncryptionKey: process.env.MINI_TOTP_ENCRYPTION_KEY || null,
    trustedProxyMode: process.env.TRUSTED_PROXY_MODE || DEFAULT_TRUSTED_PROXY_MODE,
  };
}
