/**
 * Konfigurasi runtime AWCMS-Mini (doc 18 — Configuration & Environment Reference).
 *
 * Prinsip:
 * - Semua secret hanya dari environment.
 * - Provider eksternal opsional via feature flag; default off.
 * - Konfigurasi divalidasi saat boot; nilai wajib yang hilang menghentikan start
 *   dengan pesan jelas tanpa membocorkan nilai.
 */

export type AppEnv = "development" | "staging" | "production";

export type AppConfig = {
  appEnv: AppEnv;
  appUrl: string;
  appTimezone: string;
  defaultLocale: string;
  logLevel: string;
  database: {
    url: string;
    poolMax: number;
    statementTimeoutMs: number;
    pgbouncer: boolean;
  };
  auth: {
    jwtSecret: string;
    sessionTtlMin: number;
    cookieSecure: boolean;
    loginMaxAttempts: number;
  };
  node: {
    nodeId: string;
    syncEnabled: boolean;
    syncHmacSecret?: string;
    syncMaxSkewSec: number;
  };
  storage: {
    driver: "local" | "r2";
    localPath: string;
    r2Enabled: boolean;
    r2AccountId?: string;
    r2AccessKeyId?: string;
    r2SecretAccessKey?: string;
    r2Bucket?: string;
  };
  providers: {
    starsenderEnabled: boolean;
    starsenderApiKey?: string;
    mailketingEnabled: boolean;
    mailketingApiToken?: string;
    aiAnalystEnabled: boolean;
    aiProviderApiKey?: string;
    aiModel?: string;
  };
};

export class ConfigError extends Error {
  public readonly problems: string[];

  constructor(problems: string[]) {
    super(`Konfigurasi tidak valid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

type EnvSource = Record<string, string | undefined>;

function readBool(env: EnvSource, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

function readInt(env: EnvSource, key: string, fallback: number, problems: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    problems.push(`${key} harus bilangan bulat positif`);
    return fallback;
  }
  return value;
}

/**
 * Membaca dan memvalidasi konfigurasi dari environment.
 * Melempar ConfigError berisi daftar masalah (nama variabel saja, tanpa nilai).
 */
export function loadConfig(env: EnvSource = process.env): AppConfig {
  const problems: string[] = [];

  const appEnvRaw = env.APP_ENV ?? "development";
  if (!["development", "staging", "production"].includes(appEnvRaw)) {
    problems.push("APP_ENV harus development/staging/production");
  }
  const appEnv = appEnvRaw as AppEnv;
  const isProduction = appEnv === "production";

  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl) problems.push("DATABASE_URL wajib diisi");

  const jwtSecret = env.AUTH_JWT_SECRET ?? "";
  if (!jwtSecret) problems.push("AUTH_JWT_SECRET wajib diisi");
  if (isProduction && jwtSecret === "change-me-in-production") {
    problems.push("AUTH_JWT_SECRET masih placeholder pada production");
  }

  const syncEnabled = readBool(env, "AWCMS_SYNC_ENABLED", false);
  const syncHmacSecret = env.AWCMS_SYNC_HMAC_SECRET;
  if (syncEnabled && (!syncHmacSecret || syncHmacSecret === "change-me")) {
    problems.push("AWCMS_SYNC_HMAC_SECRET wajib diisi bila AWCMS_SYNC_ENABLED=true");
  }

  const r2Enabled = readBool(env, "R2_ENABLED", false);
  if (r2Enabled) {
    for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
      if (!env[key]) problems.push(`${key} wajib diisi bila R2_ENABLED=true`);
    }
  }

  const starsenderEnabled = readBool(env, "STARSENDER_ENABLED", false);
  if (starsenderEnabled && !env.STARSENDER_API_KEY) {
    problems.push("STARSENDER_API_KEY wajib diisi bila STARSENDER_ENABLED=true");
  }
  const mailketingEnabled = readBool(env, "MAILKETING_ENABLED", false);
  if (mailketingEnabled && !env.MAILKETING_API_TOKEN) {
    problems.push("MAILKETING_API_TOKEN wajib diisi bila MAILKETING_ENABLED=true");
  }
  const aiAnalystEnabled = readBool(env, "AI_ANALYST_ENABLED", false);
  if (aiAnalystEnabled && !env.AI_PROVIDER_API_KEY) {
    problems.push("AI_PROVIDER_API_KEY wajib diisi bila AI_ANALYST_ENABLED=true");
  }

  const storageDriverRaw = env.STORAGE_DRIVER ?? "local";
  if (!["local", "r2"].includes(storageDriverRaw)) {
    problems.push("STORAGE_DRIVER harus local/r2");
  }
  if (storageDriverRaw === "r2" && !r2Enabled) {
    problems.push("STORAGE_DRIVER=r2 membutuhkan R2_ENABLED=true");
  }

  const config: AppConfig = {
    appEnv,
    appUrl: env.APP_URL ?? "http://localhost:4321",
    appTimezone: env.APP_TIMEZONE ?? "Asia/Jakarta",
    defaultLocale: env.APP_DEFAULT_LOCALE ?? "id",
    logLevel: env.LOG_LEVEL ?? "info",
    database: {
      url: databaseUrl,
      poolMax: readInt(env, "DATABASE_POOL_MAX", 20, problems),
      statementTimeoutMs: readInt(env, "DATABASE_STATEMENT_TIMEOUT_MS", 15000, problems),
      pgbouncer: readBool(env, "DATABASE_PGBOUNCER", false)
    },
    auth: {
      jwtSecret,
      sessionTtlMin: readInt(env, "AUTH_SESSION_TTL_MIN", 120, problems),
      cookieSecure: readBool(env, "AUTH_COOKIE_SECURE", isProduction),
      loginMaxAttempts: readInt(env, "AUTH_LOGIN_MAX_ATTEMPTS", 5, problems)
    },
    node: {
      nodeId: env.AWCMS_NODE_ID ?? "local-dev-node",
      syncEnabled,
      syncHmacSecret,
      syncMaxSkewSec: readInt(env, "AWCMS_SYNC_MAX_SKEW_SEC", 300, problems)
    },
    storage: {
      driver: storageDriverRaw as "local" | "r2",
      localPath: env.LOCAL_STORAGE_PATH ?? "./storage",
      r2Enabled,
      r2AccountId: env.R2_ACCOUNT_ID,
      r2AccessKeyId: env.R2_ACCESS_KEY_ID,
      r2SecretAccessKey: env.R2_SECRET_ACCESS_KEY,
      r2Bucket: env.R2_BUCKET
    },
    providers: {
      starsenderEnabled,
      starsenderApiKey: env.STARSENDER_API_KEY,
      mailketingEnabled,
      mailketingApiToken: env.MAILKETING_API_TOKEN,
      aiAnalystEnabled,
      aiProviderApiKey: env.AI_PROVIDER_API_KEY,
      aiModel: env.AI_MODEL
    }
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

let cachedConfig: AppConfig | undefined;

/** Konfigurasi singleton — validasi sekali saat pertama diakses. */
export function getConfig(): AppConfig {
  if (!cachedConfig) cachedConfig = loadConfig();
  return cachedConfig;
}

/** Untuk test: reset cache konfigurasi. */
export function resetConfigCache(): void {
  cachedConfig = undefined;
}
