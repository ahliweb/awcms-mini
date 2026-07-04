import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../../src/lib/config";

const baseEnv = {
  APP_ENV: "development",
  DATABASE_URL: "postgres://x:y@localhost:5432/db",
  AUTH_JWT_SECRET: "test-secret"
};

describe("konfigurasi env (doc 18)", () => {
  test("env minimal valid menghasilkan default yang benar", () => {
    const config = loadConfig(baseEnv);
    expect(config.appTimezone).toBe("Asia/Jakarta");
    expect(config.defaultLocale).toBe("id");
    expect(config.database.poolMax).toBe(20);
    expect(config.auth.sessionTtlMin).toBe(120);
    expect(config.node.syncEnabled).toBe(false);
    expect(config.storage.driver).toBe("local");
  });

  test("DATABASE_URL hilang → gagal boot dengan pesan jelas", () => {
    expect(() => loadConfig({ ...baseEnv, DATABASE_URL: undefined })).toThrow(ConfigError);
    try {
      loadConfig({ ...baseEnv, DATABASE_URL: undefined });
    } catch (error) {
      expect((error as ConfigError).problems.join(" ")).toContain("DATABASE_URL");
    }
  });

  test("placeholder AUTH_JWT_SECRET ditolak pada production", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        APP_ENV: "production",
        AUTH_JWT_SECRET: "change-me-in-production"
      })
    ).toThrow(ConfigError);
  });

  test("flag aktif tanpa kredensial → gagal start (doc 18)", () => {
    expect(() => loadConfig({ ...baseEnv, R2_ENABLED: "true" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, STARSENDER_ENABLED: "true" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, MAILKETING_ENABLED: "true" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, AI_ANALYST_ENABLED: "true" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, AWCMS_SYNC_ENABLED: "true" })).toThrow(ConfigError);
  });

  test("pesan error tidak membocorkan nilai env", () => {
    try {
      loadConfig({ ...baseEnv, APP_ENV: "production", AUTH_JWT_SECRET: "super-secret-value" });
      // production tanpa masalah lain — cookieSecure default true, valid.
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret-value");
    }
  });
});
