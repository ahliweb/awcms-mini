import { describe, expect, test } from "bun:test";

import {
  checkAppEnvValue,
  checkEmailConfig,
  checkGoogleOidcConfig,
  checkNewsMediaR2AllowedMimeTypesKnown,
  checkNewsMediaR2PresignedTtlUpperBound,
  checkOnlineAuthSecurityConfig,
  checkPublicRoutingConfig,
  checkR2Config,
  checkRequiredVars,
  checkSyncConfig,
  checkTenantDomainDnsConfig,
  checkMfaConfig,
  checkTurnstileConfig,
  checkVisitorAnalyticsConfig,
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

describe("checkAppEnvValue (Issue #684 follow-up — security-auditor finding on PR #705)", () => {
  test("passes for each documented value (doc 18)", () => {
    for (const value of ["development", "staging", "production"]) {
      const result = checkAppEnvValue({ ...VALID_ENV, APP_ENV: value });
      expect(result.status).toBe("pass");
    }
  });

  test("fails for a casing variant — a typo that would silently weaken production-only safety checks", () => {
    const result = checkAppEnvValue({ ...VALID_ENV, APP_ENV: "Production" });
    expect(result.status).toBe("fail");
  });

  test("fails for an unknown value", () => {
    const result = checkAppEnvValue({ ...VALID_ENV, APP_ENV: "prod" });
    expect(result.status).toBe("fail");
  });

  test("passes (defers to checkRequiredVars) when APP_ENV is unset, rather than double-reporting", () => {
    const result = checkAppEnvValue({
      ...VALID_ENV,
      APP_ENV: undefined
    } as NodeJS.ProcessEnv);
    expect(result.status).toBe("pass");
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

describe("checkPublicRoutingConfig", () => {
  test("passes (mode + base path) when PUBLIC_TENANT_RESOLUTION_MODE is not set", () => {
    const results = checkPublicRoutingConfig({} as NodeJS.ProcessEnv);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("fails when PUBLIC_TENANT_RESOLUTION_MODE is not one of the documented values", () => {
    const results = checkPublicRoutingConfig({
      PUBLIC_TENANT_RESOLUTION_MODE: "made_up_mode"
    } as NodeJS.ProcessEnv);

    const failed = results.find(
      (result) => result.name === "PUBLIC_TENANT_RESOLUTION_MODE"
    );
    expect(failed?.status).toBe("fail");
  });

  test("host_default fails without PUBLIC_PLATFORM_ROOT_DOMAIN", () => {
    const results = checkPublicRoutingConfig({
      PUBLIC_TENANT_RESOLUTION_MODE: "host_default"
    } as NodeJS.ProcessEnv);

    const failed = results.find(
      (result) => result.name === "PUBLIC_PLATFORM_ROOT_DOMAIN"
    );
    expect(failed?.status).toBe("fail");
  });

  test("host_default passes with PUBLIC_PLATFORM_ROOT_DOMAIN set", () => {
    const results = checkPublicRoutingConfig({
      PUBLIC_TENANT_RESOLUTION_MODE: "host_default",
      PUBLIC_PLATFORM_ROOT_DOMAIN: "example.test"
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("env_default fails without PUBLIC_DEFAULT_TENANT_ID or PUBLIC_DEFAULT_TENANT_CODE", () => {
    const results = checkPublicRoutingConfig({
      PUBLIC_TENANT_RESOLUTION_MODE: "env_default"
    } as NodeJS.ProcessEnv);

    const failed = results.find(
      (result) =>
        result.name === "PUBLIC_DEFAULT_TENANT_ID or PUBLIC_DEFAULT_TENANT_CODE"
    );
    expect(failed?.status).toBe("fail");
  });

  test("env_default passes with only PUBLIC_DEFAULT_TENANT_ID set", () => {
    const results = checkPublicRoutingConfig({
      PUBLIC_TENANT_RESOLUTION_MODE: "env_default",
      PUBLIC_DEFAULT_TENANT_ID: "11111111-1111-1111-1111-111111111111"
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("env_default passes with only PUBLIC_DEFAULT_TENANT_CODE set", () => {
    const results = checkPublicRoutingConfig({
      PUBLIC_TENANT_RESOLUTION_MODE: "env_default",
      PUBLIC_DEFAULT_TENANT_CODE: "demo"
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("setup_default passes without any extra public routing var", () => {
    const results = checkPublicRoutingConfig({
      PUBLIC_TENANT_RESOLUTION_MODE: "setup_default"
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("tenant_code_legacy passes without any extra public routing var", () => {
    const results = checkPublicRoutingConfig({
      PUBLIC_TENANT_RESOLUTION_MODE: "tenant_code_legacy"
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("PUBLIC_CANONICAL_BASE_PATH passes when unset (defaults to /news)", () => {
    const results = checkPublicRoutingConfig({} as NodeJS.ProcessEnv);
    const check = results.find(
      (result) => result.name === "PUBLIC_CANONICAL_BASE_PATH"
    );

    expect(check?.status).toBe("pass");
  });

  test("PUBLIC_CANONICAL_BASE_PATH passes for a valid absolute path", () => {
    const results = checkPublicRoutingConfig({
      PUBLIC_CANONICAL_BASE_PATH: "/news"
    } as NodeJS.ProcessEnv);
    const check = results.find(
      (result) => result.name === "PUBLIC_CANONICAL_BASE_PATH"
    );

    expect(check?.status).toBe("pass");
  });

  test.each([
    ["missing leading slash", "news"],
    ["trailing slash", "/news/"],
    ["whitespace", "/news blog"],
    ["double slash", "/news//latest"]
  ])("PUBLIC_CANONICAL_BASE_PATH fails for %s (%p)", (_label, value) => {
    const results = checkPublicRoutingConfig({
      PUBLIC_CANONICAL_BASE_PATH: value
    } as NodeJS.ProcessEnv);
    const check = results.find(
      (result) => result.name === "PUBLIC_CANONICAL_BASE_PATH"
    );

    expect(check?.status).toBe("fail");
  });

  test("never includes PUBLIC_DEFAULT_TENANT_ID/CODE values in failure details", () => {
    const results = checkPublicRoutingConfig({
      PUBLIC_TENANT_RESOLUTION_MODE: "env_default"
    } as NodeJS.ProcessEnv);

    for (const result of results) {
      expect(result.detail).not.toContain("11111111-1111-1111-1111");
    }
  });
});

describe("checkTenantDomainDnsConfig", () => {
  test("passes (single check) when TENANT_DOMAIN_DNS_PROVIDER is not set", () => {
    const results = checkTenantDomainDnsConfig({} as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("passes (single check) when TENANT_DOMAIN_DNS_PROVIDER=manual", () => {
    const results = checkTenantDomainDnsConfig({
      TENANT_DOMAIN_DNS_PROVIDER: "manual"
    } as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("fails when TENANT_DOMAIN_DNS_PROVIDER is not a known provider", () => {
    const results = checkTenantDomainDnsConfig({
      TENANT_DOMAIN_DNS_PROVIDER: "route53"
    } as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("fail");
  });

  test("fails and names each missing Cloudflare var when TENANT_DOMAIN_DNS_PROVIDER=cloudflare", () => {
    const results = checkTenantDomainDnsConfig({
      TENANT_DOMAIN_DNS_PROVIDER: "cloudflare"
    } as NodeJS.ProcessEnv);

    const failedNames = results
      .filter((result) => result.status === "fail")
      .map((result) => result.name)
      .sort();

    expect(failedNames).toEqual(
      [
        "TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN",
        "TENANT_DOMAIN_CLOUDFLARE_ZONE_ID",
        "TENANT_DOMAIN_CLOUDFLARE_API_TOKEN"
      ].sort()
    );
  });

  test("all pass when TENANT_DOMAIN_DNS_PROVIDER=cloudflare and every var is set", () => {
    const results = checkTenantDomainDnsConfig({
      TENANT_DOMAIN_DNS_PROVIDER: "cloudflare",
      TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN: "platform.example",
      TENANT_DOMAIN_CLOUDFLARE_ZONE_ID: "zone-abc",
      TENANT_DOMAIN_CLOUDFLARE_API_TOKEN: "a-real-token"
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("never includes the configured API token in any result detail", () => {
    const results = checkTenantDomainDnsConfig({
      TENANT_DOMAIN_DNS_PROVIDER: "cloudflare",
      TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN: "platform.example",
      TENANT_DOMAIN_CLOUDFLARE_ZONE_ID: "zone-abc",
      TENANT_DOMAIN_CLOUDFLARE_API_TOKEN: "super-secret-token-value"
    } as NodeJS.ProcessEnv);

    for (const result of results) {
      expect(result.detail).not.toContain("super-secret-token-value");
    }
  });
});

describe("checkOnlineAuthSecurityConfig", () => {
  test("passes (single check) when AUTH_ONLINE_SECURITY_ENABLED is not set", () => {
    const results = checkOnlineAuthSecurityConfig({} as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("passes when AUTH_ONLINE_SECURITY_ENABLED=false", () => {
    const results = checkOnlineAuthSecurityConfig({
      AUTH_ONLINE_SECURITY_ENABLED: "false"
    } as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("fails when AUTH_ONLINE_SECURITY_ENABLED=true and AUTH_ONLINE_SECURITY_PROFILE is unset", () => {
    const results = checkOnlineAuthSecurityConfig({
      AUTH_ONLINE_SECURITY_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("fail");
  });

  test("fails when AUTH_ONLINE_SECURITY_ENABLED=true and AUTH_ONLINE_SECURITY_PROFILE=disabled (contradictory)", () => {
    const results = checkOnlineAuthSecurityConfig({
      AUTH_ONLINE_SECURITY_ENABLED: "true",
      AUTH_ONLINE_SECURITY_PROFILE: "disabled"
    } as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("fail");
  });

  test("passes when AUTH_ONLINE_SECURITY_ENABLED=true and AUTH_ONLINE_SECURITY_PROFILE=full_online", () => {
    const results = checkOnlineAuthSecurityConfig({
      AUTH_ONLINE_SECURITY_ENABLED: "true",
      AUTH_ONLINE_SECURITY_PROFILE: "full_online"
    } as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });
});

describe("checkTurnstileConfig", () => {
  test("passes (single check) when TURNSTILE_ENABLED is not set", () => {
    const results = checkTurnstileConfig({} as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("passes when TURNSTILE_ENABLED=false", () => {
    const results = checkTurnstileConfig({
      TURNSTILE_ENABLED: "false"
    } as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("fails and names each missing var when TURNSTILE_ENABLED=true", () => {
    const results = checkTurnstileConfig({
      TURNSTILE_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    const failedNames = results
      .filter((result) => result.status === "fail")
      .map((result) => result.name)
      .sort();

    expect(failedNames).toEqual(
      ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"].sort()
    );
  });

  test("all pass when TURNSTILE_ENABLED=true and both vars are set", () => {
    const results = checkTurnstileConfig({
      TURNSTILE_ENABLED: "true",
      TURNSTILE_SITE_KEY: "site-key-abc",
      TURNSTILE_SECRET_KEY: "a-real-secret"
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("never includes the configured secret key in any result detail", () => {
    const results = checkTurnstileConfig({
      TURNSTILE_ENABLED: "true",
      TURNSTILE_SITE_KEY: "site-key-abc",
      TURNSTILE_SECRET_KEY: "super-secret-turnstile-value"
    } as NodeJS.ProcessEnv);

    for (const result of results) {
      expect(result.detail).not.toContain("super-secret-turnstile-value");
    }
  });
});

const VALID_MFA_KEY_BASE64 = Buffer.alloc(32, 3).toString("base64");

describe("checkMfaConfig", () => {
  test("passes (single check) when AUTH_MFA_ENABLED is not set", () => {
    const results = checkMfaConfig({} as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("passes when AUTH_MFA_ENABLED=false", () => {
    const results = checkMfaConfig({
      AUTH_MFA_ENABLED: "false"
    } as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("fails when AUTH_MFA_ENABLED=true but the encryption key is missing", () => {
    const results = checkMfaConfig({
      AUTH_MFA_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    const failed = results.filter((result) => result.status === "fail");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.name).toBe("AUTH_MFA_SECRET_ENCRYPTION_KEY");
  });

  test("fails when the encryption key is set but not a valid 32-byte base64 value", () => {
    const results = checkMfaConfig({
      AUTH_MFA_ENABLED: "true",
      AUTH_MFA_SECRET_ENCRYPTION_KEY: "too-short"
    } as NodeJS.ProcessEnv);

    const failed = results.filter((result) => result.status === "fail");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.name).toBe("AUTH_MFA_SECRET_ENCRYPTION_KEY");
  });

  test("all pass when AUTH_MFA_ENABLED=true and the key is a valid 32-byte base64 value", () => {
    const results = checkMfaConfig({
      AUTH_MFA_ENABLED: "true",
      AUTH_MFA_SECRET_ENCRYPTION_KEY: VALID_MFA_KEY_BASE64
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("never includes the configured key value in any result detail", () => {
    const results = checkMfaConfig({
      AUTH_MFA_ENABLED: "true",
      AUTH_MFA_SECRET_ENCRYPTION_KEY: VALID_MFA_KEY_BASE64
    } as NodeJS.ProcessEnv);

    for (const result of results) {
      expect(result.detail).not.toContain(VALID_MFA_KEY_BASE64);
    }
  });
});

describe("checkGoogleOidcConfig", () => {
  test("passes (single check) when AUTH_GOOGLE_LOGIN_ENABLED is not set", () => {
    const results = checkGoogleOidcConfig({} as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("passes when AUTH_GOOGLE_LOGIN_ENABLED=false", () => {
    const results = checkGoogleOidcConfig({
      AUTH_GOOGLE_LOGIN_ENABLED: "false"
    } as NodeJS.ProcessEnv);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("fails and names each missing var when AUTH_GOOGLE_LOGIN_ENABLED=true", () => {
    const results = checkGoogleOidcConfig({
      AUTH_GOOGLE_LOGIN_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    const failedNames = results
      .filter((result) => result.status === "fail")
      .map((result) => result.name)
      .sort();

    expect(failedNames).toEqual(
      ["AUTH_GOOGLE_CLIENT_ID", "AUTH_GOOGLE_CLIENT_SECRET"].sort()
    );
  });

  test("all pass when AUTH_GOOGLE_LOGIN_ENABLED=true and both vars are set", () => {
    const results = checkGoogleOidcConfig({
      AUTH_GOOGLE_LOGIN_ENABLED: "true",
      AUTH_GOOGLE_CLIENT_ID: "client-abc",
      AUTH_GOOGLE_CLIENT_SECRET: "a-real-secret"
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("never includes the configured secret in any result detail", () => {
    const results = checkGoogleOidcConfig({
      AUTH_GOOGLE_LOGIN_ENABLED: "true",
      AUTH_GOOGLE_CLIENT_ID: "client-abc",
      AUTH_GOOGLE_CLIENT_SECRET: "super-secret-google-value"
    } as NodeJS.ProcessEnv);

    for (const result of results) {
      expect(result.detail).not.toContain("super-secret-google-value");
    }
  });
});

describe("checkVisitorAnalyticsConfig", () => {
  test("all pass when no VISITOR_ANALYTICS_* var is set (privacy-first default)", () => {
    const results = checkVisitorAnalyticsConfig({} as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("passes when VISITOR_ANALYTICS_MODE=basic or detailed", () => {
    expect(
      checkVisitorAnalyticsConfig({
        VISITOR_ANALYTICS_MODE: "basic"
      } as NodeJS.ProcessEnv).every((result) => result.status === "pass")
    ).toBe(true);
    expect(
      checkVisitorAnalyticsConfig({
        VISITOR_ANALYTICS_MODE: "detailed"
      } as NodeJS.ProcessEnv).every((result) => result.status === "pass")
    ).toBe(true);
  });

  test("fails when VISITOR_ANALYTICS_MODE is not a known mode", () => {
    const results = checkVisitorAnalyticsConfig({
      VISITOR_ANALYTICS_MODE: "full"
    } as NodeJS.ProcessEnv);

    const modeResult = results.find(
      (result) => result.name === "VISITOR_ANALYTICS_MODE"
    );
    expect(modeResult?.status).toBe("fail");
  });

  test("fails and names each malformed retention/window var", () => {
    const results = checkVisitorAnalyticsConfig({
      VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS: "not-a-number",
      VISITOR_ANALYTICS_EVENT_RETENTION_DAYS: "-1",
      VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS: "0",
      VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS: "730"
    } as NodeJS.ProcessEnv);

    const failedNames = results
      .filter((result) => result.status === "fail")
      .map((result) => result.name)
      .sort();

    expect(failedNames).toEqual(
      [
        "VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS",
        "VISITOR_ANALYTICS_EVENT_RETENTION_DAYS",
        "VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS"
      ].sort()
    );
  });

  test("all pass when every var is set to a valid value", () => {
    const results = checkVisitorAnalyticsConfig({
      VISITOR_ANALYTICS_MODE: "detailed",
      VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS: "300",
      VISITOR_ANALYTICS_EVENT_RETENTION_DAYS: "90",
      VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS: "30",
      VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS: "730"
    } as NodeJS.ProcessEnv);

    expect(results.every((result) => result.status === "pass")).toBe(true);
  });
});

describe("checkNewsMediaR2AllowedMimeTypesKnown (Issue #635)", () => {
  test("passes when disabled", () => {
    const result = checkNewsMediaR2AllowedMimeTypesKnown({
      NEWS_MEDIA_R2_ALLOWED_MIME_TYPES: "text/html"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("pass");
  });

  test("passes for the default allow-list", () => {
    const result = checkNewsMediaR2AllowedMimeTypesKnown({
      NEWS_MEDIA_R2_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("pass");
  });

  test("fails when the allow-list contains a type the MIME sniffer could never recognize", () => {
    const result = checkNewsMediaR2AllowedMimeTypesKnown({
      NEWS_MEDIA_R2_ENABLED: "true",
      NEWS_MEDIA_R2_ALLOWED_MIME_TYPES: "image/jpeg,application/octet-stream"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("application/octet-stream");
  });
});

describe("checkNewsMediaR2PresignedTtlUpperBound (Issue #635)", () => {
  test("passes when disabled", () => {
    const result = checkNewsMediaR2PresignedTtlUpperBound({
      NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS: "999999"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("pass");
  });

  test("passes for the default TTL", () => {
    const result = checkNewsMediaR2PresignedTtlUpperBound({
      NEWS_MEDIA_R2_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("pass");
  });

  test("fails when the TTL exceeds the maximum", () => {
    const result = checkNewsMediaR2PresignedTtlUpperBound({
      NEWS_MEDIA_R2_ENABLED: "true",
      NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS: "7200"
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("7200");
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

  test("passes end-to-end when PUBLIC_TENANT_RESOLUTION_MODE is left unset (offline/LAN default, Issue #556)", () => {
    const env = {
      ...VALID_ENV,
      AWCMS_MINI_SYNC_ENABLED: "false",
      R2_ENABLED: "false",
      EMAIL_ENABLED: "false"
    } as NodeJS.ProcessEnv;

    const results = runEnvValidation(env);
    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("fails end-to-end when PUBLIC_TENANT_RESOLUTION_MODE=host_default is missing PUBLIC_PLATFORM_ROOT_DOMAIN", () => {
    const env = {
      ...VALID_ENV,
      AWCMS_MINI_SYNC_ENABLED: "false",
      R2_ENABLED: "false",
      EMAIL_ENABLED: "false",
      PUBLIC_TENANT_RESOLUTION_MODE: "host_default"
    } as NodeJS.ProcessEnv;

    const results = runEnvValidation(env);
    expect(results.some((result) => result.status === "fail")).toBe(true);
  });

  test("passes end-to-end when TENANT_DOMAIN_DNS_PROVIDER is left unset (manual default, Issue #567)", () => {
    const env = {
      ...VALID_ENV,
      AWCMS_MINI_SYNC_ENABLED: "false",
      R2_ENABLED: "false",
      EMAIL_ENABLED: "false"
    } as NodeJS.ProcessEnv;

    const results = runEnvValidation(env);
    expect(results.every((result) => result.status === "pass")).toBe(true);
  });

  test("fails end-to-end when TENANT_DOMAIN_DNS_PROVIDER=cloudflare is missing its required vars", () => {
    const env = {
      ...VALID_ENV,
      AWCMS_MINI_SYNC_ENABLED: "false",
      R2_ENABLED: "false",
      EMAIL_ENABLED: "false",
      TENANT_DOMAIN_DNS_PROVIDER: "cloudflare"
    } as NodeJS.ProcessEnv;

    const results = runEnvValidation(env);
    expect(results.some((result) => result.status === "fail")).toBe(true);
  });
});
