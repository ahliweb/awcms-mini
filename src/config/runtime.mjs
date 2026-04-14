export const DEFAULT_DATABASE_URL = "postgres://localhost:5432/awcms_mini_dev";

export function getRuntimeConfig() {
  return {
    databaseUrl: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
  };
}
