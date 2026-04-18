export const DEFAULT_DATABASE_URL = "postgres://localhost:5432/awcms_mini_dev";
export const DEFAULT_TRUSTED_PROXY_MODE = "direct";

export function getRuntimeConfig() {
  return {
    databaseUrl: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
    trustedProxyMode: process.env.TRUSTED_PROXY_MODE || DEFAULT_TRUSTED_PROXY_MODE,
  };
}
