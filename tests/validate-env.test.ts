import { describe, expect, test } from "bun:test";

import {
  checkEmailConfig,
  checkR2Config,
  checkRequiredVars,
  checkSyncConfig,
  runEnvValidation
} from "../scripts/validate-env";

const VALID_ENV = {
  APP_ENV: "production",
  APP_URL: "https://awcms-mini.example.local",
  APP_TIMEZONE: "Asia/Jakarta",
  DATABASE_URL: "postgres://user:pass@localhost:5432/awcms-mini",
  AUTH_JWT_SECRET: "a-real-random-secret-value"
} as NodeJS.ProcessEnv;

describe("checkRequiredVars", () => {
  test("all pass when every required var is set and non-empty", () => {
    const results = checkRequiredVars(VALID_ENV);
    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("fails and names the missing variable, without leaking other values", () => {
    const env = {
      ...VALID_ENV,
      AUTH_JWT_SECRET: undefined
    } as NodeJS.ProcessEnv;
    const results = checkRequiredVars(env);
    const failed = results.filter((result) => result.status === "fail");

    expect(failed).toHaveLength(1);
    expect(failed[0]?.name).toBe("AUTH_JWT_SECRET");
    expect(failed[0]?.detail).not.toContain(VALID_ENV.DATABASE_URL as string);
  });

  test("fails when a required var is only whitespace", () => {
    const env = { ...VALID_ENV, APP_ENV: "   " } as NodeJS.ProcessEnv;
    const results = checkRequiredVars(env);
    const failed = results.find((result) => result.name === "APP_ENV");

    expect(failed?.status).toBe("fail");
  });
});

describe("checkSyncConfig", () => {
  test("passes when sync is disabled, regardless of the secret", () => {
    const result = checkSyncConfig({
      AWCMS_MINI_SYNC_ENABLED: "false"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("pass");
  });

  test("fails when sync is enabled but the secret is left at the documented placeholder", () => {
    const result = checkSyncConfig({
      AWCMS_MINI_SYNC_ENABLED: "true",
      AWCMS_MINI_SYNC_HMAC_SECRET: "change-me"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("fail");
  });

  test("fails when sync is enabled but the secret is unset", () => {
    const result = checkSyncConfig({
      AWCMS_MINI_SYNC_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("fail");
  });

  test("passes when sync is enabled and the secret has been changed", () => {
    const result = checkSyncConfig({
      AWCMS_MINI_SYNC_ENABLED: "true",
      AWCMS_MINI_SYNC_HMAC_SECRET: "a-real-random-secret-value"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("pass");
  });
});

describe("checkR2Config", () => {
  test("passes (single check) when R2 is disabled", () => {
    const results = checkR2Config({ R2_ENABLED: "false" } as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("fails and names each missing R2 credential when R2 is enabled", () => {
    const results = checkR2Config({
      R2_ENABLED: "true",
      R2_BUCKET: "my-bucket"
    } as NodeJS.ProcessEnv);

    const failed = results.filter((result) => result.status === "fail");
    const failedNames = failed.map((result) => result.name).sort();

    expect(failedNames).toEqual(
      ["R2_ACCESS_KEY_ID", "R2_ACCOUNT_ID", "R2_SECRET_ACCESS_KEY"].sort()
    );
    expect(results.find((result) => result.name === "R2_BUCKET")?.status).toBe(
      "pass"
    );
  });

  test("all pass when R2 is enabled and every credential is set", () => {
    const results = checkR2Config({
      R2_ENABLED: "true",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET: "bucket"
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });
});

describe("checkEmailConfig", () => {
  test("passes (single check) when email is disabled", () => {
    const results = checkEmailConfig({
      EMAIL_ENABLED: "false"
    } as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("fails when email is enabled but EMAIL_FROM_ADDRESS/EMAIL_PROVIDER are missing", () => {
    const results = checkEmailConfig({
      EMAIL_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    const failedNames = results
      .filter((result) => result.status === "fail")
      .map((result) => result.name)
      .sort();

    expect(failedNames).toEqual(
      ["EMAIL_FROM_ADDRESS", "EMAIL_PROVIDER"].sort()
    );
  });

  test("fails when EMAIL_PROVIDER is not a known provider", () => {
    const results = checkEmailConfig({
      EMAIL_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "no-reply@example.com",
      EMAIL_PROVIDER: "sendgrid"
    } as NodeJS.ProcessEnv);

    const failed = results.find((result) => result.name === "EMAIL_PROVIDER");
    expect(failed?.status).toBe("fail");
  });

  test("fails and names each missing Mailketing credential when EMAIL_PROVIDER=mailketing", () => {
    const results = checkEmailConfig({
      EMAIL_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "no-reply@example.com",
      EMAIL_PROVIDER: "mailketing",
      EMAIL_MAILKETING_ACCOUNT_ID: "acct-123"
    } as NodeJS.ProcessEnv);

    const failedNames = results
      .filter((result) => result.status === "fail")
      .map((result) => result.name)
      .sort();

    expect(failedNames).toEqual(
      ["EMAIL_MAILKETING_API_TOKEN", "EMAIL_MAILKETING_API_BASE_URL"].sort()
    );
    expect(
      results.find((result) => result.name === "EMAIL_MAILKETING_ACCOUNT_ID")
        ?.status
    ).toBe("pass");
  });

  test("all pass when email is enabled with mailketing and every credential is set", () => {
    const results = checkEmailConfig({
      EMAIL_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "no-reply@example.com",
      EMAIL_PROVIDER: "mailketing",
      EMAIL_MAILKETING_ACCOUNT_ID: "acct-123",
      EMAIL_MAILKETING_API_TOKEN: "a-real-token",
      EMAIL_MAILKETING_API_BASE_URL: "https://api.mailketing.example/v1"
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("all pass when email is enabled with the log provider (no Mailketing creds required)", () => {
    const results = checkEmailConfig({
      EMAIL_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "no-reply@example.com",
      EMAIL_PROVIDER: "log"
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });
});

describe("runEnvValidation", () => {
  test("passes end-to-end for a minimal valid env (sync/R2/email all off)", () => {
    const env = {
      ...VALID_ENV,
      AWCMS_MINI_SYNC_ENABLED: "false",
      R2_ENABLED: "false",
      EMAIL_ENABLED: "false"
    } as NodeJS.ProcessEnv;

    const results = runEnvValidation(env);
    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("fails end-to-end when a required var is missing", () => {
    const env = { ...VALID_ENV, DATABASE_URL: "" } as NodeJS.ProcessEnv;
    const results = runEnvValidation(env);

    expect(results.some((result) => result.status === "fail")).toBe(true);
  });

  test("fails end-to-end when email is enabled but misconfigured", () => {
    const env = {
      ...VALID_ENV,
      EMAIL_ENABLED: "true"
    } as NodeJS.ProcessEnv;

    const results = runEnvValidation(env);
    expect(results.some((result) => result.status === "fail")).toBe(true);
  });
});
